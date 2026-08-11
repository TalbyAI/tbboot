import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
    const previousReference = seenSources.get(sourceRoot);
    if (previousReference) {
      diagnostics.push(diagnostic(
        'duplicate-source',
        `source ${sourceIndex + 1} (${reference}) duplicates ${previousReference} at ${sourceRoot}`,
      ));
      continue;
    }
    seenSources.set(sourceRoot, `source ${sourceIndex + 1} (${reference})`);

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
        if (!['file', 'file-fragment'].includes(step?.type)) continue;
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
          if (!fragmentState.has(targetPath)) {
            let existing;
            try {
              existing = await readFile(targetPath, 'utf8');
            } catch (error) {
              if (error.code !== 'ENOENT') {
                diagnostics.push(diagnostic('target-read', `${targetPath}: ${error.message}`));
                continue;
              }
            }
            fragmentState.set(targetPath, existing);
          }
          const state = fragmentState.get(targetPath);
          const result = planFragment(state, marker, content);
          if (result.code) {
            diagnostics.push(diagnostic(
              result.code,
              `${sourceRoot}, recipe ${recipeId}, step ${stepIndex + 1}: ${result.code} at ${targetPath}`,
            ));
            continue;
          }
          fragmentState.set(targetPath, result.content);
          writes.push({
            kind: 'file-fragment',
            target: targetPath,
            content: result.content,
            action: result.action,
            source: sourceRoot,
            recipe: recipeId,
          });
          continue;
        }

        let existing;
        try {
          existing = await readFile(targetPath, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') {
            diagnostics.push(diagnostic('target-read', `${targetPath}: ${error.message}`));
            continue;
          }
        }
        writes.push({
          kind: 'file',
          target: targetPath,
          content,
          action: existing === undefined ? 'create' : existing === content ? 'noop' : 'update',
          source: sourceRoot,
          recipe: recipeId,
        });
      }
    }
  }

  for (const write of writes.filter(({ kind }) => kind === 'file-fragment')) {
    write.content = fragmentState.get(write.target);
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
