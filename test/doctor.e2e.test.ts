import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseJsonOutput, runCommand } from '../prototypes/issue-12/harness.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'src', 'cli.ts');

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

test('unknown arguments return 2 and print usage only on stderr', async () => {
  const result = await runCommand({
    file: process.execPath,
    args: [cliPath, 'doctor', '--unknown'],
    cwd: projectRoot,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: tbboot doctor/);
});

test('invalid YAML returns one JSON diagnostic and no stderr', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.consumerRoot, 'tbboot.yaml'), 'schemaVersion: [\n');
    const result = await runCommand({
      file: process.execPath,
      args: [cliPath, 'doctor', '--json', '--root', fixture.consumerRoot],
      cwd: projectRoot,
    });
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
    const result = await runCommand({
      file: process.execPath,
      args: [cliPath, 'doctor', '--json', '--root', fixture.consumerRoot],
      cwd: projectRoot,
    });
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
