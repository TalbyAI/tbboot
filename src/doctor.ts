import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { validateDocument } from './contract.ts';
import type {
  Diagnostic,
  DocumentKind,
  ManifestDocument,
  RecipeDocument,
  SourceReference,
  Step,
} from './contract.ts';

type SupportedDocumentKind = Extract<DocumentKind, 'manifest' | 'source' | 'recipe'>;
type DiagnosticContext = Pick<Diagnostic, 'document' | 'path' | 'source' | 'recipe' | 'step'>;
type ArtifactType = Exclude<Step['type'], 'custom'>;
type ArtifactState = 'satisfied' | 'missing' | 'drift' | 'conflict';

export type ArtifactAction = {
  source: string;
  recipe: string;
  step: number;
  type: ArtifactType;
  target: string;
  state: ArtifactState;
};

export type DoctorEnvelope = {
  schemaVersion: 1;
  command: 'doctor';
  status: 'ok' | 'warning' | 'error';
  changed: boolean;
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
  source: string;
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
  action: ArtifactAction;
};

type FragmentResult =
  | { state: 'satisfied'; code?: undefined }
  | { state: 'missing' | 'drift' | 'conflict'; code: string };

const documentPaths = {
  manifest: 'tbboot.yaml',
  source: 'source.yaml',
  recipe: 'recipe.yaml',
} satisfies Record<SupportedDocumentKind, string>;

function diagnostic(
  code: string,
  message: string,
  context: DiagnosticContext = {},
  severity: Diagnostic['severity'] = 'error',
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

function finish(envelope: DoctorEnvelope): DoctorResult {
  const hasError = envelope.diagnostics.some(({ severity }) => severity === 'error');
  const hasWarning = envelope.diagnostics.some(({ severity }) => severity === 'warning');
  envelope.status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  return { envelope, exitCode: hasError ? 1 : 0 };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
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

async function resolveContained(root: string, base: string, value: string): Promise<PathResolution> {
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

function contextFor(descriptor: StepDescriptor, path: string): DiagnosticContext {
  return {
    document: documentPaths.recipe,
    path,
    source: descriptor.source,
    recipe: descriptor.recipe,
    step: descriptor.step,
  };
}

function stepPath(step: number, field: 'input' | 'target'): string {
  return `/steps/${step - 1}/${field}`;
}

function stepSeverity(descriptor: StepDescriptor): Diagnostic['severity'] {
  return descriptor.optional ? 'warning' : 'error';
}

function addStepDiagnostic(
  envelope: DoctorEnvelope,
  descriptor: StepDescriptor,
  code: string,
  message: string,
  field: 'input' | 'target',
  fatal = false,
): void {
  envelope.diagnostics.push(diagnostic(
    code,
    message,
    contextFor(descriptor, stepPath(descriptor.step, field)),
    fatal ? 'error' : stepSeverity(descriptor),
  ));
}

function artifactAction(
  descriptor: Pick<StepDescriptor, 'source' | 'recipe' | 'step' | 'type' | 'target'>,
): ArtifactAction {
  return {
    source: descriptor.source,
    recipe: descriptor.recipe,
    step: descriptor.step,
    type: descriptor.type,
    target: descriptor.target,
    state: 'conflict',
  };
}

const caseInsensitiveFs = process.platform === 'win32';

function pathKey(value: string): string {
  const normalized = value.replaceAll('/', sep);
  return caseInsensitiveFs ? normalized.toLowerCase() : normalized;
}

function isPathEscape(resolution: PathResolution | undefined): boolean {
  return resolution !== undefined && 'escape' in resolution && resolution.escape;
}

function hasPathError(resolution: PathResolution | undefined): boolean {
  return resolution !== undefined && 'error' in resolution;
}

function resolvedPath(resolution: PathResolution | undefined): string | undefined {
  return resolution !== undefined && 'path' in resolution ? resolution.path : undefined;
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
    if (!(await stat(sourceRoot)).isDirectory()) throw new Error('Source path is not a directory');
    return sourceRoot;
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'source-read',
      `Unable to read local Source: ${errorMessage(error)}`,
      { document: documentPaths.manifest, path: `/sources/${index}/locator/path` },
    ));
    return undefined;
  }
}

async function collectSourceSteps(
  sourceRoot: string,
  descriptors: StepDescriptor[],
  envelope: DoctorEnvelope,
): Promise<void> {
  let sourceText: string;
  try {
    sourceText = await readFile(join(sourceRoot, documentPaths.source), 'utf8');
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'source-read',
      `Unable to read source.yaml: ${errorMessage(error)}`,
      { document: documentPaths.source, source: sourceRoot },
    ));
    return;
  }

  const sourceResult = validateDocument<'source'>({
    kind: 'source',
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
    envelope.diagnostics.push(diagnostic(
      'source-read',
      `Unable to discover Recipes: ${errorMessage(error)}`,
      { document: documentPaths.source, source: sourceRoot },
    ));
    return;
  }

  const recipes = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  for (const entry of recipes) {
    const recipe = entry.name;
    const recipeFile = join(sourceRoot, recipe, documentPaths.recipe);
    let recipeText: string;
    try {
      recipeText = await readFile(recipeFile, 'utf8');
    } catch (error) {
      if (isNotFound(error)) continue;
      envelope.diagnostics.push(diagnostic(
        'recipe-read',
        `Unable to read recipe.yaml: ${errorMessage(error)}`,
        { document: documentPaths.recipe, source: sourceRoot, recipe },
      ));
      continue;
    }

    const recipeResult = validateDocument<'recipe'>({
      kind: 'recipe',
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
      if (step.type === 'custom') {
        envelope.diagnostics.push(diagnostic(
          'unsupported-step',
          'Custom steps are not supported by doctor',
          {
            document: documentPaths.recipe,
            path: `/steps/${index}`,
            source: sourceRoot,
            recipe,
            step: stepNumber,
          },
          step.optional === true ? 'warning' : 'error',
        ));
        continue;
      }

      const descriptor: StepDescriptor = {
        source: sourceRoot,
        recipe,
        step: stepNumber,
        type: step.type,
        input: step.input,
        target: step.target,
        optional: step.optional === true,
        recipeRoot: join(sourceRoot, recipe),
        action: artifactAction({
          source: sourceRoot,
          recipe,
          step: stepNumber,
          type: step.type,
          target: step.target,
        }),
      };
      descriptor.inputPath = await resolveContained(sourceRoot, descriptor.recipeRoot, descriptor.input);
      descriptor.targetPath = await resolveContained(envelope.consumerRoot!, envelope.consumerRoot!, descriptor.target);
      descriptors.push(descriptor);
    }
  }
}

function registerCollisions(descriptors: StepDescriptor[], envelope: DoctorEnvelope): void {
  const targetWriters = new Map<string, StepDescriptor[]>();
  const markerWriters = new Map<string, StepDescriptor[]>();
  for (const descriptor of descriptors) {
    const targetPath = resolvedPath(descriptor.targetPath);
    if (targetPath !== undefined && !isPathEscape(descriptor.targetPath) && !hasPathError(descriptor.targetPath)) {
      const key = pathKey(targetPath);
      const group = targetWriters.get(key) ?? [];
      group.push(descriptor);
      targetWriters.set(key, group);
    }
    if (descriptor.type === 'file-fragment') {
      descriptor.marker = `${basename(descriptor.source)}/${descriptor.recipe}`;
      const group = markerWriters.get(descriptor.marker) ?? [];
      group.push(descriptor);
      markerWriters.set(descriptor.marker, group);
    }
  }

  for (const group of targetWriters.values()) {
    if (group.length <= 1 || !group.some(({ type }) => type === 'file')) continue;
    for (const descriptor of group) {
      descriptor.collision = true;
      descriptor.action.state = 'conflict';
      addStepDiagnostic(
        envelope,
        descriptor,
        'file-target-collision',
        'Multiple writing Steps target the same file',
        'target',
        true,
      );
    }
  }

  for (const group of markerWriters.values()) {
    if (group.length <= 1) continue;
    for (const descriptor of group) {
      descriptor.collision = true;
      descriptor.action.state = 'conflict';
      addStepDiagnostic(
        envelope,
        descriptor,
        'fragment-marker-collision',
        'Multiple File Fragment Steps use the same managed marker',
        'target',
        true,
      );
    }
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function exactMarkerLines(text: string, token: string, startMarker: boolean): number[] {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const lineEnd = text.indexOf('\n', offset);
    const end = lineEnd === -1 ? text.length : lineEnd;
    if (text.slice(offset, end) === token && (!startMarker || lineEnd !== -1)) positions.push(offset);
    if (lineEnd === -1) break;
    offset = lineEnd + 1;
  }
  return positions;
}

function fragmentState(targetText: string, inputText: string, marker: string): FragmentResult {
  const text = normalizeNewlines(targetText);
  const lines = text.split('\n');
  const body = normalizeNewlines(inputText);
  const start = `<!-- managed-by: ${marker} -->`;
  const end = `<!-- end-managed-by: ${marker} -->`;
  const expected = `${start}\n${body}${body.endsWith('\n') ? '' : '\n'}${end}`;
  const starts = exactMarkerLines(text, start, true);
  const ends = exactMarkerLines(text, end, false);

  const managed = new Map<string, { starts: number; ends: number }>();
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
    }
  }
  const malformedMarkerLine = lines.some((line, index) => {
    const ownStartPrefix = line.startsWith(start);
    const ownEndPrefix = line.startsWith(end);
    const genericPrefix = line.startsWith('<!-- managed-by: ')
      || line.startsWith('<!-- end-managed-by: ');
    const completeManagedLine = /^<!-- managed-by: .+ -->$/.test(line)
      || /^<!-- end-managed-by: .+ -->$/.test(line);
    return (ownStartPrefix && (line !== start || index === lines.length - 1))
      || (ownEndPrefix && line !== end)
      || (genericPrefix && !completeManagedLine);
  });
  const hasUnmatchedDistinctMarker = [...managed.entries()]
    .filter(([name]) => name !== marker)
    .some(([, counts]) => (counts.starts > 0) !== (counts.ends > 0));

  if (starts.length > 1 || ends.length > 1) return { state: 'conflict', code: 'fragment-marker-collision' };
  if (malformedMarkerLine || hasUnmatchedDistinctMarker
      || (starts.length === 1) !== (ends.length === 1)) {
    return { state: 'conflict', code: 'incomplete-fragment' };
  }
  if (starts.length === 0) return { state: 'missing', code: 'fragment-missing' };

  const startOffset = starts[0];
  const endOffset = ends[0];
  if (endOffset <= startOffset) return { state: 'conflict', code: 'incomplete-fragment' };
  const actual = text.slice(startOffset, endOffset + end.length);
  return actual === expected
    ? { state: 'satisfied' }
    : { state: 'drift', code: 'fragment-drift' };
}

async function evaluateDescriptor(descriptor: StepDescriptor, envelope: DoctorEnvelope): Promise<void> {
  if (descriptor.collision) return;

  if (isPathEscape(descriptor.inputPath)) {
    addStepDiagnostic(envelope, descriptor, 'source-input-escape', 'Source input escapes the canonical Source root', 'input', true);
    return;
  }
  const inputPath = resolvedPath(descriptor.inputPath);
  if (hasPathError(descriptor.inputPath) || inputPath === undefined) {
    addStepDiagnostic(envelope, descriptor, 'source-input-missing', 'Source input is not readable', 'input');
    return;
  }

  let input: Buffer;
  try {
    input = await readFile(inputPath);
  } catch {
    addStepDiagnostic(envelope, descriptor, 'source-input-missing', 'Source input is not readable', 'input');
    return;
  }

  if (isPathEscape(descriptor.targetPath)) {
    addStepDiagnostic(envelope, descriptor, 'target-escape', 'Target escapes the canonical Consumer repository root', 'target', true);
    return;
  }
  const targetPath = resolvedPath(descriptor.targetPath);
  if (hasPathError(descriptor.targetPath) || targetPath === undefined) {
    descriptor.action.state = 'conflict';
    addStepDiagnostic(envelope, descriptor, 'target-read', 'Target is not readable', 'target');
    return;
  }

  let target: Buffer;
  try {
    target = await readFile(targetPath);
  } catch (error) {
    if (isNotFound(error)) {
      descriptor.action.state = 'missing';
      addStepDiagnostic(
        envelope,
        descriptor,
        descriptor.type === 'file' ? 'file-missing' : 'fragment-missing',
        'Target is missing',
        'target',
      );
      return;
    }
    descriptor.action.state = 'conflict';
    addStepDiagnostic(envelope, descriptor, 'target-read', `Unable to read target: ${errorMessage(error)}`, 'target');
    return;
  }

  if (descriptor.type === 'file') {
    descriptor.action.state = Buffer.from(input).equals(target) ? 'satisfied' : 'drift';
    if (descriptor.action.state === 'drift') {
      addStepDiagnostic(envelope, descriptor, 'file-drift', 'Target bytes differ from Source input', 'target');
    }
    return;
  }

  const result = fragmentState(target.toString('utf8'), input.toString('utf8'), descriptor.marker!);
  descriptor.action.state = result.state;
  if (result.code !== undefined) {
    addStepDiagnostic(
      envelope,
      descriptor,
      result.code,
      result.code === 'fragment-drift'
        ? 'Managed fragment differs from Source input'
        : result.code === 'fragment-missing'
          ? 'Managed fragment is missing'
          : result.code === 'fragment-marker-collision'
            ? 'Managed fragment marker appears more than once'
            : 'Managed fragment markers are incomplete or mismatched',
      'target',
      result.code === 'fragment-marker-collision' || result.code === 'incomplete-fragment',
    );
  }
}

export async function runDoctor(root: string): Promise<DoctorResult> {
  const envelope: DoctorEnvelope = {
    schemaVersion: 1,
    command: 'doctor',
    status: 'ok',
    changed: false,
    actions: [],
    diagnostics: [],
    consumerRoot: undefined,
  };

  let manifestText: string;
  try {
    manifestText = await readFile(join(root, documentPaths.manifest), 'utf8');
    envelope.consumerRoot = await realpath(root);
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'manifest-read',
      `Unable to read tbboot.yaml: ${errorMessage(error)}`,
      { document: documentPaths.manifest },
    ));
    delete envelope.consumerRoot;
    return finish(envelope);
  }

  const result = validateDocument<'manifest'>({
    kind: 'manifest',
    text: manifestText,
    document: documentPaths.manifest,
  });
  envelope.diagnostics.push(...result.diagnostics);
  if (result.value === undefined) {
    delete envelope.consumerRoot;
    return finish(envelope);
  }

  const manifest: ManifestDocument = result.value;
  const descriptors: StepDescriptor[] = [];
  const seenSources = new Map<string, number>();
  for (const [index, reference] of manifest.sources.entries()) {
    const sourceReference: SourceReference = reference;
    if (sourceReference.provider !== 'local') {
      envelope.diagnostics.push(diagnostic(
        'unsupported-source-provider',
        `Source provider is not supported: ${sourceReference.provider}`,
        { document: documentPaths.manifest, path: `/sources/${index}/provider` },
      ));
      continue;
    }
    const sourceRoot = await resolveLocalSource(root, sourceReference.locator.path, index, envelope);
    if (sourceRoot === undefined) continue;
    const key = pathKey(sourceRoot);
    if (seenSources.has(key)) {
      const firstIndex = seenSources.get(key)!;
      envelope.diagnostics.push(diagnostic(
        'duplicate-source',
        `Source duplicates declaration at /sources/${firstIndex}/locator/path; remove one duplicate declaration`,
        { document: documentPaths.manifest, path: `/sources/${index}/locator/path`, source: sourceRoot },
      ));
      continue;
    }
    seenSources.set(key, index);
    await collectSourceSteps(sourceRoot, descriptors, envelope);
  }

  registerCollisions(descriptors, envelope);
  for (const descriptor of descriptors) {
    envelope.actions.push(descriptor.action);
    await evaluateDescriptor(descriptor, envelope);
  }
  delete envelope.consumerRoot;
  return finish(envelope);
}
