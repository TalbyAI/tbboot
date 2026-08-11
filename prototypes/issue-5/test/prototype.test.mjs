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
