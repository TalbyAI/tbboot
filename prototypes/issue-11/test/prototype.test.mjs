import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyRuntime,
  detectRuntime,
  detectRuntimes,
  parseRange,
  parseVersion,
  satisfies,
} from '../runtime.mjs';

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
