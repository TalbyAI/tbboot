import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
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

async function invalidVariant(document, mutate) {
  const value = parse(await fixtureText(document));
  mutate(value);
  return stringify(value);
}

function assertSchemaFailure(result, path) {
  assert.equal(result.value, undefined);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every(({ code, severity }) =>
    code === 'schema-validation-failed' && severity === 'error'));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === path),
    JSON.stringify(result.diagnostics));
}

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

test('rejects invalid Source-reference variants', async (t) => {
  const cases = [
    ['unsupported provider', 'manifest', 'manifest.yaml', (value) => {
      value.sources[0].provider = 'ftp';
    }, '/sources/0/provider'],
    ['local locator with Git field', 'manifest', 'manifest.yaml', (value) => {
      value.sources[0].locator.repository = 'https://example.com/team/recipes.git';
    }, '/sources/0/locator/repository'],
    ['unknown nested locator field', 'manifest', 'manifest.yaml', (value) => {
      value.sources[1].locator.pathTypo = 'sources/windows';
    }, '/sources/1/locator/pathTypo'],
    ['absolute Git path', 'manifest', 'manifest.yaml', (value) => {
      value.sources[1].locator.path = 'C:/sources/windows';
    }, '/sources/1/locator/path'],
    ['escaping Git path', 'manifest', 'manifest.yaml', (value) => {
      value.sources[1].locator.path = 'sources/../windows';
    }, '/sources/1/locator/path'],
    ['Git glob', 'manifest', 'manifest.yaml', (value) => {
      value.sources[1].locator.path = 'sources/*';
    }, '/sources/1/locator/path'],
    ['Git selector containing ref plus from and to', 'manifest', 'manifest.yaml', (value) => {
      Object.assign(value.sources[1].selector, { from: 'v1.0.0', to: 'v2.0.0' });
    }, ['/sources/1/selector/from', '/sources/1/selector/to', '/sources/1/selector/ref']],
    ['non-empty local selector', 'manifest', 'manifest.yaml', (value) => {
      value.sources[0].selector = { ref: 'main' };
    }, '/sources/0/selector/ref'],
    ['malformed empty recipe selection', 'manifest', 'manifest.yaml', (value) => {
      value.sources[0].recipes = [''];
    }, '/sources/0/recipes/0'],
  ];

  for (const [name, kind, document, mutate, path] of cases) {
    await t.test(name, async () => {
      const result = validateDocument({
        kind,
        document,
        text: await invalidVariant(document, mutate),
      });
      for (const expectedPath of [path].flat()) assertSchemaFailure(result, expectedPath);
      if (name === 'local locator with Git field') {
        assert.equal(result.diagnostics.some((diagnostic) =>
          diagnostic.path === '/sources/0/provider'), false);
      }
    });
  }
});

test('rejects invalid authored-document variants', async (t) => {
  const cases = [
    ['forbidden Source id', 'source', 'source.yaml', (value) => { value.id = 'source-id'; }, '/id'],
    ['forbidden document-level selector', 'source', 'source.yaml', (value) => {
      value.selector = { ref: 'main' };
    }, '/selector'],
    ['missing dependency alias', 'source', 'source.yaml', (value) => {
      delete value.dependencies[0].name;
    }, '/dependencies/0/name'],
    ['unknown dependency field', 'source', 'source.yaml', (value) => {
      value.dependencies[0].extra = true;
    }, '/dependencies/0/extra'],
    ['forbidden Recipe id', 'recipe', 'recipe.yaml', (value) => { value.id = 'recipe-id'; }, '/id'],
    ['empty ordered Step list', 'recipe', 'recipe.yaml', (value) => { value.steps = []; }, '/steps'],
    ['missing File target', 'recipe', 'recipe.yaml', (value) => {
      delete value.steps[0].target;
    }, '/steps/0/target'],
    ['absolute Source input path', 'recipe', 'recipe.yaml', (value) => {
      value.steps[0].input = 'C:/outside/input.txt';
    }, '/steps/0/input'],
    ['absolute target path', 'recipe', 'recipe.yaml', (value) => {
      value.steps[0].target = 'C:/outside/target.txt';
    }, '/steps/0/target'],
    ['escaping target', 'recipe', 'recipe.yaml', (value) => {
      value.steps[0].target = '../outside/target.txt';
    }, '/steps/0/target'],
    ['configurable File Fragment marker', 'recipe', 'recipe.yaml', (value) => {
      value.steps[1].marker = 'custom-marker';
    }, '/steps/1/marker'],
    ['unsupported Step discriminator', 'recipe', 'recipe.yaml', (value) => {
      value.steps[2].type = 'unsupported';
    }, '/steps/2/type'],
    ['unsupported Custom runtime', 'recipe', 'recipe.yaml', (value) => {
      value.steps[2].check.runtime = 'python';
    }, '/steps/2/check/runtime'],
    ['Custom operation containing both script and content', 'recipe', 'recipe.yaml', (value) => {
      value.steps[2].check.script = 'scripts/check.mjs';
    }, ['/steps/2/check/content', '/steps/2/check/script']],
    ['Custom operation containing neither script nor content', 'recipe', 'recipe.yaml', (value) => {
      delete value.steps[2].check.content;
    }, ['/steps/2/check/script', '/steps/2/check/content']],
    ['absolute Custom script path', 'recipe', 'recipe.yaml', (value) => {
      delete value.steps[2].check.content;
      value.steps[2].check.script = 'C:/outside/check.mjs';
    }, '/steps/2/check/script'],
    ['zero timeout', 'recipe', 'recipe.yaml', (value) => {
      value.steps[2].check.timeoutSeconds = 0;
    }, '/steps/2/check/timeoutSeconds'],
    ['uninstall without install', 'recipe', 'recipe.yaml', (value) => {
      delete value.steps[2].install;
    }, '/steps/2/uninstall'],
    ['malformed empty requirement path', 'recipe', 'recipe.yaml', (value) => {
      value.requires = [{ source: 'shared', recipe: '' }];
    }, '/requires/0/recipe'],
    ['empty catalog title', 'catalog', 'catalog.yaml', (value) => {
      value.entries[0].title = '';
    }, '/entries/0/title'],
    ['duplicate catalog keyword', 'catalog', 'catalog.yaml', (value) => {
      value.entries[0].keywords[1] = value.entries[0].keywords[0];
    }, '/entries/0/keywords/1'],
    ['forbidden catalog entry ID', 'catalog', 'catalog.yaml', (value) => {
      value.entries[0].id = 'entry-id';
    }, '/entries/0/id'],
    ['forbidden catalog Source selection', 'catalog', 'catalog.yaml', (value) => {
      value.entries[0].source.recipes = ['baseline'];
    }, '/entries/0/source/recipes'],
  ];

  for (const [name, kind, document, mutate, path] of cases) {
    await t.test(name, async () => {
      const result = validateDocument({
        kind,
        document,
        text: await invalidVariant(document, mutate),
      });
      for (const expectedPath of [path].flat()) assertSchemaFailure(result, expectedPath);
    });
  }
});

test('reports unknown fields at their actual nested path', async () => {
  const text = await invalidVariant('manifest.yaml', (value) => {
    value.sources[0].locator.soruces = 'typo';
  });
  const result = validateDocument({ kind: 'manifest', text, document: 'tbboot.yaml' });

  assertSchemaFailure(result, '/sources/0/locator/soruces');
  assert.ok(result.diagnostics.some(({ message }) => message === 'Unknown field: soruces'));
});

test('closes the root of every document schema', async () => {
  for (const [kind, document] of Object.entries(validDocuments)) {
    const text = await invalidVariant(document, (value) => {
      value.unexpected = true;
    });
    const result = validateDocument({ kind, text, document });

    assertSchemaFailure(result, '/unexpected');
    assert.ok(result.diagnostics.some(({ message }) => message === 'Unknown field: unexpected'));
  }
});

test('does not leak errors from incompatible union branches', async () => {
  const cases = [
    ['manifest', 'manifest.yaml', (value) => { value.sources[0].provider = 'ftp'; },
      '/sources/0/provider', 'Unsupported provider: ftp'],
    ['recipe', 'recipe.yaml', (value) => { value.steps[0].type = 'unknown'; },
      '/steps/0/type', 'Unsupported type: unknown'],
  ];

  for (const [kind, document, mutate, path, message] of cases) {
    const result = validateDocument({
      kind,
      document,
      text: await invalidVariant(document, mutate),
    });
    assert.deepEqual(
      result.diagnostics.map(({ code, path: actualPath, message: actualMessage }) =>
        ({ code, path: actualPath, message: actualMessage })),
      [{ code: 'schema-validation-failed', path, message }],
    );
  }
});

test('rejects invalid generated and local document variants', async (t) => {
  const cases = [
    ['missing local lock fingerprint', 'lockfile', 'tbboot.lock.yaml', (value) => {
      delete value.sources[0].fingerprint;
    }, '/sources/0/fingerprint'],
    ['revision on local lock entry', 'lockfile', 'tbboot.lock.yaml', (value) => {
      value.sources[0].revision = '8c17f4';
    }, '/sources/0/revision'],
    ['missing Git lock revision', 'lockfile', 'tbboot.lock.yaml', (value) => {
      delete value.sources[1].revision;
    }, '/sources/1/revision'],
    ['missing Git lock fingerprint', 'lockfile', 'tbboot.lock.yaml', (value) => {
      delete value.sources[1].fingerprint;
    }, '/sources/1/fingerprint'],
    ['reserved selection in lock Source', 'lockfile', 'tbboot.lock.yaml', (value) => {
      value.sources[1].source.recipes = ['baseline'];
    }, '/sources/1/source/recipes'],
    ['revision on local effect', 'state', 'state.yaml', (value) => {
      value.effects[0].revision = '8c17f4';
    }, '/effects/0/revision'],
    ['missing Git effect revision', 'state', 'state.yaml', (value) => {
      delete value.effects[1].revision;
    }, '/effects/1/revision'],
    ['missing File ownership flag', 'state', 'state.yaml', (value) => {
      delete value.effects[0].created;
    }, '/effects/0/created'],
    ['missing File Fragment marker', 'state', 'state.yaml', (value) => {
      delete value.effects[1].marker;
    }, '/effects/1/marker'],
    ['missing Custom ownership flag', 'state', 'state.yaml', (value) => {
      delete value.effects[2].uninstallSupported;
    }, '/effects/2/uninstallSupported'],
    ['unknown effect field', 'state', 'state.yaml', (value) => {
      value.effects[0].content = 'unexpected';
    }, '/effects/0/content'],
    ['zero effect step index', 'state', 'state.yaml', (value) => {
      value.effects[0].step = 0;
    }, '/effects/0/step'],
    ['absolute recorded target path', 'state', 'state.yaml', (value) => {
      value.effects[0].target = 'C:/outside/.editorconfig';
    }, '/effects/0/target'],
    ['revision on local trust entry', 'trust', 'trust.yaml', (value) => {
      value.sources[0].revision = '8c17f4';
    }, '/sources/0/revision'],
    ['missing local trust fingerprint', 'trust', 'trust.yaml', (value) => {
      delete value.sources[0].fingerprint;
    }, '/sources/0/fingerprint'],
    ['fingerprint on Git trust entry', 'trust', 'trust.yaml', (value) => {
      value.sources[1].fingerprint = 'sha256:git-content';
    }, '/sources/1/fingerprint'],
    ['missing Git trust revision', 'trust', 'trust.yaml', (value) => {
      delete value.sources[1].revision;
    }, '/sources/1/revision'],
  ];

  for (const [name, kind, document, mutate, path] of cases) {
    await t.test(name, async () => {
      const result = validateDocument({
        kind,
        document,
        text: await invalidVariant(document, mutate),
      });
      assertSchemaFailure(result, path);
    });
  }
});

test('accepts valid Source-reference and authored-document variants', async (t) => {
  const sourceCases = [
    ['local selector', (value) => { value.sources[0].selector = {}; }],
    ['Git ref selector', () => {}],
    ['Git range selector', (value) => { value.sources[1].selector = { from: 'v1.0.0', to: 'v2.0.0' }; }],
  ];
  for (const [name, mutate] of sourceCases) {
    await t.test(name, async () => {
      const result = validateDocument({
        kind: 'manifest',
        document: 'manifest.yaml',
        text: await invalidVariant('manifest.yaml', mutate),
      });
      assert.deepEqual(result.diagnostics, []);
    });
  }

  const stepCases = [
    ['File Step', 0],
    ['File Fragment Step', 1],
    ['Custom Step with content operation', 2],
  ];
  for (const [name, index] of stepCases) {
    await t.test(name, async () => {
      const result = validateDocument({
        kind: 'recipe',
        document: 'recipe.yaml',
        text: await invalidVariant('recipe.yaml', (value) => { value.steps = [value.steps[index]]; }),
      });
      assert.deepEqual(result.diagnostics, []);
    });
  }

  await t.test('Custom Step with script operation', () => {
    const text = stringify({
      schemaVersion: 1,
      steps: [{ type: 'custom', check: { runtime: 'node', script: 'scripts/check.mjs' } }],
    });
    assert.deepEqual(validateDocument({ kind: 'recipe', document: 'recipe.yaml', text }).diagnostics, []);
  });
});

test('accepts generated and authored empty arrays where permitted', () => {
  const cases = [
    ['catalog', { schemaVersion: 1, entries: [] }],
    ['lockfile', { schemaVersion: 1, sources: [] }],
    ['trust', { schemaVersion: 1, sources: [] }],
    ['state', { schemaVersion: 1, effects: [] }],
    ['source', { schemaVersion: 1, dependencies: [] }],
  ];

  for (const [kind, value] of cases) {
    const result = validateDocument({ kind, document: `${kind}.yaml`, text: stringify(value) });
    assert.deepEqual(result.diagnostics, [], kind);
  }
});

test('accepts every provider and effect-type combination', () => {
  const sources = {
    local: { provider: 'local', locator: { path: '../shared-source' } },
    git: { provider: 'git', locator: { repository: 'https://example.com/team/recipes.git' } },
  };
  const fields = {
    file: { target: '.editorconfig', artifactFingerprint: 'sha256:file', created: true },
    'file-fragment': { target: 'AGENTS.md', marker: 'source/recipe', artifactFingerprint: 'sha256:fragment' },
    custom: { uninstallSupported: true },
  };

  for (const provider of ['local', 'git']) {
    for (const type of ['file', 'file-fragment', 'custom']) {
      const effect = {
        type,
        source: sources[provider],
        sourceFingerprint: 'sha256:source',
        recipe: 'baseline',
        step: 1,
        ...(provider === 'git' ? { revision: '8c17f4' } : {}),
        ...fields[type],
      };
      const result = validateDocument({
        kind: 'state',
        document: 'state.yaml',
        text: stringify({ schemaVersion: 1, effects: [effect] }),
      });

      assert.deepEqual(result.diagnostics, [], `${provider}/${type}`);
    }
  }
});

test('adds available Source Recipe and one-based Step context', async () => {
  const text = await invalidVariant('recipe.yaml', (value) => {
    value.steps[1].target = 42;
  });
  const result = validateDocument({
    kind: 'recipe',
    text,
    document: 'recipe.yaml',
    source: 'team-recipes',
    recipe: 'baseline',
  });
  const diagnostic = result.diagnostics.find(({ path }) => path === '/steps/1/target');

  assert.deepEqual(
    { document: diagnostic.document, source: diagnostic.source, recipe: diagnostic.recipe, step: diagnostic.step },
    { document: 'recipe.yaml', source: 'team-recipes', recipe: 'baseline', step: 2 },
  );
});

test('omits unavailable context from parse errors', () => {
  const result = validateDocument({ kind: 'manifest', text: 'schemaVersion: [1\n' });
  const diagnostic = result.diagnostics[0];

  assert.equal(diagnostic.code, 'yaml-parse-error');
  for (const field of ['source', 'recipe', 'step', 'path']) {
    assert.equal(field in diagnostic, false, field);
  }
});
