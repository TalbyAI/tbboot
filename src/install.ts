import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import type {
	Diagnostic,
	LockfileDocument,
	StateDocument,
	StateEffect,
} from "./contract.ts";
import { validateDocument } from "./contract.ts";
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
	exitCode: 0 | 1;
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
	effect: Pick<
		StateEffect,
		"source" | "recipe" | "step" | "type" | "target"
	> & { marker?: string },
): string {
	return JSON.stringify([
		effect.source,
		effect.recipe,
		effect.step,
		effect.type,
		effect.target,
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
	options: {
		dryRun: boolean;
		force: boolean;
		updateLock?: boolean;
		frozenLockfile?: boolean;
	},
): Promise<InstallResult> {
	const lockMode = options.frozenLockfile
		? "frozen"
		: options.updateLock
			? "update"
			: "normal";
	const plan = await planLocalInstall(root, options.force, lockMode);
	const envelope = envelopeFromPlan(plan);
	const state = await readState(plan.consumerRoot, envelope.diagnostics);
	if (
		state === undefined ||
		envelope.diagnostics.some(({ severity }) => severity === "error")
	) {
		return finish(envelope);
	}
	if (options.dryRun) return finish(envelope);
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
	for (const artifact of plan.artifacts) {
		if (artifact.action.state === "drift" && !options.force) continue;
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
		)
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
	return finish(envelope);
}
