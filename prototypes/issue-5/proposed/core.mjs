import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { parse as parseYaml } from 'yaml';

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^(?:\\\\|\/\/)/;

function diagnostic(code, message) {
  return { severity: 'error', code, message };
}

function hasUnsupportedScheme(value) {
  return URI_SCHEME.test(value) && !DRIVE_PATH.test(value) && !UNC_PATH.test(value);
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function localPath(base, value) {
  return resolve(isAbsolute(value) ? value : join(base, value));
}

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function realPathWithMissing(path) {
  const missing = [];
  let current = path;
  while (true) {
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
      continue;
    }
    if (stats.isSymbolicLink()) {
      try {
        const resolved = await realpath(current);
        return missing.reduce((result, part) => join(result, part), resolved);
      } catch (error) {
        error.code = 'ERR_TARGET_SYMLINK';
        throw error;
      }
    }
    const resolved = await realpath(current);
    return missing.reduce((result, part) => join(result, part), resolved);
  }
}

async function readYaml(path, code, diagnostics) {
  try {
    return parseYaml(await readFile(path, 'utf8')) ?? {};
  } catch (error) {
    diagnostics.push(diagnostic(code, `${path}: ${error.message}`));
    return null;
  }
}

async function readInput(path, details, diagnostics) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    diagnostics.push(diagnostic(
      'source-input-missing',
      `${details.source}, recipe ${details.recipe}, step ${details.step}: ${path}: ${error.message}`,
    ));
    return null;
  }
}

function countOccurrences(value, part) {
  return value.split(part).length - 1;
}

function fragmentMarkers(marker) {
  return {
    start: `<!-- managed-by: ${marker} -->`,
    end: `<!-- end-managed-by: ${marker} -->`,
  };
}

function fragmentBlock(marker, content) {
  const { start, end } = fragmentMarkers(marker);
  return `${start}\n${content.endsWith('\n') ? content : `${content}\n`}${end}`;
}

function appendFragment(existing, block) {
  if (!existing) return `${block}\n`;
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

function planFragment(existing, marker, content) {
  const { start, end } = fragmentMarkers(marker);
  const startCount = countOccurrences(existing ?? '', start);
  const endCount = countOccurrences(existing ?? '', end);
  if (startCount > 1 || endCount > 1) return { code: 'fragment-marker-collision' };
  if (startCount !== endCount) return { code: 'incomplete-fragment' };

  const block = fragmentBlock(marker, content);
  if (startCount === 0) {
    return {
      action: existing === undefined ? 'create' : 'update',
      content: appendFragment(existing ?? '', block),
    };
  }

  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex + start.length);
  const currentBlock = existing.slice(startIndex, endIndex + end.length);
  return currentBlock === block
    ? { action: 'noop', content: existing }
    : { code: 'fragment-drift' };
}

function registerTarget(targetWriters, target, kind, details, diagnostics) {
  const key = pathKey(target);
  const previous = targetWriters.get(key);
  if (previous && (previous.kind === 'file' || kind === 'file')) {
    diagnostics.push(diagnostic(
      'file-target-collision',
      `${previous.source}, recipe ${previous.recipe}, step ${previous.step} and `
        + `${details.source}, recipe ${details.recipe}, step ${details.step} share ${target}`,
    ));
  }
  if (!previous || kind === 'file') targetWriters.set(key, { kind, ...details });
}

async function discoverRecipes(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const recipes = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const recipePath = join(sourceRoot, entry.name, 'recipe.yaml');
    try {
      await readFile(recipePath);
      recipes.push({ folder: entry.name, path: recipePath });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return recipes;
}

export async function planInstall(consumerRoot) {
  const consumerPath = resolve(consumerRoot);
  const diagnostics = [];
  const writes = [];
  const fragmentState = new Map();
  const seenFragmentMarkers = new Set();
  const targetWriters = new Map();
  let consumerRealPath;
  try {
    consumerRealPath = await realpath(consumerPath);
  } catch (error) {
    diagnostics.push(diagnostic('manifest-read', `${consumerPath}: ${error.message}`));
    return { writes, diagnostics };
  }
  const manifest = await readYaml(join(consumerPath, 'manifest.yaml'), 'manifest-read', diagnostics);
  if (!manifest) return { writes, diagnostics };

  const sourceReferences = Array.isArray(manifest.sources) ? manifest.sources : [];
  const seenSources = new Map();

  for (const [sourceIndex, reference] of sourceReferences.entries()) {
    if (typeof reference !== 'string' || !reference) {
      diagnostics.push(diagnostic('invalid-source-reference', `source ${sourceIndex + 1} is not a path`));
      continue;
    }
    if (hasUnsupportedScheme(reference)) {
      diagnostics.push(diagnostic(
        'unsupported-source-scheme',
        `source ${sourceIndex + 1} uses unsupported scheme: ${reference}`,
      ));
      continue;
    }

    const sourceRoot = localPath(consumerPath, reference);
    const sourceKey = pathKey(sourceRoot);
    const previousReference = seenSources.get(sourceKey);
    if (previousReference) {
      diagnostics.push(diagnostic(
        'duplicate-source',
        `source ${sourceIndex + 1} (${reference}) duplicates ${previousReference} at ${sourceRoot}`,
      ));
      continue;
    }
    seenSources.set(sourceKey, `source ${sourceIndex + 1} (${reference})`);

    let sourceRealRoot;
    try {
      sourceRealRoot = await realpath(sourceRoot);
    } catch (error) {
      diagnostics.push(diagnostic('source-read', `${sourceRoot}: ${error.message}`));
      continue;
    }

    const source = await readYaml(join(sourceRoot, 'source.yaml'), 'source-read', diagnostics);
    if (!source) continue;
    let recipes;
    try {
      recipes = await discoverRecipes(sourceRoot);
    } catch (error) {
      diagnostics.push(diagnostic('source-read', `${sourceRoot}: ${error.message}`));
      continue;
    }

    for (const recipeEntry of recipes) {
      const recipeRoot = join(sourceRoot, recipeEntry.folder);
      const recipe = await readYaml(recipeEntry.path, 'recipe-read', diagnostics);
      if (!recipe) continue;
      const recipeId = typeof recipe.id === 'string' && recipe.id ? recipe.id : recipeEntry.folder;
      const steps = Array.isArray(recipe.steps) ? recipe.steps : [];

      for (const [stepIndex, step] of steps.entries()) {
        if (!['file', 'file-fragment'].includes(step?.type)) {
          diagnostics.push(diagnostic(
            'unsupported-step',
            `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: unsupported step type ${step?.type ?? '<missing>'}`,
          ));
          continue;
        }
        const details = {
          source: sourceRoot,
          recipe: recipeId,
          step: stepIndex + 1,
        };
        const input = typeof step.input === 'string' ? step.input : '';
        const inputPath = localPath(recipeRoot, input);
        if (!isInside(sourceRoot, inputPath)) {
          diagnostics.push(diagnostic(
            'source-input-escape',
            `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: input escapes source root: ${input}`,
          ));
          continue;
        }
        const target = typeof step.target === 'string' ? step.target : '';
        const targetPath = localPath(consumerPath, target);
        if (!target || !isInside(consumerPath, targetPath)) {
          diagnostics.push(diagnostic(
            'target-escape',
            `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: target escapes consumer root: ${target}`,
          ));
          continue;
        }

        let targetRealPath;
        try {
          targetRealPath = await realPathWithMissing(targetPath);
        } catch (error) {
          diagnostics.push(diagnostic(
            error.code === 'ERR_TARGET_SYMLINK' ? 'target-escape' : 'target-read',
            `${targetPath}: ${error.message}`,
          ));
          continue;
        }
        if (!isInside(consumerRealPath, targetRealPath)) {
          diagnostics.push(diagnostic(
            'target-escape',
            `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: target resolves outside consumer root: ${target}`,
          ));
          continue;
        }
        const targetKey = pathKey(targetRealPath);
        registerTarget(targetWriters, targetRealPath, step.type === 'file' ? 'file' : 'file-fragment', {
          source: sourceRoot,
          recipe: recipeId,
          step: stepIndex + 1,
        }, diagnostics);

        let inputRealPath;
        try {
          inputRealPath = await realpath(inputPath);
        } catch {
          const content = await readInput(inputPath, details, diagnostics);
          if (content === null) continue;
          inputRealPath = inputPath;
        }
        if (!isInside(sourceRealRoot, inputRealPath)) {
          diagnostics.push(diagnostic(
            'source-input-escape',
            `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: input resolves outside source root: ${input}`,
          ));
          continue;
        }
        const content = await readInput(inputPath, details, diagnostics);
        if (content === null) continue;

        if (step.type === 'file-fragment') {
          const marker = `${basename(sourceRoot)}/${recipeId}`;
          if (seenFragmentMarkers.has(marker)) {
            diagnostics.push(diagnostic(
              'fragment-marker-collision',
              `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: duplicate marker ${marker} at ${targetPath}`,
            ));
            continue;
          }
          seenFragmentMarkers.add(marker);
          if (!fragmentState.has(targetKey)) {
            let existing;
            try {
              existing = await readFile(targetRealPath, 'utf8');
            } catch (error) {
              if (error.code !== 'ENOENT') {
                diagnostics.push(diagnostic('target-read', `${targetPath}: ${error.message}`));
                continue;
              }
            }
            fragmentState.set(targetKey, existing);
          }
          const state = fragmentState.get(targetKey);
          const result = planFragment(state, marker, content);
          if (result.code) {
            diagnostics.push(diagnostic(
              result.code,
              `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: ${result.code} at ${targetPath}`,
            ));
            continue;
          }
          fragmentState.set(targetKey, result.content);
          writes.push({
            kind: 'file-fragment',
            target: targetRealPath,
            content: result.content,
            action: result.action,
            source: sourceRoot,
            recipe: recipeId,
          });
          continue;
        }

        let existing;
        try {
          existing = await readFile(targetRealPath, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') {
            diagnostics.push(diagnostic('target-read', `${targetRealPath}: ${error.message}`));
            continue;
          }
        }
        writes.push({
          kind: 'file',
          target: targetRealPath,
          content,
          action: existing === undefined ? 'create' : existing === content ? 'noop' : 'update',
          source: sourceRoot,
          recipe: recipeId,
        });
        if (existing !== undefined && existing !== content) {
          diagnostics.push(diagnostic(
            'file-drift',
            `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: complete file drift at ${targetRealPath}`,
          ));
        }
      }
    }
  }

  for (const write of writes.filter(({ kind }) => kind === 'file-fragment')) {
    write.content = fragmentState.get(pathKey(write.target));
  }

  return { writes, diagnostics };
}

export async function applyInstall(plan) {
  if (plan.diagnostics.some(({ severity }) => severity === 'error')) return [];
  const applied = [];
  const writtenTargets = new Set();
  for (const write of plan.writes) {
    if (write.action === 'noop' || writtenTargets.has(write.target)) continue;
    await mkdir(dirname(write.target), { recursive: true });
    await writeFile(write.target, write.content, 'utf8');
    writtenTargets.add(write.target);
    applied.push(write);
  }
  return applied;
}
