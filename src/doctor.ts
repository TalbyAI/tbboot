import { readFile, readdir, realpath, stat } from 'node:fs/promises';
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

function diagnostic(code, message, context = {}, severity = 'error') {
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

function finish(envelope) {
  const hasError = envelope.diagnostics.some(({ severity }) => severity === 'error');
  const hasWarning = envelope.diagnostics.some(({ severity }) => severity === 'warning');
  envelope.status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  return { envelope, exitCode: hasError ? 1 : 0 };
}

function isNotFound(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function isInside(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function realPathWithMissing(candidate) {
  const missing = [];
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

async function resolveContained(root, base, value) {
  const logical = resolve(base, value);
  if (!isInside(root, logical)) return { escape: true };
  try {
    const canonical = await realPathWithMissing(logical);
    return { path: canonical, escape: !isInside(root, canonical) };
  } catch (error) {
    return { error };
  }
}

function contextFor(descriptor, path) {
  return {
    document: 'recipe.yaml',
    path,
    source: descriptor.source,
    recipe: descriptor.recipe,
    step: descriptor.step,
  };
}

function stepPath(step, field) {
  return `/steps/${step - 1}/${field}`;
}

function stepSeverity(descriptor) {
  return descriptor.optional ? 'warning' : 'error';
}

function addStepDiagnostic(envelope, descriptor, code, message, field, fatal = false) {
  envelope.diagnostics.push(diagnostic(
    code,
    message,
    contextFor(descriptor, stepPath(descriptor.step, field)),
    fatal ? 'error' : stepSeverity(descriptor),
  ));
}

function artifactAction(descriptor) {
  return {
    source: descriptor.source,
    recipe: descriptor.recipe,
    step: descriptor.step,
    type: descriptor.type,
    target: descriptor.target,
    state: 'conflict',
  };
}

function pathKey(value) {
  return value.replaceAll('/', sep).toLowerCase();
}

async function resolveLocalSource(root, locator, index, envelope) {
  const candidate = resolve(root, locator);
  try {
    const sourceRoot = await realpath(candidate);
    if (!(await stat(sourceRoot)).isDirectory()) throw new Error('Source path is not a directory');
    return sourceRoot;
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'source-read',
      `Unable to read local Source: ${error.message}`,
      { document: 'tbboot.yaml', path: `/sources/${index}/locator/path` },
    ));
    return undefined;
  }
}

async function collectSourceSteps(sourceRoot, descriptors, envelope) {
  let sourceText;
  try {
    sourceText = await readFile(join(sourceRoot, 'source.yaml'), 'utf8');
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'source-read',
      `Unable to read source.yaml: ${error.message}`,
      { document: 'source.yaml', source: sourceRoot },
    ));
    return;
  }

  const sourceResult = validateDocument({
    kind: 'source',
    text: sourceText,
    document: 'source.yaml',
    source: sourceRoot,
  });
  envelope.diagnostics.push(...sourceResult.diagnostics);
  if (sourceResult.value === undefined) return;

  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'source-read',
      `Unable to discover Recipes: ${error.message}`,
      { document: 'source.yaml', source: sourceRoot },
    ));
    return;
  }

  const recipes = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  for (const entry of recipes) {
    const recipe = entry.name;
    const recipeFile = join(sourceRoot, recipe, 'recipe.yaml');
    let recipeText;
    try {
      recipeText = await readFile(recipeFile, 'utf8');
    } catch (error) {
      if (isNotFound(error)) continue;
      envelope.diagnostics.push(diagnostic(
        'recipe-read',
        `Unable to read recipe.yaml: ${error.message}`,
        { document: 'recipe.yaml', source: sourceRoot, recipe },
      ));
      continue;
    }

    const recipeResult = validateDocument({
      kind: 'recipe',
      text: recipeText,
      document: 'recipe.yaml',
      source: sourceRoot,
      recipe,
    });
    envelope.diagnostics.push(...recipeResult.diagnostics);
    if (recipeResult.value === undefined) continue;

    for (const [index, step] of recipeResult.value.steps.entries()) {
      const stepNumber = index + 1;
      if (step.type === 'custom') {
        envelope.diagnostics.push(diagnostic(
          'unsupported-step',
          'Custom steps are not supported by doctor',
          {
            document: 'recipe.yaml',
            path: `/steps/${index}`,
            source: sourceRoot,
            recipe,
            step: stepNumber,
          },
          step.optional === true ? 'warning' : 'error',
        ));
        continue;
      }

      const descriptor = {
        source: sourceRoot,
        recipe,
        step: stepNumber,
        type: step.type,
        input: step.input,
        target: step.target,
        optional: step.optional === true,
        recipeRoot: join(sourceRoot, recipe),
      };
      descriptor.inputPath = await resolveContained(sourceRoot, descriptor.recipeRoot, descriptor.input);
      descriptor.targetPath = await resolveContained(envelope.consumerRoot, envelope.consumerRoot, descriptor.target);
      descriptor.action = artifactAction(descriptor);
      descriptors.push(descriptor);
    }
  }
}

function registerCollisions(descriptors, envelope) {
  const targetWriters = new Map();
  const markerWriters = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.targetPath?.path && !descriptor.targetPath.escape && !descriptor.targetPath.error) {
      const key = pathKey(descriptor.targetPath.path);
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

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function exactMarkerLines(text, token, startMarker) {
  const positions = [];
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

function fragmentState(targetText, inputText, marker) {
  const text = normalizeNewlines(targetText);
  const body = normalizeNewlines(inputText);
  const start = `<!-- managed-by: ${marker} -->`;
  const end = `<!-- end-managed-by: ${marker} -->`;
  const expected = `${start}\n${body}${body.endsWith('\n') ? '' : '\n'}${end}`;
  const starts = exactMarkerLines(text, start, true);
  const ends = exactMarkerLines(text, end, false);

  const hasOwnStartToken = text.split('\n').some((line, index, lines) => {
    const trimmed = line.trimStart();
    return line.includes(start) && trimmed.startsWith(start)
      && (line.trim() !== start || index === lines.length - 1);
  });
  const hasOwnEndToken = text.split('\n').some((line) => {
    const trimmed = line.trimStart();
    return line.includes(end) && trimmed.startsWith(end) && line.trim() !== end;
  });

  if (starts.length > 1 || ends.length > 1) return { state: 'conflict', code: 'fragment-marker-collision' };
  if (hasOwnStartToken || hasOwnEndToken || (starts.length === 1) !== (ends.length === 1)) {
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

async function evaluateDescriptor(descriptor, envelope) {
  if (descriptor.collision) return;

  if (descriptor.inputPath?.escape) {
    addStepDiagnostic(envelope, descriptor, 'source-input-escape', 'Source input escapes the canonical Source root', 'input', true);
    return;
  }
  if (descriptor.inputPath?.error || !descriptor.inputPath?.path) {
    addStepDiagnostic(envelope, descriptor, 'source-input-missing', 'Source input is not readable', 'input');
    return;
  }

  let input;
  try {
    input = await readFile(descriptor.inputPath.path);
  } catch {
    addStepDiagnostic(envelope, descriptor, 'source-input-missing', 'Source input is not readable', 'input');
    return;
  }

  if (descriptor.targetPath?.escape) {
    addStepDiagnostic(envelope, descriptor, 'target-escape', 'Target escapes the canonical Consumer repository root', 'target', true);
    return;
  }
  if (descriptor.targetPath?.error || !descriptor.targetPath?.path) {
    descriptor.action.state = 'conflict';
    addStepDiagnostic(envelope, descriptor, 'target-read', 'Target is not readable', 'target');
    return;
  }

  let target;
  try {
    target = await readFile(descriptor.targetPath.path);
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
    addStepDiagnostic(envelope, descriptor, 'target-read', `Unable to read target: ${error.message}`, 'target');
    return;
  }

  if (descriptor.type === 'file') {
    descriptor.action.state = Buffer.from(input).equals(target) ? 'satisfied' : 'drift';
    if (descriptor.action.state === 'drift') {
      addStepDiagnostic(envelope, descriptor, 'file-drift', 'Target bytes differ from Source input', 'target');
    }
    return;
  }

  const result = fragmentState(target.toString('utf8'), input.toString('utf8'), descriptor.marker);
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

export async function runDoctor(root) {
  const envelope = {
    schemaVersion: 1,
    command: 'doctor',
    status: 'ok',
    changed: false,
    actions: [],
    diagnostics: [],
    consumerRoot: undefined,
  };

  let manifestText;
  try {
    manifestText = await readFile(join(root, 'tbboot.yaml'), 'utf8');
    envelope.consumerRoot = await realpath(root);
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'manifest-read',
      `Unable to read tbboot.yaml: ${error.message}`,
      { document: 'tbboot.yaml' },
    ));
    delete envelope.consumerRoot;
    return finish(envelope);
  }

  const result = validateDocument({
    kind: 'manifest',
    text: manifestText,
    document: 'tbboot.yaml',
  });
  envelope.diagnostics.push(...result.diagnostics);
  if (result.value === undefined) {
    delete envelope.consumerRoot;
    return finish(envelope);
  }

  const descriptors = [];
  const seenSources = new Set();
  for (const [index, reference] of result.value.sources.entries()) {
    if (reference.provider !== 'local') {
      envelope.diagnostics.push(diagnostic(
        'unsupported-source-provider',
        `Source provider is not supported: ${reference.provider}`,
        { document: 'tbboot.yaml', path: `/sources/${index}/provider` },
      ));
      continue;
    }
    const sourceRoot = await resolveLocalSource(root, reference.locator.path, index, envelope);
    if (sourceRoot === undefined) continue;
    const key = pathKey(sourceRoot);
    if (seenSources.has(key)) {
      envelope.diagnostics.push(diagnostic(
        'duplicate-source',
        'Source is declared more than once',
        { document: 'tbboot.yaml', path: `/sources/${index}/locator/path`, source: sourceRoot },
      ));
      continue;
    }
    seenSources.add(key);
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
