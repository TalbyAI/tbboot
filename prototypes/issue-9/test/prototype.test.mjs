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

test('rejects YAML and version failures at the earliest gate', () => {
  const cases = [
    ['empty input', '', 'yaml-parse-error', undefined, undefined],
    ['whitespace input', '  \n', 'yaml-parse-error', undefined, undefined],
    ['syntax error', 'schemaVersion: [1\n', 'yaml-parse-error', undefined, undefined],
    ['duplicate key', 'schemaVersion: 1\nschemaVersion: 1\n', 'yaml-parse-error', undefined, undefined],
    ['multiple documents', 'schemaVersion: 1\nsources: []\n---\nschemaVersion: 1\nsources: []\n', 'yaml-parse-error', undefined, undefined],
    ['missing version', 'sources: []\n', 'schema-version-missing', '/schemaVersion',
      'Missing required schemaVersion'],
    ['unsupported numeric version', 'schemaVersion: 2\nsources: []\n', 'schema-version-unsupported',
      '/schemaVersion', 'Unsupported schemaVersion: 2'],
    ['unsupported scalar version', 'schemaVersion: one\nsources: []\n', 'schema-version-unsupported',
      '/schemaVersion', 'Unsupported schemaVersion: "one"'],
  ];

  for (const [name, text, code, path, message] of cases) {
    const result = validateDocument({ kind: 'manifest', text, document: 'tbboot.yaml' });
    assert.equal(result.value, undefined, name);
    assert.equal(result.diagnostics.length, 1, name);
    assert.equal(result.diagnostics[0].code, code, name);
    assert.equal(result.diagnostics[0].document, 'tbboot.yaml', name);
    if (path === undefined) {
      assert.equal('path' in result.diagnostics[0], false, name);
    } else {
      assert.equal(result.diagnostics[0].path, path, name);
    }
    if (message !== undefined) assert.equal(result.diagnostics[0].message, message, name);
  }
});

test('rejects cyclic schemaVersion without throwing', () => {
  const result = validateDocument({
    kind: 'manifest',
    text: 'schemaVersion: &v\n  self: *v\n',
    document: 'tbboot.yaml',
  });

  assert.equal(result.value, undefined);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'schema-version-unsupported');
  assert.equal(result.diagnostics[0].document, 'tbboot.yaml');
  assert.equal(result.diagnostics[0].path, '/schemaVersion');
});

test('rejects explicit YAML 1.1 directives', () => {
  const result = validateDocument({
    kind: 'manifest',
    text: '%YAML 1.1\n---\nschemaVersion: 1\n',
    document: 'tbboot.yaml',
  });

  assert.equal(result.value, undefined);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'yaml-parse-error');
  assert.equal(result.diagnostics[0].document, 'tbboot.yaml');
  assert.equal('path' in result.diagnostics[0], false);
});
