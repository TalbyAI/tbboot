import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureConsumer } from './support.mjs';
import { applyInstall, planInstall } from '../proposed/core.mjs';

const cliPath = fileURLToPath(new URL('../proposed/cli.mjs', import.meta.url));

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const baselineRecipe = `id: baseline
steps:
  - type: file
    input: ../shared/editorconfig
    target: .editorconfig
  - type: file
    input: files/project-guide.md
    target: docs/project-guide.md
  - type: file-fragment
    input: files/agents-block.md
    target: AGENTS.md
`;

test('installs shared and recipe-local complete files', async () => {
  const { consumerRoot } = await fixtureConsumer();
  const plan = await planInstall(consumerRoot);

  assert.deepEqual(plan.diagnostics, []);
  await applyInstall(plan);

  assert.equal(await readFile(consumerRoot + '/.editorconfig', 'utf8'),
    'root = true\n\n[*]\ncharset = utf-8\n');
  assert.equal(await readFile(consumerRoot + '/docs/project-guide.md', 'utf8'),
    '# Project setup\n\nThis file came from a recipe-local source input.\n');
});

test('installs distinct managed fragments and is idempotent', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await applyInstall(await planInstall(consumerRoot));
  const first = await readFile(consumerRoot + '/AGENTS.md', 'utf8');

  const secondPlan = await planInstall(consumerRoot);
  assert.deepEqual(secondPlan.diagnostics, []);
  assert.ok(secondPlan.writes
    .filter(({ kind }) => kind === 'file-fragment')
    .every(({ action }) => action === 'noop'));
  await applyInstall(secondPlan);

  assert.equal(await readFile(consumerRoot + '/AGENTS.md', 'utf8'), first);
  assert.match(first, /managed-by: source\/baseline/);
  assert.match(first, /managed-by: source\/review/);
  assert.match(first, /Keep this unmanaged text\./);
});

test('rejects duplicate normalized source references before writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await writeFile(consumerRoot + '/manifest.yaml',
    'sources:\n  - ../source\n  - ./../source\n');
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'duplicate-source'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('rejects unsupported source schemes before writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await writeFile(consumerRoot + '/manifest.yaml',
    'sources:\n  - https://example.test/source\n');
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'unsupported-source-scheme'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('rejects source input escapes before writing', async () => {
  const { consumerRoot, root } = await fixtureConsumer();
  await writeFile(root + '/source/01-baseline/recipe.yaml',
    baselineRecipe.replace('input: files/project-guide.md', 'input: ../../outside.md'));
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'source-input-escape'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('rejects target escapes before writing (Windows absolute path)', async () => {
  const { consumerRoot, root } = await fixtureConsumer();
  await writeFile(root + '/source/01-baseline/recipe.yaml',
    baselineRecipe.replace('target: docs/project-guide.md', 'target: ../outside.md'));
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'target-escape'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);

  // The prototype is Windows-only; this case preserves Windows absolute-path semantics.
  await writeFile(root + '/source/01-baseline/recipe.yaml',
    baselineRecipe.replace('target: docs/project-guide.md', "target: 'C:\\outside.md'"));
  const absolutePlan = await planInstall(consumerRoot);
  assert.ok(absolutePlan.diagnostics.some(({ code }) => code === 'target-escape'));
  await applyInstall(absolutePlan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('rejects two complete file steps sharing a target', async () => {
  const { consumerRoot, root } = await fixtureConsumer();
  await writeFile(root + '/source/01-baseline/recipe.yaml', `id: baseline
steps:
  - type: file
    input: ../shared/editorconfig
    target: same.txt
  - type: file
    input: files/project-guide.md
    target: SAME.TXT
`);
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'file-target-collision'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/same.txt'), false);
});

test('rejects unsupported step types before writing', async () => {
  const { consumerRoot, root } = await fixtureConsumer();
  await writeFile(root + '/source/01-baseline/recipe.yaml', `id: baseline
steps:
  - type: script
    command: echo unsafe
`);
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'unsupported-step'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('rejects target symlinks that escape the consumer root', async (t) => {
  const { consumerRoot, root } = await fixtureConsumer();
  const outside = root + '/outside-target';
  const link = consumerRoot + '/linked';
  await writeFile(root + '/source/01-baseline/recipe.yaml',
    baselineRecipe.replace('target: docs/project-guide.md', 'target: linked/outside.md'));
  await mkdir(outside);
  try {
    await symlink(outside, link, 'junction');
  } catch (error) {
    t.skip(`junctions unavailable: ${error.code}`);
    return;
  }
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'target-escape'));
  await applyInstall(plan);
  assert.equal(await exists(outside + '/outside.md'), false);
});

test('rejects dangling target symlinks before writing', async (t) => {
  const { consumerRoot, root } = await fixtureConsumer();
  const link = consumerRoot + '/dangling.md';
  await writeFile(root + '/source/01-baseline/recipe.yaml',
    baselineRecipe.replace('target: docs/project-guide.md', 'target: dangling.md'));
  try {
    await symlink(root + '/outside/missing.md', link, 'file');
  } catch (error) {
    t.skip(`file symlinks unavailable: ${error.code}`);
    return;
  }
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'target-escape'));
  await applyInstall(plan);
  assert.equal(await exists(root + '/outside/missing.md'), false);
});

test('rejects a complete file and fragment sharing a target', async () => {
  const { consumerRoot, root } = await fixtureConsumer();
  await writeFile(root + '/source/01-baseline/recipe.yaml', `id: baseline
steps:
  - type: file
    input: ../shared/editorconfig
    target: AGENTS.md
  - type: file-fragment
    input: files/agents-block.md
    target: AGENTS.md
`);
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'file-target-collision'));
  await applyInstall(plan);
  assert.equal((await readFile(consumerRoot + '/AGENTS.md', 'utf8')).includes('Baseline rules'), false);
});

test('rejects modified complete files without overwriting them', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await applyInstall(await planInstall(consumerRoot));
  await writeFile(consumerRoot + '/.editorconfig', 'local change\n');
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'file-drift'));
  await applyInstall(plan);
  assert.equal(await readFile(consumerRoot + '/.editorconfig', 'utf8'), 'local change\n');
});

test('rejects modified managed fragments without overwriting them', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await applyInstall(await planInstall(consumerRoot));
  const path = consumerRoot + '/AGENTS.md';
  await writeFile(path, (await readFile(path, 'utf8')).replace(
    'Run the repository checks',
    'Run different checks',
  ));
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'fragment-drift'));
  await applyInstall(plan);
  assert.match(await readFile(path, 'utf8'), /Run different checks/);
});

test('rejects incomplete managed fragments before writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await applyInstall(await planInstall(consumerRoot));
  const path = consumerRoot + '/AGENTS.md';
  await writeFile(path, (await readFile(path, 'utf8')).replace(
    '<!-- end-managed-by: source/baseline -->\n',
    '',
  ));
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'incomplete-fragment'));
  await applyInstall(plan);
  assert.equal((await readFile(path, 'utf8')).includes('end-managed-by: source/baseline'), false);
});

test('rejects duplicate managed fragment markers before writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await applyInstall(await planInstall(consumerRoot));
  const path = consumerRoot + '/AGENTS.md';
  const content = await readFile(path, 'utf8');
  const start = content.indexOf('<!-- managed-by: source/baseline -->');
  const end = content.indexOf('<!-- end-managed-by: source/baseline -->')
    + '<!-- end-managed-by: source/baseline -->'.length;
  await writeFile(path, `${content}\n${content.slice(start, end)}\n`);
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'fragment-marker-collision'));
  await applyInstall(plan);
  assert.equal((await readFile(path, 'utf8')).split('<!-- managed-by: source/baseline -->').length - 1, 2);
});

test('reports all preflight errors before writing', async () => {
  const { consumerRoot, root } = await fixtureConsumer();
  const original = await readFile(consumerRoot + '/AGENTS.md', 'utf8');
  await writeFile(consumerRoot + '/manifest.yaml', `sources:
  - https://example.test/source
  - ../source
  - ./../source
`);
  await writeFile(root + '/source/01-baseline/recipe.yaml', `id: baseline
steps:
  - type: file
    input: ../../outside.md
    target: docs/outside.md
  - type: file
    input: ../shared/editorconfig
    target: ../outside.md
`);
  const plan = await planInstall(consumerRoot);
  const codes = new Set(plan.diagnostics.map(({ code }) => code));

  assert.deepEqual(
    [...codes].filter((code) => [
      'unsupported-source-scheme',
      'duplicate-source',
      'source-input-escape',
      'target-escape',
    ].includes(code)).sort(),
    ['duplicate-source', 'source-input-escape', 'target-escape', 'unsupported-source-scheme'],
  );
  await applyInstall(plan);
  assert.equal(await readFile(consumerRoot + '/AGENTS.md', 'utf8'), original);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('doctor reports the plan without writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  const before = await readFile(consumerRoot + '/AGENTS.md', 'utf8');
  const result = await runCli(['doctor', '--root', consumerRoot]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /create .*\.editorconfig/);
  assert.equal(await readFile(consumerRoot + '/AGENTS.md', 'utf8'), before);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('install dry-run reports the plan without writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  const result = await runCli(['install', '--dry-run', '--root', consumerRoot]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /create .*\.editorconfig/);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('install applies a clean plan', async () => {
  const { consumerRoot } = await fixtureConsumer();
  const result = await runCli(['install', '--root', consumerRoot]);

  assert.equal(result.code, 0);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), true);
  assert.equal(await exists(consumerRoot + '/docs/project-guide.md'), true);
});

test('install reports preflight errors without writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await writeFile(consumerRoot + '/manifest.yaml',
    'sources:\n  - ../source\n  - ./../source\n');
  const result = await runCli(['install', '--root', consumerRoot]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /error \[duplicate-source\]/);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});

test('CLI rejects invalid usage', async () => {
  const result = await runCli(['doctor']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--root/);
});
