import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  classifyRuntime,
  detectRuntime,
  detectRuntimes,
  parseRange,
  parseVersion,
  satisfies,
} from '../runtime.mjs';
import { runHandler } from '../runner.mjs';
import { collectChild, isProcessRunning, prototypeRoot, waitFor, waitForFile } from './support.mjs';

const fixture = (name) => join(import.meta.dirname, 'fixtures', name);

test('parses versions and the fixed inclusive/exclusive ranges', () => {
  assert.deepEqual(parseVersion('v24.12.1'), { major: 24, minor: 12, patch: 1 });
  assert.deepEqual(parseVersion('PowerShell 7.6.0'), { major: 7, minor: 6, patch: 0 });
  assert.deepEqual(parseRange('>=24.12 <25'), {
    lower: { major: 24, minor: 12, patch: 0, inclusive: true },
    upper: { major: 25, minor: 0, patch: 0, inclusive: false },
  });
  assert.equal(satisfies({ major: 24, minor: 12, patch: 0 }, '>=24.12 <25'), true);
  assert.equal(satisfies({ major: 25, minor: 0, patch: 0 }, '>=24.12 <25'), false);
});

test('classifies compatible, incompatible, missing, and unsupported runtimes', () => {
  assert.equal(classifyRuntime({ name: 'node', available: true, version: '24.12.1' }).status, 'compatible');
  assert.equal(classifyRuntime({ name: 'node', available: true, version: '23.11.0' }).status, 'incompatible');
  assert.equal(classifyRuntime({ name: 'pwsh', available: false, version: null }).status, 'missing');
  assert.equal(classifyRuntime({ name: 'windows-powershell', available: true, version: '5.1.0' }).status, 'unsupported');
});

test('detects the real Windows runtime set', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'Windows x64-only runtime probes' }, async () => {
  const runtimes = await detectRuntimes();
  assert.equal(runtimes.node.status, 'compatible');
  assert.ok(['compatible', 'incompatible', 'missing'].includes(runtimes.pwsh.status));
  assert.ok(['unsupported', 'missing'].includes(runtimes['windows-powershell'].status));
});

test('reports an unavailable Windows probe without emulation', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'Windows x64-only runtime probes' }, async () => {
  const result = await detectRuntime('pwsh');
  assert.equal(typeof result.status, 'string');
});

test('executes JavaScript and erasable TypeScript through Node', async () => {
  const js = await runHandler({ runtime: 'node', script: fixture('javascript-handler.js'), request: { operation: 'check' } });
  assert.equal(js.result.details.language, 'javascript');
  assert.match(js.stderr, /js-log:check/);

  const ts = await runHandler({ runtime: 'node', script: fixture('erasable-handler.ts'), request: { operation: 'check' } });
  assert.equal(ts.result.details.language, 'typescript');
});

test('executes PowerShell handlers through pwsh', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'PowerShell 7 is Windows x64-only here' }, async (t) => {
  const runtime = await detectRuntime('pwsh');
  if (runtime.status !== 'compatible') { t.skip(`pwsh is ${runtime.status}`); return; }
  const result = await runHandler({ runtime: 'pwsh', script: fixture('powershell-handler.ps1'), request: { operation: 'check' } });
  assert.equal(result.result.details.language, 'powershell');
  assert.match(result.stderr, /pwsh-log:check/);
});

test('wraps inline PowerShell handler content', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'PowerShell 7 is Windows x64-only here' }, async (t) => {
  const runtime = await detectRuntime('pwsh');
  if (runtime.status !== 'compatible') { t.skip(`pwsh is ${runtime.status}`); return; }
  const result = await runHandler({
    runtime: 'pwsh',
    content: "[ordered]@{ status = 'ok'; changed = $false; details = @{ inline = $true } } | ConvertTo-Json -Compress",
    request: { operation: 'check' },
  });
  assert.equal(result.result.details.inline, true);
});

test('wraps inline Node handler content', async () => {
  const result = await runHandler({
    runtime: 'node',
    content: "return { status: 'ok', changed: false, details: { inline: true } };",
    request: { operation: 'check' },
  });
  assert.equal(result.result.details.inline, true);
});

test('rejects malformed results and non-zero child exits', async () => {
  await assert.rejects(
    runHandler({ runtime: 'node', script: fixture('invalid-result.js'), request: {} }),
    (error) => error.code === 'invalid-result',
  );
  await assert.rejects(
    runHandler({ runtime: 'node', script: fixture('nonzero-result.js'), request: {} }),
    (error) => error.code === 'child-exit' && error.exitCode === 7,
  );
});

test('maps an unavailable executable to spawn-failed with its original code', async () => {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const originalPath = process.env[pathKey];
  process.env[pathKey] = '';
  try {
    await assert.rejects(
      runHandler({ runtime: 'pwsh', content: "return", request: {} }),
      (error) => error.code === 'spawn-failed' && error.cause?.code === 'ENOENT',
    );
  } finally {
    if (originalPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = originalPath;
  }
});

test('timeout kills the root, child, and grandchild', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'Windows x64-only process-tree test' }, async () => {
  const pidFile = join(tmpdir(), `tbboot-issue-11-pids-${randomUUID()}.json`);
  await assert.rejects(
    runHandler({ runtime: 'node', script: fixture('tree-root.mjs'), request: { pidFile }, timeoutMs: 2000 }),
    (error) => error.code === 'timeout',
  );
  const pids = JSON.parse(await readFile(pidFile, 'utf8'));
  await waitFor(() => Promise.all(pids.map(isProcessRunning)).then((states) => states.every((running) => !running)));
});

test('cancellation exits through one path and leaves completed work', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'Windows x64-only process-tree test' }, async () => {
  const completedFile = join(tmpdir(), `tbboot-issue-11-completed-${randomUUID()}.txt`);
  const controller = new AbortController();
  const running = runHandler({
    runtime: 'node',
    script: fixture('cancellable-handler.js'),
    request: { completedFile },
    signal: controller.signal,
    timeoutMs: 5000,
  });
  await waitForFile(completedFile);
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'cancelled');
  assert.equal(await readFile(completedFile, 'utf8'), 'completed\n');
});

test('driver maps deterministic cancellation to exit code 130', { skip: process.platform === 'win32' && process.arch === 'x64' ? false : 'Windows x64-only driver test' }, async () => {
  const completedFile = join(tmpdir(), `tbboot-issue-11-driver-${randomUUID()}.txt`);
  const child = spawn(process.execPath, [
    'driver.mjs', '--runtime', 'node', '--script', fixture('cancellable-handler.js'),
    '--request', JSON.stringify({ completedFile }), '--cancel-when-file', completedFile, '--timeout-ms', '5000',
  ], { cwd: prototypeRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const result = await collectChild(child);
  assert.equal(result.code, 130);
  assert.equal(await readFile(completedFile, 'utf8'), 'completed\n');
  assert.doesNotMatch(result.stderr, /rollback/i);
});
