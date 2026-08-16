import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseJsonOutput, runCommand } from '../prototypes/issue-12/harness.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'src', 'cli.ts');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let installedRoot;
let installedBinPromise;

function commandFor(file, args) {
  if (process.platform !== 'win32') return { file, args };
  const quote = (value) => {
    const text = String(value);
    return /\s/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', [file, ...args].map(quote).join(' ')],
  };
}

function installedBin() {
  if (!installedBinPromise) {
    installedBinPromise = (async () => {
      installedRoot = await mkdtemp(join(tmpdir(), 'tbboot-installed-'));
      const result = await runCommand({
        ...commandFor(npmCommand, [
          'install', '--prefix', installedRoot, '--no-save', '--ignore-scripts',
          '--no-audit', '--no-fund', '--package-lock=false', projectRoot,
        ]),
        cwd: projectRoot,
      });
      assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
      return join(installedRoot, 'node_modules', '.bin',
        process.platform === 'win32' ? 'tbboot.cmd' : 'tbboot');
    })();
  }
  return installedBinPromise;
}

async function runCli(args, options = {}) {
  const bin = await installedBin();
  return runCommand({
    ...commandFor(bin, args),
    cwd: projectRoot,
    ...options,
  });
}

test.after(async () => {
  if (installedRoot) await rm(installedRoot, { recursive: true, force: true });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'tbboot-issue-13-'));
  const consumerRoot = join(root, 'consumer');
  const sourceRoot = join(root, 'source');
  const recipeRoot = join(sourceRoot, 'baseline');
  await mkdir(join(consumerRoot, 'generated'), { recursive: true });
  await mkdir(join(recipeRoot, 'files'), { recursive: true });
  await writeFile(join(consumerRoot, 'tbboot.yaml'), [
    'schemaVersion: 1',
    'sources:',
    '  - provider: local',
    '    locator:',
    '      path: ../source',
    '',
  ].join('\n'));
  await writeFile(join(sourceRoot, 'source.yaml'), 'schemaVersion: 1\n');
  await writeFile(join(recipeRoot, 'recipe.yaml'), [
    'schemaVersion: 1',
    'steps:',
    '  - type: file',
    '    input: files/hello.txt',
    '    target: generated/hello.txt',
    '',
  ].join('\n'));
  await writeFile(join(recipeRoot, 'files', 'hello.txt'), 'hello\n');
  await writeFile(join(consumerRoot, 'generated', 'hello.txt'), 'hello\n');
  return {
    root,
    consumerRoot,
    sourceRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function writeRecipe(sourceRoot, recipe, steps) {
  const recipeRoot = join(sourceRoot, recipe);
  await mkdir(recipeRoot, { recursive: true });
  await writeFile(join(recipeRoot, 'recipe.yaml'), [
    'schemaVersion: 1',
    'steps:',
    ...steps.flatMap((step) => [
      `  - type: ${step.type ?? 'file'}`,
      ...(step.input === undefined ? [] : [`    input: ${step.input}`]),
      ...(step.target === undefined ? [] : [`    target: ${step.target}`]),
      ...(step.optional === true ? ['    optional: true'] : []),
      ...(step.type === 'custom' ? ['    check:', '      runtime: node', '      content: "return;"'] : []),
    ]),
    '',
  ].join('\n'));
  for (const [index, step] of steps.entries()) {
    if (step.input !== undefined && step.inputContent !== undefined) {
      const inputPath = join(recipeRoot, step.input);
      await mkdir(dirname(inputPath), { recursive: true });
      await writeFile(inputPath, step.inputContent);
    }
    if (step.input !== undefined && step.inputMissing === true) {
      await rm(join(recipeRoot, step.input), { force: true });
    }
    void index;
  }
}

async function runDoctor(fixture, ...args) {
  const result = await runCli([
    'doctor', '--json', '--root', fixture.consumerRoot, ...args,
  ]);
  assert.equal(result.stderr, '');
  return { result, envelope: parseJsonOutput(result.stdout) };
}

async function snapshotTree(...roots) {
  const snapshot = [];
  async function visit(root, current) {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) {
        snapshot.push({ root, path, kind: 'directory' });
        await visit(root, absolute);
      } else {
        snapshot.push({ root, path, kind: 'file', bytes: await readFile(absolute) });
      }
    }
  }
  for (const root of roots) await visit(root, root);
  return snapshot.sort((left, right) => {
    const a = `${left.root}/${left.path}`;
    const b = `${right.root}/${right.path}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

test('unknown arguments return 2 and print usage only on stderr', async () => {
  const result = await runCli(['doctor', '--unknown']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: tbboot doctor/);
});

test('invalid YAML returns one JSON diagnostic and no stderr', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), 'schemaVersion: [\n');
    const result = await runCli(['doctor', '--json', '--root', fixture.consumerRoot]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    const envelope = parseJsonOutput(result.stdout);
    assert.equal(envelope.status, 'error');
    assert.deepEqual(envelope.diagnostics.map(({ code }) => code), ['yaml-parse-error']);
    assert.equal(envelope.diagnostics[0].document, 'tbboot.yaml');
  } finally {
    await fixture.cleanup();
  }
});

test('valid canonical fixture compiles and validates without contract errors', async () => {
  const fixture = await createFixture();
  try {
    const result = await runCli(['doctor', '--json', '--root', fixture.consumerRoot]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const envelope = parseJsonOutput(result.stdout);
    assert.equal(envelope.status, 'ok');
    assert.equal(envelope.changed, false);
    assert.equal(envelope.diagnostics.some(({ code }) => code === 'schema-validation-failed'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('linked CLI entrypoint resolves its real path before invoking main', async (t) => {
  const fixture = await createFixture();
  const linkRoot = await mkdtemp(join(tmpdir(), 'tbboot-link-'));
  try {
    const link = join(linkRoot, 'cli.ts');
    try {
      await symlink(cliPath, link);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('symlinks are not available in this environment');
        return;
      }
      throw error;
    }
    const result = await runCommand({
      file: process.execPath,
      args: [link, 'doctor', '--json', '--root', fixture.consumerRoot],
      cwd: projectRoot,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(parseJsonOutput(result.stdout).status, 'ok');
  } finally {
    await rm(linkRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test('discovers only first-level Recipes in lexical order and preserves Step order', async () => {
  const fixture = await createFixture();
  try {
    await rm(join(fixture.sourceRoot, 'baseline'), { recursive: true });
    await writeRecipe(fixture.sourceRoot, 'zulu', [
      { input: 'files/one.txt', inputContent: 'one\n', target: 'generated/zulu-one.txt' },
      { input: 'files/two.txt', inputContent: 'two\n', target: 'generated/zulu-two.txt' },
    ]);
    await writeRecipe(fixture.sourceRoot, 'alpha', [
      { input: 'files/one.txt', inputContent: 'one\n', target: 'generated/alpha.txt' },
    ]);
    await mkdir(join(fixture.sourceRoot, 'nested', 'child'), { recursive: true });
    await writeFile(join(fixture.sourceRoot, 'nested', 'child', 'recipe.yaml'), 'schemaVersion: 1\nsteps: []\n');

    const { envelope } = await runDoctor(fixture);
    assert.deepEqual(envelope.actions.map(({ recipe, step }) => `${recipe}/${step}`), [
      'alpha/1', 'zulu/1', 'zulu/2',
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('rejects unsupported providers and duplicate normalized local Sources', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), [
      'schemaVersion: 1',
      'sources:',
      '  - provider: git',
      '    locator:',
      '      repository: https://example.invalid/recipes.git',
      '  - provider: local',
      '    locator:',
      '      path: ../source',
      '  - provider: local',
      '    locator:',
      '      path: ./../source',
      '',
    ].join('\n'));
    const { result, envelope } = await runDoctor(fixture);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(envelope.diagnostics.map(({ code }) => code), [
      'unsupported-source-provider', 'duplicate-source',
    ]);
    assert.equal(envelope.diagnostics[0].path, '/sources/0/provider');
    assert.equal(envelope.diagnostics[1].path, '/sources/2/locator/path');
  } finally {
    await fixture.cleanup();
  }
});

test('missing input is a conflict and optional missing input is a warning', async () => {
  const fixture = await createFixture();
  try {
    await rm(join(fixture.sourceRoot, 'baseline', 'files', 'hello.txt'));
    const { result, envelope } = await runDoctor(fixture);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(envelope.actions.map(({ state }) => state), ['conflict']);
    assert.equal(envelope.diagnostics[0].code, 'source-input-missing');

    await writeFile(join(fixture.sourceRoot, 'baseline', 'recipe.yaml'), [
      'schemaVersion: 1',
      'steps:',
      '  - type: file',
      '    input: files/hello.txt',
      '    target: generated/hello.txt',
      '    optional: true',
      '',
    ].join('\n'));
    const optional = await runDoctor(fixture);
    assert.equal(optional.result.exitCode, 0);
    assert.equal(optional.envelope.status, 'warning');
    assert.equal(optional.envelope.diagnostics[0].severity, 'warning');
  } finally {
    await fixture.cleanup();
  }
});

test('unsupported Custom Steps produce no action and follow optionality', async () => {
  const fixture = await createFixture();
  try {
    await writeRecipe(fixture.sourceRoot, 'custom', [
      { type: 'custom', optional: true },
    ]);
    const { result, envelope } = await runDoctor(fixture);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.status, 'warning');
    assert.equal(envelope.actions.length, 1);
    assert.equal(envelope.diagnostics.at(-1).code, 'unsupported-step');
    assert.equal(envelope.diagnostics.at(-1).severity, 'warning');
  } finally {
    await fixture.cleanup();
  }
});

test('rejects input and target symlink escapes', async (t) => {
  const fixture = await createFixture();
  try {
    const outsideRoot = join(fixture.root, 'outside');
    await mkdir(outsideRoot, { recursive: true });
    try {
      await writeFile(join(outsideRoot, 'input.txt'), 'outside\n');
      await symlink(
        join(outsideRoot, 'input.txt'),
        join(fixture.sourceRoot, 'baseline', 'files', 'outside-link.txt'),
      );
      await writeFile(join(outsideRoot, 'target.txt'), 'outside\n');
      await symlink(
        join(outsideRoot, 'target.txt'),
        join(fixture.consumerRoot, 'generated', 'outside-link.txt'),
      );
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('symlinks are not available in this environment');
        return;
      }
      throw error;
    }

    await writeRecipe(fixture.sourceRoot, 'escape', [
      { input: 'files/outside-link.txt', target: 'generated/escape-input.txt' },
      { input: 'files/hello.txt', inputContent: 'hello\n', target: 'generated/outside-link.txt' },
    ]);
    await symlink(
      join(outsideRoot, 'input.txt'),
      join(fixture.sourceRoot, 'escape', 'files', 'outside-link.txt'),
    );
    const { result, envelope } = await runDoctor(fixture);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(envelope.diagnostics.map(({ code }) => code), [
      'source-input-escape', 'target-escape',
    ]);
    assert.deepEqual(envelope.actions
      .filter(({ recipe }) => recipe === 'escape')
      .map(({ state }) => state), ['conflict', 'conflict']);
  } finally {
    await fixture.cleanup();
  }
});

test('reserved selections and closed fields stop before Source discovery', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), [
      'schemaVersion: 1',
      'sources:',
      '  - provider: local',
      '    locator:',
      '      path: ../source',
      '    recipes: []',
      'unexpected: true',
      '',
    ].join('\n'));
    const { result, envelope } = await runDoctor(fixture);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(envelope.diagnostics.map(({ code }) => code), ['schema-validation-failed']);
    assert.equal(envelope.actions.length, 0);
    assert.equal(envelope.diagnostics.some(({ code }) => code === 'source-read'), false);

    await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), [
      'schemaVersion: 1',
      'sources:',
      '  - provider: local',
      '    locator:',
      '      path: ../source',
      '    recipes: []',
      '',
    ].join('\n'));
    const reserved = await runDoctor(fixture);
    assert.deepEqual(reserved.envelope.diagnostics.map(({ code }) => code), ['recipes-empty']);
  } finally {
    await fixture.cleanup();
  }
});

test('File states are satisfied, missing, or drift with required severity', async () => {
  const fixture = await createFixture();
  try {
    const satisfied = await runDoctor(fixture);
    assert.equal(satisfied.result.exitCode, 0);
    assert.deepEqual(satisfied.envelope.actions.map(({ state }) => state), ['satisfied']);

    await rm(join(fixture.consumerRoot, 'generated', 'hello.txt'));
    const missing = await runDoctor(fixture);
    assert.equal(missing.result.exitCode, 1);
    assert.deepEqual(missing.envelope.actions.map(({ state }) => state), ['missing']);
    assert.deepEqual(missing.envelope.diagnostics.map(({ code }) => code), ['file-missing']);

    await writeFile(join(fixture.consumerRoot, 'generated', 'hello.txt'), 'drifted\n');
    const drift = await runDoctor(fixture);
    assert.equal(drift.result.exitCode, 1);
    assert.deepEqual(drift.envelope.actions.map(({ state }) => state), ['drift']);
    assert.deepEqual(drift.envelope.diagnostics.map(({ code }) => code), ['file-drift']);
  } finally {
    await fixture.cleanup();
  }
});

test('File and File Fragment writers sharing a target all conflict', async () => {
  const fixture = await createFixture();
  try {
    await writeRecipe(fixture.sourceRoot, 'file-writer', [
      { input: 'files/content.txt', inputContent: 'file\n', target: 'generated/shared.txt' },
    ]);
    await writeRecipe(fixture.sourceRoot, 'fragment-writer', [
      { type: 'file-fragment', input: 'files/content.txt', inputContent: 'fragment\n', target: 'generated/shared.txt' },
    ]);
    const { result, envelope } = await runDoctor(fixture);
    assert.equal(result.exitCode, 1);
    const participants = envelope.actions.filter(({ target }) => target === 'generated/shared.txt');
    assert.deepEqual(participants.map(({ state }) => state), ['conflict', 'conflict']);
    assert.deepEqual(
      envelope.diagnostics.filter(({ code }) => code === 'file-target-collision').map(({ recipe }) => recipe),
      ['file-writer', 'fragment-writer'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('File Fragment normalizes line endings and detects missing, drift, and satisfied blocks', async () => {
  const fixture = await createFixture();
  try {
    const input = 'alpha\r\nbeta';
    await writeRecipe(fixture.sourceRoot, 'fragment', [
      { type: 'file-fragment', input: 'files/fragment.txt', inputContent: input, target: 'AGENTS.md' },
    ]);
    const missing = await runDoctor(fixture);
    assert.equal(missing.result.exitCode, 1);
    assert.deepEqual(missing.envelope.actions.filter(({ recipe }) => recipe === 'fragment')
      .map(({ state }) => state), ['missing']);
    assert.deepEqual(missing.envelope.diagnostics.filter(({ recipe }) => recipe === 'fragment')
      .map(({ code }) => code), ['fragment-missing']);

    await writeFile(join(fixture.consumerRoot, 'AGENTS.md'), [
      'before',
      '<!-- managed-by: source/fragment -->',
      'alpha',
      'beta',
      '<!-- end-managed-by: source/fragment -->',
      'after',
      '',
    ].join('\r\n'));
    const satisfied = await runDoctor(fixture);
    assert.equal(satisfied.result.exitCode, 0);
    assert.equal(satisfied.envelope.actions.find(({ recipe }) => recipe === 'fragment').state, 'satisfied');

    await writeFile(join(fixture.consumerRoot, 'AGENTS.md'), [
      'before',
      '<!-- managed-by: source/fragment -->',
      'changed',
      '<!-- end-managed-by: source/fragment -->',
      'after',
    ].join('\n'));
    const drift = await runDoctor(fixture);
    assert.equal(drift.result.exitCode, 1);
    assert.equal(drift.envelope.actions.find(({ recipe }) => recipe === 'fragment').state, 'drift');
    assert.equal(drift.envelope.diagnostics.find(({ recipe }) => recipe === 'fragment').code, 'fragment-drift');
  } finally {
    await fixture.cleanup();
  }
});

test('File Fragment structural failures conflict and distinct markers may share a target', async () => {
  const fixture = await createFixture();
  try {
    await writeRecipe(fixture.sourceRoot, 'fragment', [
      { type: 'file-fragment', input: 'files/fragment.txt', inputContent: 'body\n', target: 'AGENTS.md' },
    ]);
    await writeFile(join(fixture.consumerRoot, 'AGENTS.md'), [
      '<!-- managed-by: source/fragment -->',
      'body',
      '<!-- end-managed-by: source/fragment -->',
      '<!-- managed-by: source/fragment -->',
      'body',
      '<!-- end-managed-by: source/fragment -->',
    ].join('\n'));
    const duplicate = await runDoctor(fixture);
    assert.equal(duplicate.result.exitCode, 1);
    assert.equal(duplicate.envelope.actions.find(({ recipe }) => recipe === 'fragment').state, 'conflict');
    assert.deepEqual(duplicate.envelope.diagnostics.filter(({ recipe }) => recipe === 'fragment')
      .map(({ code }) => code), ['fragment-marker-collision']);

    await writeFile(join(fixture.consumerRoot, 'AGENTS.md'), [
      '<!-- managed-by: source/fragment -->',
      'body',
    ].join('\n'));
    const incomplete = await runDoctor(fixture);
    assert.equal(incomplete.envelope.actions.find(({ recipe }) => recipe === 'fragment').state, 'conflict');
    assert.equal(incomplete.envelope.diagnostics.find(({ recipe }) => recipe === 'fragment').code, 'incomplete-fragment');

    await writeFile(join(fixture.consumerRoot, 'AGENTS.md'),
      'ordinary <!-- managed-by: source/fragment --> text\n');
    const inline = await runDoctor(fixture);
    assert.equal(inline.envelope.actions.find(({ recipe }) => recipe === 'fragment').state, 'missing');
    assert.equal(inline.envelope.diagnostics.find(({ recipe }) => recipe === 'fragment').code, 'fragment-missing');

    await writeFile(join(fixture.consumerRoot, 'AGENTS.md'), [
      '<!-- managed-by: source/fragment -->',
      'body',
      '<!-- end-managed-by: source/other -->',
    ].join('\n'));
    const mismatched = await runDoctor(fixture);
    assert.equal(mismatched.envelope.actions.find(({ recipe }) => recipe === 'fragment').state, 'conflict');
    assert.equal(mismatched.envelope.diagnostics.find(({ recipe }) => recipe === 'fragment').code, 'incomplete-fragment');

    await writeRecipe(fixture.sourceRoot, 'other-fragment', [
      { type: 'file-fragment', input: 'files/other.txt', inputContent: 'other\n', target: 'AGENTS.md' },
    ]);
    const distinct = await runDoctor(fixture);
    assert.equal(distinct.envelope.diagnostics.some(({ code }) => code === 'fragment-marker-collision'), false);
    assert.equal(distinct.envelope.diagnostics.some(({ code }) => code === 'file-target-collision'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('optional Fragment failures warn, human output is actionable, and doctor is read-only', async () => {
  const fixture = await createFixture();
  const profileRoot = join(fixture.root, 'profile');
  try {
    await mkdir(profileRoot);
    await writeRecipe(fixture.sourceRoot, 'optional-fragment', [
      { type: 'file-fragment', input: 'files/missing.txt', target: 'AGENTS.md', optional: true },
    ]);
    const before = await snapshotTree(fixture.consumerRoot, fixture.sourceRoot, profileRoot);
    const json = await runCli(['doctor', '--json', '--root', fixture.consumerRoot], {
      env: { USERPROFILE: profileRoot, HOME: profileRoot },
    });
    assert.equal(json.exitCode, 0);
    assert.equal(json.stderr, '');
    assert.equal(parseJsonOutput(json.stdout).status, 'warning');

    const human = await runCli(['doctor', '--root', fixture.consumerRoot], {
      env: { USERPROFILE: profileRoot, HOME: profileRoot },
    });
    assert.equal(human.exitCode, 0);
    assert.equal(human.stderr, '');
    assert.match(human.stdout, /status: warning/);
    assert.match(human.stdout, /source-input-missing/);
    const after = await snapshotTree(fixture.consumerRoot, fixture.sourceRoot, profileRoot);
    assert.deepEqual(after, before);
  } finally {
    await fixture.cleanup();
  }
});

test('contract gates fail before discovery and omitted root uses cwd', async () => {
  const fixture = await createFixture();
  const validManifest = [
    'schemaVersion: 1',
    'sources:',
    '  - provider: local',
    '    locator:',
    '      path: ../source',
    '',
  ].join('\n');
  try {
    const cases = [
      ['sources: []\n', 'schema-version-missing'],
      ['schemaVersion: 2\nsources: []\n', 'schema-version-unsupported'],
      ['schemaVersion: 1\nschemaVersion: 1\nsources: []\n', 'yaml-parse-error'],
      [`${validManifest}---\nschemaVersion: 1\nsources: []\n`, 'yaml-parse-error'],
      [`%YAML 1.1\n---\n${validManifest}`, 'yaml-parse-error'],
      [`${validManifest}unexpected: true\n`, 'schema-validation-failed'],
    ];
    for (const [text, code] of cases) {
      await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), text);
      const { result, envelope } = await runDoctor(fixture);
      assert.equal(result.exitCode, 1, code);
      assert.equal(envelope.diagnostics[0].code, code);
      assert.equal(envelope.actions.length, 0);
    }

    await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), validManifest);
    await writeFile(join(fixture.sourceRoot, 'source.yaml'), 'schemaVersion: 2\n');
    const invalidSource = await runDoctor(fixture);
    assert.equal(invalidSource.envelope.diagnostics[0].code, 'schema-version-unsupported');
    assert.equal(invalidSource.envelope.actions.length, 0);

    await writeFile(join(fixture.sourceRoot, 'source.yaml'), 'schemaVersion: 1\n');
    await writeFile(join(fixture.sourceRoot, 'baseline', 'recipe.yaml'), [
      'schemaVersion: 1',
      'steps:',
      '  - type: file',
      '    input: files/hello.txt',
      '    target: generated/hello.txt',
      'requires:',
      '  - source: other',
      '    recipe: baseline',
      '',
    ].join('\n'));
    const invalidRecipe = await runDoctor(fixture);
    assert.equal(invalidRecipe.envelope.diagnostics[0].code, 'requires-not-supported');
    assert.equal(invalidRecipe.envelope.actions.length, 0);

    await writeFile(join(fixture.sourceRoot, 'baseline', 'recipe.yaml'), [
      'schemaVersion: 1',
      'steps:',
      '  - type: file',
      '    input: files/hello.txt',
      '    target: generated/hello.txt',
      '',
    ].join('\n'));
    const omittedRoot = await runCli(['doctor', '--json'], { cwd: fixture.consumerRoot });
    assert.equal(omittedRoot.exitCode, 0);
    assert.equal(omittedRoot.stderr, '');
    assert.equal(parseJsonOutput(omittedRoot.stdout).actions[0].state, 'satisfied');
  } finally {
    await fixture.cleanup();
  }
});
