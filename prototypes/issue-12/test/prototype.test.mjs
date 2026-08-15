import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createFixture,
  parseJsonOutput,
  runCommand,
  snapshotFiles,
} from '../harness.mjs';

const cliPath = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));

test('creates isolated fixture roots and cleans only its own temporary directory', async () => {
  const first = await createFixture();
  const second = await createFixture();
  try {
    assert.notEqual(first.root, second.root);
    assert.equal(await readFile(join(first.consumerRoot, 'tbboot.yaml'), 'utf8'),
      await readFile(join(second.consumerRoot, 'tbboot.yaml'), 'utf8'));
    await first.cleanup();
    await assert.rejects(access(first.root));
    await access(second.root);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('removes the temporary root when fixture copying fails', async () => {
  const copyError = new Error('copy failed');
  let root;
  await assert.rejects(
    createFixture({
      copy: async (_source, destination) => {
        root = destination;
        throw copyError;
      },
    }),
    (error) => error === copyError,
  );
  await assert.rejects(access(root));
});

test('shares the cleanup promise while removal is in flight', async () => {
  const fixture = await createFixture();
  try {
    const firstCleanup = fixture.cleanup();
    assert.strictEqual(fixture.cleanup(), firstCleanup);
    await firstCleanup;
  } finally {
    await fixture.cleanup();
  }
});

test('snapshots nested file paths and exact bytes deterministically', async () => {
  const fixture = await createFixture();
  try {
    const snapshot = await snapshotFiles(fixture.sourceRoot);
    assert.deepEqual(snapshot.map(({ path }) => path), [
      'baseline/files/hello.txt',
      'baseline/recipe.yaml',
      'source.yaml',
    ]);
    assert.deepEqual(snapshot.find(({ path }) => path === 'baseline/files/hello.txt').bytes,
      Buffer.from('hello from the Source fixture\n'));
  } finally {
    await fixture.cleanup();
  }
});

test('captures exit code, stdout, and stderr from a real child process', async () => {
  const fixture = await createFixture();
  try {
    const result = await runCommand({
      file: process.execPath,
      args: [cliPath, '--root', fixture.consumerRoot, '--exit', '7'],
      cwd: fixture.consumerRoot,
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, 'probe stderr\n');
    assert.deepEqual(parseJsonOutput(result.stdout), {
      status: 'ok',
      cwdMatchesRoot: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('rejects and reaps a child process that exceeds its timeout', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      runCommand({
        file: process.execPath,
        args: [cliPath, '--root', fixture.consumerRoot, '--delay', '200'],
        cwd: fixture.consumerRoot,
        timeoutMs: 20,
      }),
      (error) => {
        assert.equal(error.code, 'ETIMEDOUT');
        assert.match(error.message, /timed out after 20ms/);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('does not wait for a child that handles SIGTERM', async () => {
  const fixture = await createFixture();
  const started = Date.now();
  try {
    await assert.rejects(
      runCommand({
        file: process.execPath,
        args: [cliPath, '--root', fixture.consumerRoot, '--handle-sigterm'],
        cwd: fixture.consumerRoot,
        timeoutMs: 20,
      }),
      (error) => error.code === 'ETIMEDOUT',
    );
    if (process.platform !== 'win32') {
      assert.ok(Date.now() - started < 400);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('rejects empty and multiple JSON documents', () => {
  assert.throws(() => parseJsonOutput(''));
  assert.throws(() => parseJsonOutput('{"one":1}\n{"two":2}'));
});

test('proves a read-only command leaves the full fixture byte-for-byte unchanged', async () => {
  const fixture = await createFixture();
  try {
    const before = await snapshotFiles(fixture.root);
    const result = await runCommand({
      file: process.execPath,
      args: [cliPath, '--root', fixture.consumerRoot],
      cwd: fixture.consumerRoot,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(await snapshotFiles(fixture.root), before);
  } finally {
    await fixture.cleanup();
  }
});
