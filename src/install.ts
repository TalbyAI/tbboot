import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import type {
	CustomStateEffect,
	Diagnostic,
	LockfileDocument,
	StateDocument,
	StateEffect,
} from "./contract.ts";
import { validateDocument } from "./contract.ts";
import { isCancellation, runPreparedOperation } from "./custom.ts";
import {
	type ArtifactAction,
	type LocalInstallPlan,
	type PlannedArtifact,
	planLocalInstall,
	scanManagedBlock,
} from "./doctor.ts";
import {
	errorMessage,
	finish,
	isNotFound,
	normalizeNewlines,
} from "./shared.ts";

export type InstallEnvelope = {
	schemaVersion: 1;
	command: "install";
	status: "ok" | "warning" | "error";
	changed: boolean;
	actions: ArtifactAction[];
	diagnostics: Diagnostic[];
};

export type InstallResult = {
	envelope: InstallEnvelope;
	exitCode: 0 | 1 | 130;
	stderr?: string;
};

export type InstallOptions = {
	dryRun: boolean;
	force: boolean;
	updateLock?: boolean;
	frozenLockfile?: boolean;
	allowCustom?: string[];
	profileRoot?: string;
	signal?: AbortSignal;
};

export type UninstallEnvelope = {
	schemaVersion: 1;
	command: "uninstall";
	status: "ok" | "warning" | "error";
	changed: boolean;
	actions: ArtifactAction[];
	diagnostics: Diagnostic[];
};

export type UninstallResult = {
	envelope: UninstallEnvelope;
	exitCode: 0 | 1 | 130;
	stderr?: string;
};

export type UninstallOptions = {
	force?: boolean;
	allowCustom?: string[];
	profileRoot?: string;
	signal?: AbortSignal;
};

function envelopeFromPlan(plan: LocalInstallPlan): InstallEnvelope {
	return {
		schemaVersion: 1,
		command: "install",
		status: "ok",
		changed: false,
		actions: plan.actions,
		diagnostics: plan.diagnostics,
	};
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fragmentBlock(input: Buffer, marker: string): Buffer {
	const body = normalizeNewlines(input.toString("utf8"));
	const start = `<!-- managed-by: ${marker} -->`;
	const end = `<!-- end-managed-by: ${marker} -->`;
	return Buffer.from(
		`${start}\n${body}${body.endsWith("\n") ? "" : "\n"}${end}`,
	);
}

function appendFragment(target: Buffer | undefined, block: Buffer): Buffer {
	if (target === undefined || target.length === 0) {
		return Buffer.concat([block, Buffer.from("\n")]);
	}
	const endsWith = (suffix: string): boolean =>
		target.subarray(-Buffer.byteLength(suffix)).equals(Buffer.from(suffix));
	const separator =
		endsWith("\n\n") || endsWith("\r\n\r\n")
			? ""
			: endsWith("\n") || endsWith("\r\n")
				? "\n"
				: "\n\n";
	return Buffer.concat([
		target,
		Buffer.from(separator),
		block,
		Buffer.from("\n"),
	]);
}

function replaceFragment(
	target: Buffer,
	block: Buffer,
	marker: string,
): Buffer {
	const range = scanManagedBlock(target, marker).range;
	if (range === undefined) return target;
	return Buffer.concat([
		target.subarray(0, range.start),
		block,
		target.subarray(range.end),
	]);
}

function stateKey(
	effect: Pick<StateEffect, "source" | "recipe" | "step" | "type"> & {
		target?: string;
		marker?: string;
	},
): string {
	return JSON.stringify([
		effect.source,
		effect.recipe,
		effect.step,
		effect.type,
		"target" in effect ? effect.target : "",
		effect.marker ?? "",
	]);
}

function addDiagnostic(
	diagnostics: Diagnostic[],
	code: string,
	message: string,
	context: Pick<Diagnostic, "source" | "recipe" | "step"> = {},
	severity: Diagnostic["severity"] = "error",
): void {
	diagnostics.push({
		code,
		severity,
		message,
		...(context.source === undefined ? {} : { source: context.source }),
		...(context.recipe === undefined ? {} : { recipe: context.recipe }),
		...(context.step === undefined ? {} : { step: context.step }),
	});
}

async function readState(
	root: string,
	diagnostics: Diagnostic[],
): Promise<StateDocument | undefined> {
	const path = join(root, ".tbboot", "state.yaml");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return { schemaVersion: 1, effects: [] };
		addDiagnostic(
			diagnostics,
			"state-read",
			`Unable to read ${path}: ${errorMessage(error)}`,
		);
		return undefined;
	}
	const result = validateDocument<"state">({
		kind: "state",
		text,
		document: ".tbboot/state.yaml",
	});
	diagnostics.push(...result.diagnostics);
	return result.value;
}

function effectFor(
	artifact: PlannedArtifact,
	consumerRoot: string,
	content: Buffer,
	existing: StateEffect | undefined,
): StateEffect {
	const source = artifact.source;
	const target = relative(consumerRoot, artifact.targetPath)
		.split(sep)
		.join("/");
	if (artifact.type === "file") {
		return {
			source,
			...(artifact.revision === undefined
				? {}
				: { revision: artifact.revision }),
			sourceFingerprint: sha256(artifact.input),
			recipe: artifact.recipe,
			step: artifact.step,
			type: "file",
			target,
			artifactFingerprint: sha256(content),
			created:
				existing?.type === "file" && existing.created
					? true
					: artifact.targetBefore === undefined,
		};
	}
	return {
		source,
		...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
		sourceFingerprint: sha256(artifact.input),
		recipe: artifact.recipe,
		step: artifact.step,
		type: "file-fragment",
		target,
		marker: artifact.marker as string,
		artifactFingerprint: sha256(content),
	};
}

function customEffect(
	step: LocalInstallPlan["customSteps"][number] & {
		prepared: NonNullable<LocalInstallPlan["customSteps"][number]["prepared"]>;
	},
): CustomStateEffect {
	return {
		source: step.source,
		...(step.revision === undefined ? {} : { revision: step.revision }),
		sourceFingerprint: step.prepared.context.sourceFingerprint,
		recipe: step.recipe,
		step: step.step,
		type: "custom",
		uninstallSupported: step.prepared.uninstallSupported,
	};
}

function sameEffect(
	left: StateEffect | undefined,
	right: StateEffect,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function persistState(
	root: string,
	state: StateDocument,
): Promise<boolean> {
	const stateDirectory = join(root, ".tbboot");
	const statePath = join(stateDirectory, "state.yaml");
	const nextState = stringify(state);
	let previousState: string | undefined;
	try {
		previousState = await readFile(statePath, "utf8");
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	await mkdir(stateDirectory, { recursive: true });
	let changed = previousState !== nextState;
	if (changed) await writeFile(statePath, nextState, "utf8");

	const gitignorePath = join(stateDirectory, ".gitignore");
	let gitignore = "";
	try {
		gitignore = await readFile(gitignorePath, "utf8");
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	const entries = gitignore.length === 0 ? [] : gitignore.split(/\r\n|\n|\r/);
	while (entries.at(-1) === "") entries.pop();
	if (!entries.includes("/state.yaml")) {
		entries.push("/state.yaml");
		await writeFile(gitignorePath, `${entries.join("\n")}\n`, "utf8");
		changed = true;
	}
	return changed;
}

async function persistLockfile(
	root: string,
	document: LockfileDocument,
): Promise<boolean> {
	const path = join(root, "tbboot.lock.yaml");
	const next = stringify(document);
	let previous: string | undefined;
	try {
		previous = await readFile(path, "utf8");
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	if (previous === next) return false;
	await writeFile(path, next, "utf8");
	return true;
}

async function applyArtifact(
	artifact: PlannedArtifact,
	force: boolean,
	workingTargets: Map<string, Buffer | undefined>,
): Promise<{ content: Buffer; artifactBytes: Buffer; wrote: boolean }> {
	const current = workingTargets.has(artifact.targetPath)
		? workingTargets.get(artifact.targetPath)
		: artifact.targetBefore;
	let content = current ?? Buffer.alloc(0);
	let artifactBytes = artifact.input;
	if (artifact.type === "file") {
		content = artifact.input;
	} else {
		const block = fragmentBlock(artifact.input, artifact.marker as string);
		artifactBytes = block;
		content =
			artifact.action.state === "drift" && force
				? replaceFragment(current as Buffer, block, artifact.marker as string)
				: artifact.action.state === "satisfied"
					? (current as Buffer)
					: appendFragment(current, block);
	}
	workingTargets.set(artifact.targetPath, content);
	return {
		content,
		artifactBytes,
		wrote: !content.equals(current ?? Buffer.alloc(0)),
	};
}

export async function runInstall(
	root: string,
	options: InstallOptions,
): Promise<InstallResult> {
	const lockMode = options.frozenLockfile
		? "frozen"
		: options.updateLock
			? "update"
			: "normal";
	const plan = await planLocalInstall(root, options.force, lockMode, {
		allowCustom: options.allowCustom,
		profileRoot: options.profileRoot,
		interactive: !options.dryRun && process.stdin.isTTY && process.stdout.isTTY,
	});
	try {
		return await applyInstallPlan(plan, options);
	} finally {
		await plan.cleanup?.();
	}
}

async function applyInstallPlan(
	plan: LocalInstallPlan,
	options: InstallOptions,
): Promise<InstallResult> {
	const envelope = envelopeFromPlan(plan);
	const state = await readState(plan.consumerRoot, envelope.diagnostics);
	if (
		state === undefined ||
		envelope.diagnostics.some(({ severity }) => severity === "error")
	) {
		return finish(envelope);
	}
	if (options.dryRun) {
		for (const custom of plan.customSteps) {
			envelope.diagnostics.push({
				code: "custom-check-deferred",
				severity: "warning",
				message:
					"Custom check and lifecycle actions are deferred during dry-run",
				source: custom.sourceRoot,
				recipe: custom.recipe,
				step: custom.step,
			});
		}
		return finish(envelope);
	}
	if (options.signal?.aborted) {
		return { ...finish(envelope), exitCode: 130 };
	}
	if (plan.lockfile !== undefined && plan.lockfileChanged) {
		try {
			envelope.changed =
				(await persistLockfile(plan.consumerRoot, plan.lockfile)) ||
				envelope.changed;
		} catch (error) {
			addDiagnostic(
				envelope.diagnostics,
				"lockfile-write",
				`Unable to persist tbboot.lock.yaml: ${errorMessage(error)}`,
			);
			return finish(envelope);
		}
	}

	const effects = new Map(
		state.effects.map((effect) => [stateKey(effect), effect]),
	);
	const workingTargets = new Map<string, Buffer | undefined>();
	const artifactsByAction = new Map(
		plan.artifacts.map((artifact) => [artifact.action, artifact]),
	);
	const customByAction = new Map(
		plan.customSteps.map((custom) => [custom.action, custom]),
	);
	let stderr = "";
	let cancelled = false;
	let stopped = false;
	for (const action of plan.actions) {
		if (options.signal?.aborted) {
			cancelled = true;
			break;
		}
		if (stopped) break;
		if (action.type === "custom") {
			const custom = customByAction.get(action);
			if (custom?.prepared === undefined) continue;
			const prepared = custom.prepared;
			const report = (
				status: "missing" | "drift" | "error",
				message: string,
			): boolean => {
				action.state = status;
				envelope.diagnostics.push({
					code:
						status === "missing"
							? "custom-missing"
							: status === "drift"
								? "custom-drift"
								: "custom-error",
					severity: custom.optional ? "warning" : "error",
					message,
					source: custom.sourceRoot,
					recipe: custom.recipe,
					step: custom.step,
				});
				return !custom.optional;
			};
			try {
				const run = async (
					operation: typeof prepared.check,
				): Promise<{ failed: boolean; fatal: boolean }> => {
					const outcome = await runPreparedOperation(
						operation,
						prepared.context,
						options.signal,
					);
					stderr += outcome.stderr;
					if (outcome.result.changed) envelope.changed = true;
					if (outcome.result.status !== "ok") {
						return {
							failed: true,
							fatal: report(
								outcome.result.status,
								outcome.result.message ??
									`Custom ${operation.name} returned ${outcome.result.status}`,
							),
						};
					}
					return { failed: false, fatal: false };
				};
				if (prepared.install !== undefined) {
					const installation = await run(prepared.install);
					if (installation.failed) {
						stopped ||= installation.fatal;
						continue;
					}
				}
				const check = await run(prepared.check);
				if (check.failed) {
					stopped ||= check.fatal;
					continue;
				}
				action.state = "ok";
				const existing = effects.get(
					stateKey({
						source: custom.source,
						recipe: custom.recipe,
						step: custom.step,
						type: "custom",
					}),
				);
				const effect = customEffect({ ...custom, prepared });
				if (!sameEffect(existing, effect)) {
					effects.set(stateKey(effect), effect);
					envelope.changed =
						(await persistState(plan.consumerRoot, {
							schemaVersion: 1,
							effects: [...effects.values()],
						})) || envelope.changed;
				}
			} catch (error) {
				stderr +=
					typeof (error as { stderr?: unknown }).stderr === "string"
						? (error as { stderr: string }).stderr
						: "";
				if (isCancellation(error)) {
					cancelled = true;
					stopped = true;
					envelope.diagnostics.push({
						code: "custom-cancelled",
						severity: "error",
						message: "Custom execution was cancelled",
						source: custom.sourceRoot,
						recipe: custom.recipe,
						step: custom.step,
					});
					continue;
				}
				if (
					report(
						"error",
						error instanceof Error ? error.message : "Custom execution failed",
					)
				)
					stopped = true;
			}
			continue;
		}
		const artifact = artifactsByAction.get(action);
		if (
			artifact === undefined ||
			(artifact.action.state === "drift" && !options.force)
		)
			continue;
		try {
			const existing = effects.get(
				stateKey({
					source: artifact.source,
					recipe: artifact.recipe,
					step: artifact.step,
					type: artifact.type,
					target: relative(plan.consumerRoot, artifact.targetPath)
						.split(sep)
						.join("/"),
					...(artifact.marker === undefined ? {} : { marker: artifact.marker }),
				}),
			);
			const { content, artifactBytes, wrote } = await applyArtifact(
				artifact,
				options.force,
				workingTargets,
			);
			if (wrote) {
				await mkdir(dirname(artifact.targetPath), { recursive: true });
				await writeFile(artifact.targetPath, content);
				envelope.changed = true;
			}
			const effect = effectFor(
				artifact,
				plan.consumerRoot,
				artifactBytes,
				existing,
			);
			if (!sameEffect(existing, effect)) {
				effects.set(stateKey(effect), effect);
				envelope.changed =
					(await persistState(plan.consumerRoot, {
						schemaVersion: 1,
						effects: [...effects.values()],
					})) || envelope.changed;
			}
		} catch (error) {
			addDiagnostic(
				envelope.diagnostics,
				"install-write",
				`Unable to apply ${artifact.type} target: ${errorMessage(error)}`,
				{
					source: artifact.sourceRoot,
					recipe: artifact.recipe,
					step: artifact.step,
				},
				artifact.optional ? "warning" : "error",
			);
			if (!artifact.optional) break;
		}
	}
	if (
		plan.artifacts.some(
			({ action }) => action.state !== "drift" || options.force,
		) ||
		plan.customSteps.some(({ action }) => action.state === "ok")
	) {
		try {
			envelope.changed =
				(await persistState(plan.consumerRoot, {
					schemaVersion: 1,
					effects: [...effects.values()],
				})) || envelope.changed;
		} catch (error) {
			addDiagnostic(
				envelope.diagnostics,
				"install-write",
				`Unable to persist Installation record: ${errorMessage(error)}`,
			);
		}
	}
	const result = finish(envelope);
	return {
		...result,
		...(stderr === "" ? {} : { stderr }),
		exitCode: cancelled ? 130 : result.exitCode,
	};
}

export async function runUninstall(
	root: string,
	options: UninstallOptions,
): Promise<UninstallResult> {
	const plan = await planLocalInstall(
		root,
		true,
		"none",
		{
			allowCustom: options.allowCustom,
			profileRoot: options.profileRoot,
			interactive: process.stdin.isTTY && process.stdout.isTTY,
		},
		"uninstall",
	);
	try {
		return await applyUninstallPlan(plan, options);
	} finally {
		await plan.cleanup?.();
	}
}

async function applyUninstallPlan(
	plan: LocalInstallPlan,
	options: UninstallOptions,
): Promise<UninstallResult> {
	const envelope: UninstallEnvelope = {
		schemaVersion: 1,
		command: "uninstall",
		status: "ok",
		changed: false,
		actions: plan.actions.filter(({ type }) => type === "custom"),
		diagnostics: plan.diagnostics,
	};
	const state = await readState(plan.consumerRoot, envelope.diagnostics);
	if (
		state === undefined ||
		envelope.diagnostics.some(({ severity }) => severity === "error")
	)
		return finish(envelope);
	if (options.signal?.aborted) {
		return { ...finish(envelope), exitCode: 130 };
	}
	const effects = new Map(
		state.effects.map((effect) => [stateKey(effect), effect]),
	);
	for (const effect of state.effects) {
		if (effect.type === "custom") continue;
		envelope.diagnostics.push({
			code: "uninstall-unsupported",
			severity: "warning",
			message: `Uninstall does not remove ${effect.type} effects; the effect was preserved`,
		});
	}
	const customByKey = new Map(
		plan.customSteps.map((custom) => [
			stateKey({
				source: custom.source,
				recipe: custom.recipe,
				step: custom.step,
				type: "custom",
			}),
			custom,
		]),
	);
	let stderr = "";
	let cancelled = false;
	for (const effect of [...state.effects].reverse()) {
		if (effect.type !== "custom") continue;
		const custom = customByKey.get(stateKey(effect));
		if (custom === undefined) continue;
		if (
			custom.prepared === undefined ||
			custom.prepared.uninstall === undefined
		) {
			envelope.diagnostics.push({
				code: "uninstall-unsupported",
				severity: "warning",
				message: "Custom step does not declare an uninstall operation",
				source: custom.sourceRoot,
				recipe: custom.recipe,
				step: custom.step,
			});
			continue;
		}
		try {
			const outcome = await runPreparedOperation(
				custom.prepared.uninstall,
				custom.prepared.context,
				options.signal,
			);
			stderr += outcome.stderr;
			if (outcome.result.changed) envelope.changed = true;
			custom.action.state =
				outcome.result.status === "ok" ? "ok" : outcome.result.status;
			if (outcome.result.status === "ok") {
				effects.delete(stateKey(effect));
				envelope.changed =
					(await persistState(plan.consumerRoot, {
						schemaVersion: 1,
						effects: [...effects.values()],
					})) || envelope.changed;
				continue;
			}
			envelope.diagnostics.push({
				code:
					outcome.result.status === "missing"
						? "custom-missing"
						: outcome.result.status === "drift"
							? "custom-drift"
							: "custom-error",
				severity: custom.optional ? "warning" : "error",
				message:
					outcome.result.message ??
					`Custom uninstall returned ${outcome.result.status}`,
				source: custom.sourceRoot,
				recipe: custom.recipe,
				step: custom.step,
			});
			if (!custom.optional) break;
		} catch (error) {
			stderr +=
				typeof (error as { stderr?: unknown }).stderr === "string"
					? (error as { stderr: string }).stderr
					: "";
			if (isCancellation(error)) {
				cancelled = true;
				envelope.diagnostics.push({
					code: "custom-cancelled",
					severity: "error",
					message: "Custom uninstall was cancelled",
					source: custom.sourceRoot,
					recipe: custom.recipe,
					step: custom.step,
				});
				break;
			}
			envelope.diagnostics.push({
				code: "custom-error",
				severity: custom.optional ? "warning" : "error",
				message:
					error instanceof Error ? error.message : "Custom uninstall failed",
				source: custom.sourceRoot,
				recipe: custom.recipe,
				step: custom.step,
			});
			if (!custom.optional) break;
		}
	}
	const result = finish(envelope);
	return {
		...result,
		...(stderr === "" ? {} : { stderr }),
		exitCode: cancelled ? 130 : result.exitCode,
	};
}
