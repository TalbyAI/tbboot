import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateDocument } from '../validate.mjs';

const validDocuments = {
  manifest: 'manifest.yaml',
  source: 'source.yaml',
  recipe: 'recipe.yaml',
  catalog: 'catalog.yaml',
  lockfile: 'tbboot.lock.yaml',
  state: 'state.yaml',
  trust: 'trust.yaml',
};

const fixtureUrl = (name) => new URL(`../fixture/valid/${name}`, import.meta.url);
const fixtureText = (name) => readFile(fixtureUrl(name), 'utf8');

test('accepts all seven canonical documents', async () => {
  for (const [kind, document] of Object.entries(validDocuments)) {
    const result = validateDocument({
      kind,
      document,
      text: await fixtureText(document),
    });
    assert.deepEqual(result.diagnostics, [], `${document}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.value.schemaVersion, 1);
  }
});
