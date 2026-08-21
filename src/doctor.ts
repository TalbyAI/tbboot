import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
	Diagnostic,
	DocumentKind,
	LockEntry,
	LockfileDocument,
	ManifestDocument,
	RecipeDocument,
	SourceDependency,
	SourceDocument,
	SourceReference,
	Step,
} from "./contract.ts";
import { validateDocument } from "./contract.ts";
import {
	type CustomAuthorizationOptions,
	sourceFingerprint as calculateSourceFingerprint,
	customDiagnosticCode,
	isCancellation,
	type PreparedCustomStep,
	prepareCustomStep,
	runPreparedOperation,
} from "./custom.ts";
import {
	GitSourceError,
	isGitRevisionAllowed,
	materializeGitSource,
	normalizeGitPath,
	normalizeGitRepository,
	resolveGitHead,
	resolveGitSelector,
} from "./git.ts";
import {
	errorMessage,
	finish,
	isInside,
	isNotFound,
	normalizeNewlines,
} from "./shared.ts";

type SupportedDocumentKind = Extract<
	DocumentKind,
	"manifest" | "source" | "recipe"
>;
type DiagnosticContext = Pick<
	Diagnostic,
	"document" | "path" | "source" | "recipe" | "step"
>;
export type ArtifactType = Exclude<Step["type"], "custom">;
export type ArtifactState = "satisfied" | "missing" | "drift" | "conflict";
export type ActionState =
	| ArtifactState
	| "deferred"
	| "ok"
	| "error"
	| "removed"
	| "already-absent"
	| "preserved-preexisting"
	| "unsupported"
	| "blocked"
	| "failed";

export type ArtifactAction = {
	source: string;
	recipe: string;
	step: number;
	type: Step["type"];
	target?: string;
	state: ActionState;
};

export type PlannedArtifact = {
	source: SourceReference;
	sourceRoot: string;
	revision?: string;
	recipe: string;
	step: number;
	type: ArtifactType;
	marker?: string;
	input: Buffer;
	targetPath: string;
	targetBefore?: Buffer;
	optional: boolean;
	action: ArtifactAction;
};

export type PlannedCustomStep = {
	source: SourceReference;
	sourceRoot: string;
	revision?: string;
	recipe: string;
	step: number;
	optional: boolean;
	uninstallUnsupported?: boolean;
	prepared?: PreparedCustomStep;
	action: ArtifactAction;
};

export type LocalInstallPlan = {
	consumerRoot: string;
	actions: ArtifactAction[];
	diagnostics: Diagnostic[];
	artifacts: PlannedArtifact[];
	customSteps: PlannedCustomStep[];
	lockfile?: LockfileDocument;
	lockfileChanged: boolean;
	cleanup?: () => Promise<void>;
};

export type DoctorEnvelope = {
	schemaVersion: 1;
	command: "doctor";
	status: "ok" | "warning" | "error";
	changed: false;
	actions: ArtifactAction[];
	diagnostics: Diagnostic[];
	consumerRoot?: string;
};

export type DoctorResult = {
	envelope: DoctorEnvelope;
	exitCode: 0 | 1 | 130;
	stderr?: string;
};

type PathResolution =
	| { path: string; escape: false }
	| { escape: true }
	| { error: unknown };

type StepDescriptor = {
	sourceReference: SourceReference;
	source: string;
	sourceLabel?: string;
	revision?: string;
	recipe: string;
	step: number;
	type: Step["type"];
	input?: string;
	target?: string;
	optional: boolean;
	recipeRoot: string;
	uninstallUnsupported?: boolean;
	preparedCustom?: PreparedCustomStep;
	inputPath?: PathResolution;
	targetPath?: PathResolution;
	marker?: string;
	collision?: boolean;
	inputBytes?: Buffer;
	targetBefore?: Buffer;
	action: ArtifactAction;
};

type FragmentResult =
	| { state: "satisfied"; code?: undefined }
	| { state: "missing" | "drift" | "conflict"; code: string };

const documentPaths = {
	manifest: "tbboot.yaml",
	source: "source.yaml",
	recipe: "recipe.yaml",
} satisfies Record<SupportedDocumentKind, string>;

function diagnostic(
	code: string,
	message: string,
	context: DiagnosticContext = {},
	severity: Diagnostic["severity"] = "error",
): Diagnostic {
	return {
		code,
		severity,
		message,
		...(context.document === undefined ? {} : { document: context.document }),
		...(context.path === undefined ? {} : { path: context.path }),
		...(context.source === undefined ? {} : { source: context.source }),
		...(context.recipe === undefined ? {} : { recipe: context.recipe }),
		...(context.step === undefined ? {} : { step: context.step }),
	};
}

async function realPathWithMissing(candidate: string): Promise<string> {
	const missing: string[] = [];
	let current = candidate;
	while (true) {
		try {
			const existing = await realpath(current);
			return join(existing, ...missing.reverse());
		} catch (error) {
			if (!isNotFound(error)) throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			missing.push(basename(current));
			current = parent;
		}
	}
}

async function resolveContained(
	root: string,
	base: string,
	value: string,
): Promise<PathResolution> {
	const logical = resolve(base, value);
	if (!isInside(root, logical)) return { escape: true };
	try {
		const canonical = await realPathWithMissing(logical);
		if (!isInside(root, canonical)) return { escape: true };
		return { path: canonical, escape: false };
	} catch (error) {
		return { error };
	}
}

function contextFor(
	descriptor: StepDescriptor,
	path: string,
): DiagnosticContext {
	return {
		document: documentPaths.recipe,
		path,
		source: descriptor.source,
		recipe: descriptor.recipe,
		step: descriptor.step,
	};
}

function stepPath(step: number, field: "input" | "target"): string {
	return `/steps/${step - 1}/${field}`;
}

function stepSeverity(descriptor: StepDescriptor): Diagnostic["severity"] {
	return descriptor.optional ? "warning" : "error";
}

function addStepDiagnostic(
	envelope: DoctorEnvelope,
	descriptor: StepDescriptor,
	code: string,
	message: string,
	field: "input" | "target",
	fatal = false,
): void {
	envelope.diagnostics.push(
		diagnostic(
			code,
			message,
			contextFor(descriptor, stepPath(descriptor.step, field)),
			fatal ? "error" : stepSeverity(descriptor),
		),
	);
}

function artifactAction(descriptor: {
	source: string;
	recipe: string;
	step: number;
	type: ArtifactType;
	target: string;
}): ArtifactAction {
	return {
		source: descriptor.source,
		recipe: descriptor.recipe,
		step: descriptor.step,
		type: descriptor.type,
		target: descriptor.target as string,
		state: "conflict",
	};
}

function customAction(
	descriptor: Pick<StepDescriptor, "source" | "recipe" | "step">,
): ArtifactAction {
	return {
		source: descriptor.source,
		recipe: descriptor.recipe,
		step: descriptor.step,
		type: "custom",
		state: "deferred",
	};
}

function sourceDisplay(reference: SourceReference, sourceRoot: string): string {
	if (reference.provider === "local") return sourceRoot;
	return `${reference.locator.repository}${reference.locator.path === undefined ? "" : `/${reference.locator.path}`}`;
}

function sourceLabel(reference: SourceReference, sourceRoot: string): string {
	if (reference.provider === "local") return basename(sourceRoot);
	const value = reference.locator.path ?? reference.locator.repository;
	return basename(value.replaceAll("\\", "/")) || value;
}

const caseInsensitiveFs = process.platform === "win32";

function pathKey(value: string): string {
	const normalized = value.replaceAll("/", sep);
	return caseInsensitiveFs ? normalized.toLowerCase() : normalized;
}

function isPathEscape(resolution: PathResolution | undefined): boolean {
	return (
		resolution !== undefined && "escape" in resolution && resolution.escape
	);
}

function hasPathError(resolution: PathResolution | undefined): boolean {
	return resolution !== undefined && "error" in resolution;
}

function resolvedPath(
	resolution: PathResolution | undefined,
): string | undefined {
	return resolution !== undefined && "path" in resolution
		? resolution.path
		: undefined;
}

async function resolveLocalSource(
	root: string,
	locator: string,
	context: DiagnosticContext,
	envelope: DoctorEnvelope,
): Promise<string | undefined> {
	const candidate = resolve(root, locator);
	try {
		const sourceRoot = await realpath(candidate);
		if (!(await stat(sourceRoot)).isDirectory())
			throw new Error("Source path is not a directory");
		return sourceRoot;
	} catch (error) {
		envelope.diagnostics.push(
			diagnostic(
				"source-read",
				`Unable to read local Source: ${errorMessage(error)}`,
				context,
			),
		);
		return undefined;
	}
}

async function readSourceDocument(
	sourceRoot: string,
	envelope: DoctorEnvelope,
): Promise<SourceDocument | undefined> {
	let sourceText: string;
	try {
		sourceText = await readFile(join(sourceRoot, documentPaths.source), "utf8");
	} catch (error) {
		envelope.diagnostics.push(
			diagnostic(
				"source-read",
				`Unable to read source.yaml: ${errorMessage(error)}`,
				{ document: documentPaths.source, source: sourceRoot },
			),
		);
		return undefined;
	}

	const result = validateDocument<"source">({
		kind: "source",
		text: sourceText,
		document: documentPaths.source,
		source: sourceRoot,
	});
	envelope.diagnostics.push(...result.diagnostics);
	return result.value;
}

async function collectSourceSteps(
	sourceRoot: string,
	sourceReference: SourceReference,
	descriptors: StepDescriptor[],
	envelope: DoctorEnvelope,
	metadata: {
		mode?: "doctor" | "install" | "uninstall";
		revision?: string;
		sourceFingerprint?: string;
		customAuthorization?: CustomAuthorizationOptions;
	} = {},
	sourceDocument?: SourceDocument,
): Promise<void> {
	const document =
		sourceDocument ?? (await readSourceDocument(sourceRoot, envelope));
	if (document === undefined) return;

	let entries: Dirent[];
	try {
		entries = await readdir(sourceRoot, { withFileTypes: true });
	} catch (error) {
		envelope.diagnostics.push(
			diagnostic(
				"source-read",
				`Unable to discover Recipes: ${errorMessage(error)}`,
				{ document: documentPaths.source, source: sourceRoot },
			),
		);
		return;
	}

	const recipes = entries
		.filter((entry) => entry.isDirectory())
		.sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);

	for (const entry of recipes) {
		const recipe = entry.name;
		const recipeFile = join(sourceRoot, recipe, documentPaths.recipe);
		let recipeText: string;
		try {
			recipeText = await readFile(recipeFile, "utf8");
		} catch (error) {
			if (isNotFound(error)) continue;
			envelope.diagnostics.push(
				diagnostic(
					"recipe-read",
					`Unable to read recipe.yaml: ${errorMessage(error)}`,
					{ document: documentPaths.recipe, source: sourceRoot, recipe },
				),
			);
			continue;
		}

		const recipeResult = validateDocument<"recipe">({
			kind: "recipe",
			text: recipeText,
			document: documentPaths.recipe,
			source: sourceRoot,
			recipe,
		});
		envelope.diagnostics.push(...recipeResult.diagnostics);
		if (recipeResult.value === undefined) continue;

		const recipeDocument: RecipeDocument = recipeResult.value;
		for (const [index, step] of recipeDocument.steps.entries()) {
			const stepNumber = index + 1;
			if (step.type === "custom") {
				const descriptor: StepDescriptor = {
					sourceReference,
					source: sourceRoot,
					sourceLabel: sourceLabel(sourceReference, sourceRoot),
					revision: metadata.revision,
					recipe,
					step: stepNumber,
					type: "custom",
					optional: step.optional === true,
					recipeRoot: join(sourceRoot, recipe),
					action: customAction({
						source: sourceDisplay(sourceReference, sourceRoot),
						recipe,
						step: stepNumber,
					}),
				};
				if (metadata.mode === "uninstall" && step.uninstall === undefined) {
					descriptor.uninstallUnsupported = true;
					descriptors.push(descriptor);
					continue;
				}
				try {
					const fingerprint =
						metadata.sourceFingerprint ??
						metadata.revision ??
						(await calculateSourceFingerprint(sourceRoot));
					descriptor.preparedCustom = await prepareCustomStep(
						step,
						{
							consumerRoot: envelope.consumerRoot as string,
							sourceRoot,
							recipeRoot: descriptor.recipeRoot,
							recipe,
							step: stepNumber,
							source: sourceReference,
							revision: metadata.revision,
							sourceFingerprint: fingerprint,
						},
						metadata.customAuthorization,
						metadata.mode === "uninstall" ? ["uninstall"] : undefined,
					);
				} catch (error) {
					const code = customDiagnosticCode(error);
					const fatal = [
						"custom-script-invalid",
						"custom-script-escape",
						"trust-invalid",
						"trust-read",
						"trust-write",
					].includes(code);
					descriptor.action.state =
						code === "custom-authorization-required" && step.optional === true
							? "deferred"
							: "error";
					envelope.diagnostics.push(
						diagnostic(
							code,
							error instanceof Error
								? error.message
								: "Unable to prepare Custom step",
							{
								document: documentPaths.recipe,
								path: `/steps/${index}`,
								source: sourceRoot,
								recipe,
								step: stepNumber,
							},
							fatal ? "error" : step.optional === true ? "warning" : "error",
						),
					);
				}
				descriptors.push(descriptor);
				continue;
			}

			const descriptor: StepDescriptor = {
				sourceReference,
				source: sourceRoot,
				sourceLabel: sourceLabel(sourceReference, sourceRoot),
				revision: metadata.revision,
				recipe,
				step: stepNumber,
				type: step.type,
				input: step.input,
				target: step.target,
				optional: step.optional === true,
				recipeRoot: join(sourceRoot, recipe),
				action: artifactAction({
					source: sourceDisplay(sourceReference, sourceRoot),
					recipe,
					step: stepNumber,
					type: step.type,
					target: step.target,
				}),
			};
			descriptor.inputPath = await resolveContained(
				sourceRoot,
				descriptor.recipeRoot,
				step.input,
			);
			const consumerRoot = envelope.consumerRoot as string;
			descriptor.targetPath = await resolveContained(
				consumerRoot,
				consumerRoot,
				step.target,
			);
			descriptors.push(descriptor);
		}
	}
}

function registerCollisions(
	descriptors: StepDescriptor[],
	envelope: DoctorEnvelope,
): void {
	const targetWriters = new Map<string, StepDescriptor[]>();
	const markerWriters = new Map<string, StepDescriptor[]>();
	for (const descriptor of descriptors) {
		const targetPath = resolvedPath(descriptor.targetPath);
		if (
			targetPath !== undefined &&
			!isPathEscape(descriptor.targetPath) &&
			!hasPathError(descriptor.targetPath)
		) {
			const key = pathKey(targetPath);
			const group = targetWriters.get(key) ?? [];
			group.push(descriptor);
			targetWriters.set(key, group);
		}
		if (descriptor.type === "file-fragment") {
			descriptor.marker = `${descriptor.sourceLabel ?? basename(descriptor.source)}/${descriptor.recipe}`;
			const group = markerWriters.get(descriptor.marker) ?? [];
			group.push(descriptor);
			markerWriters.set(descriptor.marker, group);
		}
	}

	for (const group of targetWriters.values()) {
		if (group.length <= 1 || !group.some(({ type }) => type === "file"))
			continue;
		for (const descriptor of group) {
			descriptor.collision = true;
			descriptor.action.state = "conflict";
			addStepDiagnostic(
				envelope,
				descriptor,
				"file-target-collision",
				"Multiple writing Steps target the same file",
				"target",
				true,
			);
		}
	}

	for (const group of markerWriters.values()) {
		if (group.length <= 1) continue;
		for (const descriptor of group) {
			descriptor.collision = true;
			descriptor.action.state = "conflict";
			addStepDiagnostic(
				envelope,
				descriptor,
				"fragment-marker-collision",
				"Multiple File Fragment Steps use the same managed marker",
				"target",
				true,
			);
		}
	}
}

type ManagedBlockScan = {
	starts: number[];
	ends: number[];
	range?: { start: number; end: number };
};

export type ManagedBlockInspection =
	| { state: "missing" }
	| { state: "present"; range: { start: number; end: number } }
	| {
			state: "conflict";
			code: "fragment-marker-collision" | "incomplete-fragment";
	  };

function exactMarkerOffsets(
	bytes: Buffer,
	token: Buffer,
	requireTerminator: boolean,
): number[] {
	const positions: number[] = [];
	let lineStart = 0;
	while (lineStart <= bytes.length) {
		let lineEnd = lineStart;
		while (
			lineEnd < bytes.length &&
			bytes[lineEnd] !== 0x0a &&
			bytes[lineEnd] !== 0x0d
		)
			lineEnd += 1;
		const hasTerminator = lineEnd < bytes.length;
		if (
			bytes.subarray(lineStart, lineEnd).equals(token) &&
			(!requireTerminator || hasTerminator)
		)
			positions.push(lineStart);
		if (!hasTerminator) break;
		lineStart = lineEnd + 1;
		if (bytes[lineEnd] === 0x0d && bytes[lineStart] === 0x0a) lineStart += 1;
	}
	return positions;
}

export function scanManagedBlock(
	bytes: Buffer,
	marker: string,
): ManagedBlockScan {
	const start = Buffer.from(`<!-- managed-by: ${marker} -->`);
	const end = Buffer.from(`<!-- end-managed-by: ${marker} -->`);
	const starts = exactMarkerOffsets(bytes, start, true);
	const ends = exactMarkerOffsets(bytes, end, false);
	return {
		starts,
		ends,
		range:
			starts.length === 1 && ends.length === 1 && ends[0] > starts[0]
				? { start: starts[0], end: ends[0] + end.length }
				: undefined,
	};
}

export function inspectManagedBlock(
	bytes: Buffer,
	marker: string,
): ManagedBlockInspection {
	const markerScan = scanManagedBlock(bytes, marker);
	const text = normalizeNewlines(bytes.toString("utf8"));
	const lines = text.split("\n");
	const start = `<!-- managed-by: ${marker} -->`;
	const end = `<!-- end-managed-by: ${marker} -->`;
	const managed = new Map<string, { starts: number; ends: number }>();
	const markerStack: string[] = [];
	let nestedMarker = false;
	let mismatchedMarker = false;
	for (const line of lines) {
		const startMatch = /^<!-- managed-by: (.+) -->$/.exec(line);
		const endMatch = /^<!-- end-managed-by: (.+) -->$/.exec(line);
		const markerMatch = startMatch ?? endMatch;
		if (markerMatch) {
			const name = markerMatch[1];
			const entry = managed.get(name) ?? { starts: 0, ends: 0 };
			if (startMatch) entry.starts += 1;
			else entry.ends += 1;
			managed.set(name, entry);
			if (startMatch) {
				if (markerStack.length > 0) nestedMarker = true;
				markerStack.push(name);
			} else if (markerStack.pop() !== name) {
				mismatchedMarker = true;
			}
		}
	}
	const malformedMarkerLine = lines.some((line, index) => {
		const ownStartPrefix = line.startsWith(start);
		const ownEndPrefix = line.startsWith(end);
		const genericPrefix =
			line.startsWith("<!-- managed-by: ") ||
			line.startsWith("<!-- end-managed-by: ");
		const completeManagedLine =
			/^<!-- managed-by: .+ -->$/.test(line) ||
			/^<!-- end-managed-by: .+ -->$/.test(line);
		return (
			(ownStartPrefix && (line !== start || index === lines.length - 1)) ||
			(ownEndPrefix && line !== end) ||
			(genericPrefix && !completeManagedLine)
		);
	});
	const hasUnmatchedDistinctMarker = [...managed.entries()]
		.filter(([name]) => name !== marker)
		.some(([, counts]) => counts.starts > 0 !== counts.ends > 0);
	if (markerScan.starts.length > 1 || markerScan.ends.length > 1)
		return { state: "conflict", code: "fragment-marker-collision" };
	if (
		malformedMarkerLine ||
		hasUnmatchedDistinctMarker ||
		nestedMarker ||
		mismatchedMarker ||
		markerStack.length > 0 ||
		(markerScan.starts.length === 1) !== (markerScan.ends.length === 1)
	)
		return { state: "conflict", code: "incomplete-fragment" };
	if (markerScan.starts.length === 0) return { state: "missing" };
	if (markerScan.range === undefined)
		return { state: "conflict", code: "incomplete-fragment" };
	return { state: "present", range: markerScan.range };
}

function fragmentState(
	targetText: string,
	inputText: string,
	marker: string,
): FragmentResult {
	const text = normalizeNewlines(targetText);
	const body = normalizeNewlines(inputText);
	const start = `<!-- managed-by: ${marker} -->`;
	const end = `<!-- end-managed-by: ${marker} -->`;
	const expected = `${start}\n${body}${body.endsWith("\n") ? "" : "\n"}${end}`;
	const targetBytes = Buffer.from(text);
	const inspection = inspectManagedBlock(targetBytes, marker);
	if (inspection.state === "conflict")
		return { state: "conflict", code: inspection.code };
	if (inspection.state === "missing")
		return { state: "missing", code: "fragment-missing" };
	const range = inspection.range;
	const actual = targetBytes.subarray(range.start, range.end).toString("utf8");
	return actual === expected
		? { state: "satisfied" }
		: { state: "drift", code: "fragment-drift" };
}

async function evaluateDescriptor(
	descriptor: StepDescriptor,
	envelope: DoctorEnvelope,
	mode: "doctor" | "install" | "uninstall",
	force: boolean,
): Promise<void> {
	if (descriptor.collision) return;
	if (descriptor.type === "custom" || mode === "uninstall") return;

	if (isPathEscape(descriptor.inputPath)) {
		addStepDiagnostic(
			envelope,
			descriptor,
			"source-input-escape",
			"Source input escapes the canonical Source root",
			"input",
			true,
		);
		return;
	}
	const inputPath = resolvedPath(descriptor.inputPath);
	if (hasPathError(descriptor.inputPath) || inputPath === undefined) {
		addStepDiagnostic(
			envelope,
			descriptor,
			"source-input-missing",
			"Source input is not readable",
			"input",
		);
		return;
	}

	let input: Buffer;
	try {
		input = await readFile(inputPath);
	} catch {
		addStepDiagnostic(
			envelope,
			descriptor,
			"source-input-missing",
			"Source input is not readable",
			"input",
		);
		return;
	}
	descriptor.inputBytes = input;

	if (isPathEscape(descriptor.targetPath)) {
		addStepDiagnostic(
			envelope,
			descriptor,
			"target-escape",
			"Target escapes the canonical Consumer repository root",
			"target",
			true,
		);
		return;
	}
	const targetPath = resolvedPath(descriptor.targetPath);
	if (hasPathError(descriptor.targetPath) || targetPath === undefined) {
		descriptor.action.state = "conflict";
		addStepDiagnostic(
			envelope,
			descriptor,
			"target-read",
			"Target is not readable",
			"target",
		);
		return;
	}

	let target: Buffer;
	try {
		target = await readFile(targetPath);
	} catch (error) {
		if (isNotFound(error)) {
			descriptor.action.state = "missing";
			if (mode === "doctor") {
				addStepDiagnostic(
					envelope,
					descriptor,
					descriptor.type === "file" ? "file-missing" : "fragment-missing",
					"Target is missing",
					"target",
				);
			}
			return;
		}
		descriptor.action.state = "conflict";
		addStepDiagnostic(
			envelope,
			descriptor,
			"target-read",
			`Unable to read target: ${errorMessage(error)}`,
			"target",
		);
		return;
	}
	descriptor.targetBefore = target;

	if (descriptor.type === "file") {
		descriptor.action.state = Buffer.from(input).equals(target)
			? "satisfied"
			: "drift";
		if (descriptor.action.state === "drift" && !(mode === "install" && force)) {
			addStepDiagnostic(
				envelope,
				descriptor,
				"file-drift",
				"Target bytes differ from Source input",
				"target",
			);
		}
		return;
	}

	const result = fragmentState(
		target.toString("utf8"),
		input.toString("utf8"),
		descriptor.marker as string,
	);
	descriptor.action.state = result.state;
	const reportFragmentState =
		result.code !== undefined &&
		(mode === "doctor" ||
			(result.code !== "fragment-missing" &&
				!(force && result.code === "fragment-drift")));
	if (reportFragmentState) {
		addStepDiagnostic(
			envelope,
			descriptor,
			result.code,
			result.code === "fragment-drift"
				? "Managed fragment differs from Source input"
				: result.code === "fragment-missing"
					? "Managed fragment is missing"
					: result.code === "fragment-marker-collision"
						? "Managed fragment marker appears more than once"
						: "Managed fragment markers are incomplete or mismatched",
			"target",
			result.code === "fragment-marker-collision" ||
				result.code === "incomplete-fragment",
		);
	}
}

type BuiltLocalPlan = {
	envelope: DoctorEnvelope;
	descriptors: StepDescriptor[];
	consumerRoot?: string;
	lockfile?: LockfileDocument;
	lockfileChanged: boolean;
	cleanup?: () => Promise<void>;
};

export type LockMode = "none" | "normal" | "update" | "frozen";

type SourceDeclaration = {
	reference: SourceReference;
	document: string;
	path: string;
	selectorPath?: string;
	scope: string;
	source?: string;
	lockPath?: string;
};

type ResolvedSource = {
	reference: SourceReference;
	references: SourceReference[];
	sourceRoot?: string;
	repositoryRoot?: string;
	identity: string;
	revision?: string;
	fingerprint?: string;
	cleanup?: () => Promise<void>;
	dependencies: ResolvedSource[];
	declarations: SourceDeclaration[];
	sourceDocument?: SourceDocument;
	expandedRevision?: string;
	invalid?: boolean;
};

function gitIdentity(root: string, reference: SourceReference): string {
	if (reference.provider !== "git") return `local:${pathKey(root)}`;
	return `git:${pathKey(root)}|${normalizeGitPath(reference.locator.path) ?? ""}`;
}

function gitDiagnostic(
	error: unknown,
	declaration: SourceDeclaration,
): Diagnostic {
	const code =
		error instanceof GitSourceError ? error.code : "git-repository-read";
	const message =
		error instanceof Error
			? error.message
			: `Unable to resolve Git Source: ${String(error)}`;
	return diagnostic(code, message, {
		document: declaration.document,
		path: declaration.selectorPath ?? declaration.path,
		source:
			declaration.reference.provider === "git"
				? declaration.reference.locator.repository
				: declaration.source,
	});
}

async function readLockfile(
	root: string,
	envelope: DoctorEnvelope,
): Promise<{ document: LockfileDocument; exists: boolean; valid: boolean }> {
	const path = join(root, "tbboot.lock.yaml");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) {
			return {
				document: { schemaVersion: 1, sources: [] },
				exists: false,
				valid: true,
			};
		}
		envelope.diagnostics.push(
			diagnostic(
				"lockfile-read",
				`Unable to read ${path}: ${errorMessage(error)}`,
				{
					document: "tbboot.lock.yaml",
				},
			),
		);
		return {
			document: { schemaVersion: 1, sources: [] },
			exists: true,
			valid: false,
		};
	}
	const result = validateDocument<"lockfile">({
		kind: "lockfile",
		text,
		document: "tbboot.lock.yaml",
	});
	if (result.value === undefined) {
		envelope.diagnostics.push(
			...result.diagnostics.map((entry) => ({
				...entry,
				code:
					entry.code === "yaml-parse-error" ||
					entry.code === "schema-version-missing" ||
					entry.code === "schema-validation-failed"
						? "lockfile-invalid"
						: entry.code,
			})),
		);
		return {
			document: { schemaVersion: 1, sources: [] },
			exists: true,
			valid: false,
		};
	}
	return { document: result.value, exists: true, valid: true };
}

function sameSelector(left: unknown, right: unknown): boolean {
	const isEmptySelector = (value: unknown): boolean =>
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0;
	const other = left === undefined ? right : left;
	const leftEmpty = left === undefined || isEmptySelector(left);
	const rightEmpty = right === undefined || isEmptySelector(right);
	if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty;
	if (
		typeof other !== "object" ||
		other === null ||
		typeof right !== "object" ||
		right === null
	)
		return false;
	const leftSelector = other as Record<string, unknown>;
	const rightSelector = right as Record<string, unknown>;
	if ("ref" in leftSelector || "ref" in rightSelector) {
		return (
			"ref" in leftSelector &&
			"ref" in rightSelector &&
			leftSelector.ref === rightSelector.ref
		);
	}
	return (
		"from" in leftSelector &&
		"from" in rightSelector &&
		"to" in leftSelector &&
		"to" in rightSelector &&
		leftSelector.from === rightSelector.from &&
		leftSelector.to === rightSelector.to
	);
}

function isGitLockEntry(
	entry: LockEntry,
): entry is Extract<LockEntry, { source: { provider: "git" } }> {
	return entry.source.provider === "git";
}

async function lockIdentity(
	root: string,
	reference: Extract<SourceReference, { provider: "git" }>,
): Promise<string> {
	const repository = normalizeGitRepository(root, reference.locator.repository);
	const canonicalRepository = await realpath(repository).catch(
		() => repository,
	);
	return gitIdentity(canonicalRepository, reference);
}

async function replaceLockEntry(
	root: string,
	entries: LockEntry[],
	entry: LockEntry,
): Promise<LockEntry[]> {
	const result: LockEntry[] = [];
	for (const existing of entries) {
		const sameSource =
			existing.source.provider === entry.source.provider &&
			(existing.source.provider === "git" && entry.source.provider === "git"
				? (await lockIdentity(root, existing.source)) ===
					(await lockIdentity(root, entry.source))
				: JSON.stringify(existing.source.locator) ===
					JSON.stringify(entry.source.locator));
		if (!sameSource) result.push(existing);
	}
	result.push(entry);
	return result;
}

function lockDiagnostic(
	code: string,
	message: string,
	declaration: SourceDeclaration,
): Diagnostic {
	return diagnostic(code, message, {
		document: "tbboot.lock.yaml",
		path: declaration.lockPath ?? declaration.path,
		source:
			declaration.reference.provider === "git"
				? declaration.reference.locator.repository
				: declaration.source,
	});
}

async function buildLocalPlan(
	root: string,
	mode: "doctor" | "install" | "uninstall",
	force: boolean,
	lockMode: LockMode = mode === "install" ? "normal" : "none",
	customAuthorization: CustomAuthorizationOptions = {},
): Promise<BuiltLocalPlan> {
	customAuthorization.cache ??= new Map();
	const envelope: DoctorEnvelope = {
		schemaVersion: 1,
		command: "doctor",
		status: "ok",
		changed: false,
		actions: [],
		diagnostics: [],
		consumerRoot: undefined,
	};
	let consumerRoot: string | undefined;

	let manifestText: string;
	try {
		manifestText = await readFile(join(root, documentPaths.manifest), "utf8");
		consumerRoot = await realpath(root);
		envelope.consumerRoot = consumerRoot;
	} catch (error) {
		envelope.diagnostics.push(
			diagnostic(
				"manifest-read",
				`Unable to read tbboot.yaml: ${errorMessage(error)}`,
				{ document: documentPaths.manifest },
			),
		);
		delete envelope.consumerRoot;
		return { envelope, descriptors: [], lockfileChanged: false };
	}

	const result = validateDocument<"manifest">({
		kind: "manifest",
		text: manifestText,
		document: documentPaths.manifest,
	});
	envelope.diagnostics.push(...result.diagnostics);
	if (result.value === undefined) {
		delete envelope.consumerRoot;
		return { envelope, descriptors: [], lockfileChanged: false };
	}

	const manifest: ManifestDocument = result.value;
	const descriptors: StepDescriptor[] = [];
	const nodes = new Map<string, ResolvedSource>();
	const roots: ResolvedSource[] = [];
	const queue: ResolvedSource[] = [];
	const queued = new Set<string>();
	const cleanups: Array<() => Promise<void>> = [];
	let cleanupTransferred = false;
	const duplicateDiagnostics: Diagnostic[] = [];
	let preparedLockfile: LockfileDocument | undefined;
	let lockfileChanged = false;
	let lockfileLoaded = false;
	let lockfileUsable = true;
	let lockfileExists = false;
	let lockfileFinalized = false;

	const enqueue = (node: ResolvedSource): void => {
		if (queued.has(node.identity)) return;
		queued.add(node.identity);
		queue.push(node);
	};

	const ensureLockfile = async (): Promise<boolean> => {
		if (lockfileLoaded) return lockfileUsable;
		lockfileLoaded = true;
		const loaded = await readLockfile(root, envelope);
		lockfileExists = loaded.exists;
		if (!loaded.valid) {
			preparedLockfile = loaded.document;
			lockfileUsable = false;
			return false;
		}
		preparedLockfile = loaded.document;
		return true;
	};

	const normalizeReference = async (
		reference: SourceReference,
		declaration: SourceDeclaration,
	): Promise<
		| {
				reference: SourceReference;
				identity: string;
				sourceRoot?: string;
				repositoryRoot?: string;
		  }
		| undefined
	> => {
		if (reference.provider === "local") {
			const sourceRoot = await resolveLocalSource(
				root,
				reference.locator.path,
				{
					document: declaration.document,
					path: declaration.path,
					source: declaration.source,
				},
				envelope,
			);
			if (sourceRoot === undefined) return undefined;
			return {
				reference,
				identity: gitIdentity(sourceRoot, reference),
				sourceRoot,
			};
		}

		const normalizedPath = normalizeGitPath(reference.locator.path);
		const repository = normalizeGitRepository(
			root,
			reference.locator.repository,
		);
		const repositoryRoot = await realpath(repository).catch(() => repository);
		const normalizedReference: SourceReference = {
			...reference,
			locator: {
				repository: repositoryRoot,
				...(normalizedPath === undefined ? {} : { path: normalizedPath }),
			},
		};
		return {
			reference: normalizedReference,
			identity: gitIdentity(repositoryRoot, normalizedReference),
			repositoryRoot,
		};
	};

	const addSource = async (
		rawReference: SourceReference,
		declaration: SourceDeclaration,
		parent?: ResolvedSource,
	): Promise<ResolvedSource | undefined> => {
		let normalized: Awaited<ReturnType<typeof normalizeReference>>;
		try {
			normalized = await normalizeReference(rawReference, declaration);
		} catch (error) {
			envelope.diagnostics.push(gitDiagnostic(error, declaration));
			return undefined;
		}
		if (normalized === undefined) return undefined;

		let node = nodes.get(normalized.identity);
		if (node === undefined) {
			node = {
				reference: normalized.reference,
				references: [normalized.reference],
				sourceRoot: normalized.sourceRoot,
				repositoryRoot: normalized.repositoryRoot,
				identity: normalized.identity,
				dependencies: [],
				declarations: [declaration],
			};
			nodes.set(node.identity, node);
			enqueue(node);
		} else {
			const duplicate = node.declarations.find(
				(existing) =>
					existing.scope === declaration.scope &&
					sameSelector(
						existing.reference.selector,
						normalized.reference.selector,
					),
			);
			if (duplicate !== undefined) {
				duplicateDiagnostics.push(
					diagnostic(
						"duplicate-source",
						`Source duplicates declaration at ${duplicate.path}; remove one duplicate declaration`,
						{
							document: declaration.document,
							path: declaration.path,
							source:
								declaration.source ??
								(normalized.reference.provider === "git"
									? normalized.reference.locator.repository
									: normalized.reference.locator.path),
						},
					),
				);
			} else {
				node.declarations.push(declaration);
			}
			const newSelector = !node.references.some(({ selector }) =>
				sameSelector(selector, normalized.reference.selector),
			);
			if (newSelector) {
				node.references.push(normalized.reference);
				enqueue(node);
			}
		}
		if (parent !== undefined && !parent.dependencies.includes(node)) {
			parent.dependencies.push(node);
		}
		return node;
	};

	const setMaterialized = async (
		node: ResolvedSource,
		revision: string,
		fingerprint: string,
		sourceRoot: string,
		cleanup: () => Promise<void>,
	): Promise<void> => {
		if (node.cleanup !== undefined && node.sourceRoot !== sourceRoot) {
			await node.cleanup().catch(() => undefined);
		}
		node.sourceRoot = sourceRoot;
		node.revision = revision;
		node.fingerprint = fingerprint;
		node.cleanup = cleanup;
		cleanups.push(cleanup);
	};

	const finalizeLockEntry = async (
		source: Extract<SourceReference, { provider: "git" }>,
		revision: string,
		fingerprint: string,
	): Promise<void> => {
		if (preparedLockfile === undefined || !lockfileFinalized) return;
		const before = JSON.stringify(preparedLockfile);
		preparedLockfile = {
			schemaVersion: 1,
			sources: await replaceLockEntry(root, preparedLockfile.sources, {
				source,
				revision,
				fingerprint,
			}),
		};
		lockfileChanged ||= before !== JSON.stringify(preparedLockfile);
	};

	const resolveNode = async (
		node: ResolvedSource,
	): Promise<string | undefined> => {
		node.invalid = false;
		if (
			mode === "install" &&
			lockMode !== "none" &&
			!(await ensureLockfile())
		) {
			node.invalid = true;
			return undefined;
		}
		if (node.reference.provider === "local") return "local";
		const declaration = node.declarations[0] as SourceDeclaration;
		const repositoryRoot = node.repositoryRoot as string;
		if (lockMode === "frozen" && !lockfileExists) {
			node.invalid = true;
			if (lockfileUsable) {
				envelope.diagnostics.push(
					diagnostic(
						"lockfile-missing",
						"Frozen lockfile mode requires tbboot.lock.yaml",
						{ document: "tbboot.lock.yaml" },
					),
				);
				lockfileUsable = false;
			}
			return undefined;
		}

		let lockEntry:
			| Extract<LockEntry, { source: { provider: "git" } }>
			| undefined;
		if (preparedLockfile !== undefined) {
			for (const entry of preparedLockfile.sources) {
				if (
					isGitLockEntry(entry) &&
					(await lockIdentity(root, entry.source)) === node.identity
				) {
					lockEntry = entry;
					break;
				}
			}
		}
		const lockSelectorMatches =
			lockEntry !== undefined &&
			node.references.some(({ selector }) =>
				sameSelector(lockEntry.source.selector, selector),
			);
		let useLock =
			lockEntry !== undefined && lockMode !== "update" && lockSelectorMatches;
		if (useLock && lockEntry !== undefined) {
			for (const reference of node.references) {
				if (
					reference.provider === "git" &&
					reference.selector !== undefined &&
					!sameSelector(lockEntry.source.selector, reference.selector) &&
					!(await isGitRevisionAllowed(
						repositoryRoot,
						reference.selector,
						lockEntry.revision,
					))
				) {
					useLock = false;
					break;
				}
			}
		}
		if (lockMode === "frozen" && !useLock) {
			node.invalid = true;
			envelope.diagnostics.push(
				lockDiagnostic(
					"lockfile-stale",
					lockEntry === undefined
						? "Frozen lockfile has no compatible Git Source entry"
						: "Git Source selector differs from the authoritative lock entry",
					declaration,
				),
			);
			return undefined;
		}
		if (
			lockEntry !== undefined &&
			lockMode !== "update" &&
			!useLock &&
			(!lockSelectorMatches || node.references.length === 1)
		) {
			node.invalid = true;
			envelope.diagnostics.push(
				lockDiagnostic(
					"lockfile-stale",
					"Git Source selector differs from the authoritative lock entry",
					declaration,
				),
			);
			return undefined;
		}
		if (
			lockfileFinalized &&
			!useLock &&
			node.sourceRoot !== undefined &&
			node.revision !== undefined &&
			node.fingerprint !== undefined
		) {
			await finalizeLockEntry(node.reference, node.revision, node.fingerprint);
			return `git:${node.revision}`;
		}

		try {
			let revision: string;
			let fingerprint: string;
			if (useLock && lockEntry !== undefined) {
				revision = lockEntry.revision;
				if (
					node.sourceRoot !== undefined &&
					node.revision === revision &&
					node.fingerprint === lockEntry.fingerprint
				) {
					return `git:${revision}`;
				}
				const materialized = await materializeGitSource(
					root,
					node.reference,
					revision,
				);
				if (materialized.fingerprint !== lockEntry.fingerprint) {
					await materialized.cleanup();
					throw new Error(
						"Git Source fingerprint differs from the authoritative lock entry",
					);
				}
				await setMaterialized(
					node,
					materialized.revision,
					materialized.fingerprint,
					materialized.sourceRoot,
					materialized.cleanup,
				);
				return `git:${revision}`;
			}

			const selectors = node.references.flatMap((reference) =>
				reference.provider === "git" && reference.selector !== undefined
					? [reference.selector]
					: [],
			);
			revision =
				selectors.length === 0
					? await resolveGitHead(repositoryRoot)
					: (await resolveGitSelector(repositoryRoot, selectors)).revision;
			if (node.sourceRoot !== undefined && node.revision === revision) {
				fingerprint = node.fingerprint as string;
			} else {
				const materialized = await materializeGitSource(
					root,
					node.reference,
					revision,
				);
				fingerprint = materialized.fingerprint;
				await setMaterialized(
					node,
					materialized.revision,
					materialized.fingerprint,
					materialized.sourceRoot,
					materialized.cleanup,
				);
			}
			await finalizeLockEntry(node.reference, revision, fingerprint);
			return `git:${revision}`;
		} catch (error) {
			node.invalid = true;
			envelope.diagnostics.push(
				useLock
					? lockDiagnostic(
							"lockfile-stale",
							`Unable to use authoritative Git Source revision: ${errorMessage(error)}`,
							declaration,
						)
					: gitDiagnostic(error, declaration),
			);
			return undefined;
		}
	};

	try {
		for (const [index, reference] of manifest.sources.entries()) {
			const node = await addSource(reference, {
				reference,
				document: documentPaths.manifest,
				path: `/sources/${index}/locator${reference.provider === "git" && reference.locator.path === undefined ? "" : "/path"}`,
				selectorPath: `/sources/${index}/selector`,
				scope: "manifest",
				lockPath: `/sources/${index}`,
			});
			if (node !== undefined && !roots.includes(node)) roots.push(node);
		}

		while (queue.length > 0) {
			const node = queue.shift() as ResolvedSource;
			queued.delete(node.identity);
			const revision = await resolveNode(node);
			if (revision === undefined) {
				node.dependencies = [];
				node.sourceDocument = undefined;
				node.expandedRevision = undefined;
				continue;
			}
			if (node.expandedRevision === revision) continue;
			node.dependencies = [];
			node.sourceDocument = undefined;
			node.expandedRevision = revision;
			if (node.sourceRoot === undefined) {
				node.invalid = true;
				continue;
			}
			const sourceDocument = await readSourceDocument(
				node.sourceRoot,
				envelope,
			);
			node.sourceDocument = sourceDocument;
			if (sourceDocument === undefined) {
				node.invalid = true;
				continue;
			}
			for (const [index, dependency] of (
				sourceDocument.dependencies ?? []
			).entries()) {
				const { name: _name, ...reference } = dependency as SourceDependency;
				await addSource(
					reference,
					{
						reference,
						document: documentPaths.source,
						path: `/dependencies/${index}/locator${reference.provider === "git" && reference.locator.path === undefined ? "" : "/path"}`,
						selectorPath: `/dependencies/${index}/selector`,
						scope: node.identity,
						source: node.sourceRoot,
					},
					node,
				);
			}
		}
		envelope.diagnostics.push(...duplicateDiagnostics);

		const cycleSignatures = new Set<string>();
		const states = new Map<string, "visiting" | "visited">();
		const stack: ResolvedSource[] = [];
		const sourceLabel = (node: ResolvedSource): string =>
			node.reference.provider === "local"
				? (node.sourceRoot ?? node.reference.locator.path)
				: `${node.reference.locator.repository}${node.reference.locator.path === undefined ? "" : `/${node.reference.locator.path}`}`;
		const visitCycles = (node: ResolvedSource): void => {
			const state = states.get(node.identity);
			if (state === "visited") return;
			if (state === "visiting") {
				const start = stack.findIndex(
					({ identity }) => identity === node.identity,
				);
				const cycle = [...stack.slice(start), node];
				const signature = cycle.map(({ identity }) => identity).join("->");
				if (!cycleSignatures.has(signature)) {
					cycleSignatures.add(signature);
					const declaration = node.declarations[0] as SourceDeclaration;
					envelope.diagnostics.push(
						diagnostic(
							"source-dependency-cycle",
							`Source dependency cycle: ${cycle.map(sourceLabel).join(" -> ")}`,
							{
								document: declaration.document,
								path: declaration.path,
								source: sourceLabel(node),
							},
						),
					);
				}
				return;
			}
			states.set(node.identity, "visiting");
			stack.push(node);
			for (const dependency of node.dependencies) visitCycles(dependency);
			stack.pop();
			states.set(node.identity, "visited");
		};
		for (const node of roots) visitCycles(node);

		const ordered: ResolvedSource[] = [];
		const added = new Set<string>();
		const ordering = new Set<string>();
		const visit = (node: ResolvedSource): void => {
			if (added.has(node.identity) || ordering.has(node.identity)) return;
			ordering.add(node.identity);
			for (const dependency of node.dependencies) visit(dependency);
			ordering.delete(node.identity);
			added.add(node.identity);
			ordered.push(node);
		};
		for (const node of roots) visit(node);

		lockfileFinalized = true;
		for (const node of ordered) {
			if (node.reference.provider !== "git" || node.invalid) continue;
			await resolveNode(node);
		}

		if (preparedLockfile !== undefined) {
			const declared = new Set(
				ordered
					.filter(
						({ reference, invalid }) =>
							!invalid && reference.provider === "git",
					)
					.map(({ identity }) => identity),
			);
			const retained: LockEntry[] = [];
			for (const [index, entry] of preparedLockfile.sources.entries()) {
				const stale =
					entry.source.provider === "git" &&
					!(await lockIdentity(root, entry.source).then((identity) =>
						declared.has(identity),
					));
				if (!stale || lockMode === "frozen") retained.push(entry);
				if (stale && lockMode === "frozen" && entry.source.provider === "git") {
					envelope.diagnostics.push(
						lockDiagnostic(
							"lockfile-stale",
							"Frozen lockfile contains an undeclared Git Source entry",
							{
								reference: entry.source,
								document: "tbboot.lock.yaml",
								path: `/sources/${index}`,
								scope: "lockfile",
								lockPath: `/sources/${index}`,
							},
						),
					);
				}
			}
			if (retained.length !== preparedLockfile.sources.length) {
				preparedLockfile = { schemaVersion: 1, sources: retained };
				lockfileChanged = true;
			}
		}

		for (const node of ordered) {
			if (
				node.invalid ||
				node.sourceRoot === undefined ||
				node.sourceDocument === undefined
			)
				continue;
			await collectSourceSteps(
				node.sourceRoot,
				node.reference,
				descriptors,
				envelope,
				{
					mode,
					revision: node.revision,
					customAuthorization,
					sourceFingerprint: node.fingerprint,
				},
				node.sourceDocument,
			);
		}

		registerCollisions(descriptors, envelope);
		for (const descriptor of descriptors) {
			envelope.actions.push(descriptor.action);
			await evaluateDescriptor(descriptor, envelope, mode, force);
		}
		cleanupTransferred = true;
		return {
			envelope,
			descriptors,
			consumerRoot,
			lockfile: preparedLockfile,
			lockfileChanged,
			cleanup: async () => {
				for (const cleanup of [...cleanups].reverse()) {
					await cleanup().catch(() => undefined);
				}
			},
		};
	} finally {
		// ponytail: cleanup failures stay best-effort; aggregate diagnostics if reporting becomes necessary.
		if (!cleanupTransferred) {
			for (const cleanup of [...cleanups].reverse()) {
				await cleanup().catch(() => undefined);
			}
		}
	}
}

export async function planLocalInstall(
	root: string,
	force: boolean,
	lockMode: LockMode = "normal",
	customAuthorization: CustomAuthorizationOptions = {},
	mode: "install" | "uninstall" = "install",
): Promise<LocalInstallPlan> {
	const built = await buildLocalPlan(
		root,
		mode,
		force,
		lockMode,
		customAuthorization,
	);
	finish(built.envelope);
	const artifacts = built.descriptors.flatMap((descriptor) => {
		if (descriptor.type === "custom") return [];
		const input = descriptor.inputBytes;
		const targetPath = resolvedPath(descriptor.targetPath);
		if (
			descriptor.collision ||
			input === undefined ||
			targetPath === undefined ||
			!(["satisfied", "missing", "drift"] as ArtifactState[]).includes(
				descriptor.action.state as ArtifactState,
			)
		) {
			return [];
		}
		return [
			{
				source: descriptor.sourceReference,
				sourceRoot: descriptor.source,
				revision: descriptor.revision,
				recipe: descriptor.recipe,
				step: descriptor.step,
				type: descriptor.type,
				marker: descriptor.marker,
				input,
				targetPath,
				targetBefore: descriptor.targetBefore,
				optional: descriptor.optional,
				action: descriptor.action,
			},
		];
	});
	const customSteps = built.descriptors.flatMap((descriptor) => {
		if (
			descriptor.type !== "custom" ||
			(descriptor.preparedCustom === undefined &&
				!descriptor.uninstallUnsupported)
		)
			return [];
		return [
			{
				source: descriptor.sourceReference,
				sourceRoot: descriptor.source,
				revision: descriptor.revision,
				recipe: descriptor.recipe,
				step: descriptor.step,
				optional: descriptor.optional,
				...(descriptor.uninstallUnsupported === undefined
					? {}
					: { uninstallUnsupported: descriptor.uninstallUnsupported }),
				prepared: descriptor.preparedCustom,
				action: descriptor.action,
			},
		];
	});
	delete built.envelope.consumerRoot;
	return {
		consumerRoot: built.consumerRoot ?? resolve(root),
		actions: built.envelope.actions,
		diagnostics: built.envelope.diagnostics,
		artifacts,
		customSteps,
		lockfile: built.lockfile,
		lockfileChanged: built.lockfileChanged,
		cleanup: built.cleanup,
	};
}

export async function runDoctor(
	root: string,
	options: {
		allowCustom?: string[];
		profileRoot?: string;
		signal?: AbortSignal;
	} = {},
): Promise<DoctorResult> {
	if (options.signal?.aborted) {
		return {
			envelope: {
				schemaVersion: 1,
				command: "doctor",
				status: "ok",
				changed: false,
				actions: [],
				diagnostics: [],
			},
			exitCode: 130,
		};
	}
	const built = await buildLocalPlan(root, "doctor", false, "none", {
		allowCustom: options.allowCustom,
		profileRoot: options.profileRoot,
		interactive: process.stdin.isTTY && process.stdout.isTTY,
		persistTrust: false,
	});
	delete built.envelope.consumerRoot;
	try {
		let stderr = "";
		let cancelled = options.signal?.aborted ?? false;
		if (
			!cancelled &&
			!built.envelope.diagnostics.some(({ severity }) => severity === "error")
		) {
			for (const descriptor of built.descriptors) {
				if (options.signal?.aborted) {
					cancelled = true;
					break;
				}
				if (
					descriptor.type !== "custom" ||
					descriptor.preparedCustom === undefined ||
					descriptor.preparedCustom.check === undefined
				)
					continue;
				try {
					const outcome = await runPreparedOperation(
						descriptor.preparedCustom.check,
						descriptor.preparedCustom.context,
						options.signal,
					);
					stderr += outcome.stderr;
					descriptor.action.state =
						outcome.result.status === "ok" ? "ok" : outcome.result.status;
					if (outcome.result.status !== "ok") {
						built.envelope.diagnostics.push(
							diagnostic(
								outcome.result.status === "missing"
									? "custom-missing"
									: outcome.result.status === "drift"
										? "custom-drift"
										: "custom-error",
								outcome.result.message ??
									`Custom check returned ${outcome.result.status}`,
								{
									source: descriptor.source,
									recipe: descriptor.recipe,
									step: descriptor.step,
								},
								descriptor.optional ? "warning" : "error",
							),
						);
						if (!descriptor.optional) break;
					}
				} catch (error) {
					stderr +=
						typeof (error as { stderr?: unknown }).stderr === "string"
							? (error as { stderr: string }).stderr
							: "";
					if (isCancellation(error)) {
						cancelled = true;
						built.envelope.diagnostics.push(
							diagnostic("custom-cancelled", "Custom execution was cancelled", {
								source: descriptor.source,
								recipe: descriptor.recipe,
								step: descriptor.step,
							}),
						);
						break;
					}
					descriptor.action.state = "error";
					built.envelope.diagnostics.push(
						diagnostic(
							"custom-error",
							error instanceof Error ? error.message : "Custom check failed",
							{
								source: descriptor.source,
								recipe: descriptor.recipe,
								step: descriptor.step,
							},
							descriptor.optional ? "warning" : "error",
						),
					);
					if (!descriptor.optional) break;
				}
			}
		}
		const result = finish(built.envelope);
		return {
			...result,
			...(stderr === "" ? {} : { stderr }),
			exitCode: cancelled ? 130 : result.exitCode,
		};
	} finally {
		await built.cleanup?.();
	}
}
