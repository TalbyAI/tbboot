import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixtureConsumer } from './support.mjs';
import { applyInstall, planInstall } from '../proposed/core.mjs';

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
