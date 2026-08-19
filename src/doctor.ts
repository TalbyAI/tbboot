import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type {
	Diagnostic,
	DocumentKind,
	LockEntry,
	LockfileDocument,
	ManifestDocument,
	RecipeDocument,
	SourceReference,
	Step,
} from "./contract.ts";
import { validateDocument } from "./contract.ts";
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

export type ArtifactAction = {
	source: string;
	recipe: string;
	step: number;
	type: ArtifactType;
	target: string;
	state: ArtifactState;
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

export type LocalInstallPlan = {
	consumerRoot: string;
	actions: ArtifactAction[];
	diagnostics: Diagnostic[];
	artifacts: PlannedArtifact[];
	lockfile?: LockfileDocument;
	lockfileChanged: boolean;
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
	exitCode: 0 | 1;
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
	type: ArtifactType;
	input: string;
	target: string;
	optional: boolean;
	recipeRoot: string;
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

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
	);
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

function artifactAction(
	descriptor: Pick<
		StepDescriptor,
		"source" | "recipe" | "step" | "type" | "target"
	>,
): ArtifactAction {
	return {
		source: descriptor.source,
		recipe: descriptor.recipe,
		step: descriptor.step,
		type: descriptor.type,
		target: descriptor.target,
		state: "conflict",
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
	index: number,
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
				{
					document: documentPaths.manifest,
					path: `/sources/${index}/locator/path`,
				},
			),
		);
		return undefined;
	}
}

async function collectSourceSteps(
	sourceRoot: string,
	sourceReference: SourceReference,
	descriptors: StepDescriptor[],
	envelope: DoctorEnvelope,
	metadata: {
		revision?: string;
	} = {},
): Promise<void> {
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
		return;
	}

	const sourceResult = validateDocument<"source">({
		kind: "source",
		text: sourceText,
		document: documentPaths.source,
		source: sourceRoot,
	});
	envelope.diagnostics.push(...sourceResult.diagnostics);
	if (sourceResult.value === undefined) return;

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
				envelope.diagnostics.push(
					diagnostic(
						"unsupported-step",
						"Custom steps are not supported by doctor",
						{
							document: documentPaths.recipe,
							path: `/steps/${index}`,
							source: sourceRoot,
							recipe,
							step: stepNumber,
						},
						step.optional === true ? "warning" : "error",
					),
				);
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
				descriptor.input,
			);
			const consumerRoot = envelope.consumerRoot as string;
			descriptor.targetPath = await resolveContained(
				consumerRoot,
				consumerRoot,
				descriptor.target,
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

function fragmentState(
	targetText: string,
	inputText: string,
	marker: string,
): FragmentResult {
	const text = normalizeNewlines(targetText);
	const lines = text.split("\n");
	const body = normalizeNewlines(inputText);
	const start = `<!-- managed-by: ${marker} -->`;
	const end = `<!-- end-managed-by: ${marker} -->`;
	const expected = `${start}\n${body}${body.endsWith("\n") ? "" : "\n"}${end}`;
	const targetBytes = Buffer.from(text);
	const markerScan = scanManagedBlock(targetBytes, marker);
	const starts = markerScan.starts;
	const ends = markerScan.ends;

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

	if (starts.length > 1 || ends.length > 1)
		return { state: "conflict", code: "fragment-marker-collision" };
	if (
		malformedMarkerLine ||
		hasUnmatchedDistinctMarker ||
		nestedMarker ||
		mismatchedMarker ||
		markerStack.length > 0 ||
		(starts.length === 1) !== (ends.length === 1)
	) {
		return { state: "conflict", code: "incomplete-fragment" };
	}
	if (starts.length === 0)
		return { state: "missing", code: "fragment-missing" };

	const range = markerScan.range;
	if (range === undefined)
		return { state: "conflict", code: "incomplete-fragment" };
	const actual = targetBytes.subarray(range.start, range.end).toString("utf8");
	return actual === expected
		? { state: "satisfied" }
		: { state: "drift", code: "fragment-drift" };
}

async function evaluateDescriptor(
	descriptor: StepDescriptor,
	envelope: DoctorEnvelope,
	mode: "doctor" | "install",
	force: boolean,
): Promise<void> {
	if (descriptor.collision) return;

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
};

export type LockMode = "none" | "normal" | "update" | "frozen";

type ResolvedSource = {
	reference: SourceReference;
	sourceRoot: string;
	identity: string;
	revision?: string;
	cleanup?: () => Promise<void>;
};

function gitIdentity(root: string, reference: SourceReference): string {
	if (reference.provider !== "git") return pathKey(root);
	return `${pathKey(root)}|${normalizeGitPath(reference.locator.path) ?? ""}`;
}

function gitDiagnostic(
	error: unknown,
	index: number,
	reference: SourceReference,
): Diagnostic {
	const code =
		error instanceof GitSourceError ? error.code : "git-repository-read";
	const message =
		error instanceof Error
			? error.message
			: `Unable to resolve Git Source: ${String(error)}`;
	return diagnostic(code, message, {
		document: documentPaths.manifest,
		path: `/sources/${index}/selector`,
		source:
			reference.provider === "git" ? reference.locator.repository : undefined,
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
	return JSON.stringify(left) === JSON.stringify(right);
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
	index: number,
	reference: Extract<SourceReference, { provider: "git" }>,
): Diagnostic {
	return diagnostic(code, message, {
		document: "tbboot.lock.yaml",
		path: `/sources/${index}`,
		source: reference.locator.repository,
	});
}

async function buildLocalPlan(
	root: string,
	mode: "doctor" | "install",
	force: boolean,
	lockMode: LockMode = mode === "install" ? "normal" : "none",
): Promise<BuiltLocalPlan> {
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
	const resolvedSources = new Map<number, ResolvedSource>();
	const cleanups: Array<() => Promise<void>> = [];
	let preparedLockfile: LockfileDocument | undefined;
	let lockfileChanged = false;
	const gitGroups = new Map<
		string,
		{
			firstIndex: number;
			indexes: number[];
			references: Extract<SourceReference, { provider: "git" }>[];
			repositoryRoot: string;
		}
	>();
	for (const [index, reference] of manifest.sources.entries()) {
		if (reference.provider === "local") {
			const sourceRoot = await resolveLocalSource(
				root,
				reference.locator.path,
				index,
				envelope,
			);
			if (sourceRoot !== undefined) {
				resolvedSources.set(index, {
					reference,
					sourceRoot,
					identity: gitIdentity(sourceRoot, reference),
				});
			}
			continue;
		}
		const normalizedPath = normalizeGitPath(reference.locator.path);
		const normalizedReference: Extract<SourceReference, { provider: "git" }> = {
			...reference,
			locator: {
				repository: reference.locator.repository,
				...(normalizedPath === undefined ? {} : { path: normalizedPath }),
			},
		};
		const repositoryPath = normalizeGitRepository(
			root,
			normalizedReference.locator.repository,
		);
		const repositoryRoot = await realpath(repositoryPath).catch(
			() => repositoryPath,
		);
		const key = gitIdentity(repositoryRoot, normalizedReference);
		const group = gitGroups.get(key) ?? {
			firstIndex: index,
			indexes: [],
			references: [],
			repositoryRoot,
		};
		group.indexes.push(index);
		group.references.push(normalizedReference);
		gitGroups.set(key, group);
	}
	if (mode === "install" && lockMode !== "none" && gitGroups.size > 0) {
		const loaded = await readLockfile(root, envelope);
		preparedLockfile = loaded.document;
		if (!loaded.valid) {
			return {
				envelope,
				descriptors,
				consumerRoot,
				lockfile: preparedLockfile,
				lockfileChanged: false,
			};
		}
		if (lockMode === "frozen" && !loaded.exists) {
			envelope.diagnostics.push(
				diagnostic(
					"lockfile-missing",
					"Frozen lockfile mode requires tbboot.lock.yaml",
					{ document: "tbboot.lock.yaml" },
				),
			);
		}
	}

	for (const group of gitGroups.values()) {
		const reference = group.references[0];
		const selectorsSeen = new Map<string, number>();
		for (const [offset, groupedReference] of group.references.entries()) {
			const selectorKey =
				JSON.stringify(groupedReference.selector) ?? "undefined";
			const firstOffset = selectorsSeen.get(selectorKey);
			if (firstOffset !== undefined) {
				envelope.diagnostics.push(
					diagnostic(
						"duplicate-source",
						`Source duplicates declaration at /sources/${group.indexes[firstOffset]}/locator/path; remove one duplicate declaration`,
						{
							document: documentPaths.manifest,
							path: `/sources/${group.indexes[offset]}/locator/path`,
							source: groupedReference.locator.repository,
						},
					),
				);
			}
			selectorsSeen.set(selectorKey, offset);
		}
		try {
			const normalizedRepository = await realpath(group.repositoryRoot).catch(
				() => group.repositoryRoot,
			);
			const normalizedReference: Extract<SourceReference, { provider: "git" }> =
				{
					...reference,
					locator: {
						...reference.locator,
						repository: normalizedRepository,
					},
				};
			let lockEntry: LockEntry | undefined;
			if (preparedLockfile !== undefined) {
				for (const entry of preparedLockfile.sources) {
					if (
						entry.source.provider === "git" &&
						(await lockIdentity(root, entry.source)) ===
							(await lockIdentity(root, normalizedReference))
					) {
						lockEntry = entry;
						break;
					}
				}
			}
			let useLock =
				lockEntry !== undefined &&
				lockMode !== "update" &&
				sameSelector(lockEntry.source.selector, reference.selector);
			if (useLock && lockEntry !== undefined) {
				const selectorsToCheck = [
					...(reference.selector !== undefined && "from" in reference.selector
						? [reference.selector]
						: []),
					...group.references
						.slice(1)
						.flatMap(({ selector }) =>
							selector === undefined ? [] : [selector],
						),
				];
				for (const selector of selectorsToCheck) {
					if (
						!(await isGitRevisionAllowed(
							group.repositoryRoot,
							selector,
							lockEntry.revision,
						))
					) {
						useLock = false;
						break;
					}
				}
			}
			if (lockMode === "frozen" && !useLock) {
				envelope.diagnostics.push(
					lockDiagnostic(
						"lockfile-stale",
						lockEntry === undefined
							? "Frozen lockfile has no compatible Git Source entry"
							: "Git Source selector differs from the authoritative lock entry",
						group.firstIndex,
						reference,
					),
				);
				continue;
			}
			if (lockEntry !== undefined && lockMode !== "update" && !useLock) {
				envelope.diagnostics.push(
					lockDiagnostic(
						"lockfile-stale",
						"Git Source selector differs from the authoritative lock entry",
						group.firstIndex,
						reference,
					),
				);
				continue;
			}
			if (useLock && lockEntry !== undefined) {
				try {
					const materialized = await materializeGitSource(
						root,
						normalizedReference,
						lockEntry.revision,
					);
					if (materialized.fingerprint !== lockEntry.fingerprint) {
						await materialized.cleanup();
						throw new Error(
							"Git Source fingerprint differs from the authoritative lock entry",
						);
					}
					cleanups.push(materialized.cleanup);
					resolvedSources.set(group.firstIndex, {
						reference: normalizedReference,
						sourceRoot: materialized.sourceRoot,
						identity: await lockIdentity(root, normalizedReference),
						revision: materialized.revision,
					});
					continue;
				} catch (error) {
					envelope.diagnostics.push(
						lockDiagnostic(
							"lockfile-stale",
							`Unable to use authoritative Git Source revision: ${errorMessage(error)}`,
							group.firstIndex,
							reference,
						),
					);
					continue;
				}
			}
			const selectors = group.references.flatMap(({ selector }) =>
				selector === undefined ? [] : [selector],
			);
			const revision =
				selectors.length === 0
					? await resolveGitHead(group.repositoryRoot)
					: (await resolveGitSelector(group.repositoryRoot, selectors))
							.revision;
			const materialized = await materializeGitSource(
				root,
				reference,
				revision,
			);
			cleanups.push(materialized.cleanup);
			resolvedSources.set(group.firstIndex, {
				reference: normalizedReference,
				sourceRoot: materialized.sourceRoot,
				identity: await lockIdentity(root, normalizedReference),
				revision: materialized.revision,
			});
			if (preparedLockfile !== undefined) {
				preparedLockfile = {
					schemaVersion: 1,
					sources: await replaceLockEntry(root, preparedLockfile.sources, {
						source: normalizedReference,
						revision: materialized.revision,
						fingerprint: materialized.fingerprint,
					}),
				};
				lockfileChanged = true;
			}
		} catch (error) {
			envelope.diagnostics.push(
				gitDiagnostic(error, group.firstIndex, reference),
			);
		}
	}

	const seenSources = new Map<string, number>();
	for (const [index] of manifest.sources.entries()) {
		const resolvedSource = resolvedSources.get(index);
		if (resolvedSource === undefined) continue;
		const key = resolvedSource.identity;
		if (seenSources.has(key)) {
			const firstIndex = seenSources.get(key) as number;
			envelope.diagnostics.push(
				diagnostic(
					"duplicate-source",
					`Source duplicates declaration at /sources/${firstIndex}/locator/path; remove one duplicate declaration`,
					{
						document: documentPaths.manifest,
						path: `/sources/${index}/locator/path`,
						source: resolvedSource.sourceRoot,
					},
				),
			);
			continue;
		}
		seenSources.set(key, index);
		await collectSourceSteps(
			resolvedSource.sourceRoot,
			resolvedSource.reference,
			descriptors,
			envelope,
			{
				revision: resolvedSource.revision,
			},
		);
	}

	registerCollisions(descriptors, envelope);
	for (const descriptor of descriptors) {
		envelope.actions.push(descriptor.action);
		await evaluateDescriptor(descriptor, envelope, mode, force);
	}
	for (const cleanup of cleanups.reverse()) await cleanup();
	return {
		envelope,
		descriptors,
		consumerRoot,
		lockfile: preparedLockfile,
		lockfileChanged,
	};
}

export async function planLocalInstall(
	root: string,
	force: boolean,
	lockMode: LockMode = "normal",
): Promise<LocalInstallPlan> {
	const built = await buildLocalPlan(root, "install", force, lockMode);
	finish(built.envelope);
	const artifacts = built.descriptors.flatMap((descriptor) => {
		const input = descriptor.inputBytes;
		const targetPath = resolvedPath(descriptor.targetPath);
		if (
			descriptor.collision ||
			input === undefined ||
			targetPath === undefined ||
			!(["satisfied", "missing", "drift"] as ArtifactState[]).includes(
				descriptor.action.state,
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
	delete built.envelope.consumerRoot;
	return {
		consumerRoot: built.consumerRoot ?? resolve(root),
		actions: built.envelope.actions,
		diagnostics: built.envelope.diagnostics,
		artifacts,
		lockfile: built.lockfile,
		lockfileChanged: built.lockfileChanged,
	};
}

export async function runDoctor(root: string): Promise<DoctorResult> {
	const built = await buildLocalPlan(root, "doctor", false);
	delete built.envelope.consumerRoot;
	return finish(built.envelope);
}
