# Issue 11 Runtime and Process Control Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated Windows x64 prototype that detects the supported runtimes, executes JavaScript/erasable TypeScript/PowerShell Custom handlers, and terminates complete process trees on timeout or cancellation.

**Architecture:** Keep every implementation, fixture, test, and note under `prototypes/issue-11/`. `runtime.mjs` owns fixed-range detection; `adapters.mjs` describes direct Node and PowerShell invocations; `runner.mjs` owns the stdin/stdout/stderr protocol; `process-tree.mjs` owns Windows tree termination; and `driver.mjs` demonstrates SIGINT and exit code `130`. Tests use real executables on Windows and skip Windows-specific cases elsewhere.

**Tech Stack:** Node.js `>=24.12 <25`, ECMAScript modules, Node built-ins only, `node:test`, Windows x64, PowerShell 7 (`pwsh`), and Windows `taskkill.exe`.

## Global Constraints

- All files live under `prototypes/issue-11/`; production code remains untouched.
- Detect `node` with `>=24.12 <25` and `pwsh` with `>=7.6 <8`.
- Detect `powershell.exe` and report it as explicitly unsupported, even when installed.
- Node loads `.js` and erasable `.ts` handlers directly; do not add a TypeScript runner or transform flags.
- Use one JSON request on handler stdin, one JSON result on handler stdout, and stderr for logs.
- Start runtimes without a shell; do not build shell command strings for process launch.
- On timeout or cancellation, terminate the complete process tree with `taskkill /PID <pid> /T /F` and wait for the child to close.
- Manual cancellation exits with code `130`; completed work remains and no rollback action runs.
- On non-Windows systems, Windows-specific tests report `skip` or `unavailable`; they do not emulate Windows process behavior.
- Do not implement catalogs, YAML, authorization, installation, rollback, package dependencies, or a cross-platform process abstraction.
- Commit each completed task only when the implementation session has authorization to commit; never push automatically.

---

## File Map

| File | Responsibility |
| --- | --- |
| `prototypes/issue-11/package.json` | Private prototype metadata and `check`/`test` scripts. |
| `prototypes/issue-11/runtime.mjs` | Fixed version parsing, range checks, executable probes, and runtime classifications. |
| `prototypes/issue-11/adapters.mjs` | Direct Node and `pwsh` invocation arguments plus the common handler wrapper contract. |
| `prototypes/issue-11/runner.mjs` | Child lifecycle, JSON protocol, timeout/cancellation wiring, and result validation. |
| `prototypes/issue-11/process-tree.mjs` | Windows `taskkill.exe` invocation and completion of tree termination. |
| `prototypes/issue-11/driver.mjs` | Small command-line demonstration with `SIGINT` and deterministic cancellation hook. |
| `prototypes/issue-11/test/support.mjs` | Temporary paths, child-process helpers, skip predicates, and polling utilities. |
| `prototypes/issue-11/test/prototype.test.mjs` | Runtime, adapter, protocol, process-tree, and cancellation acceptance tests. |
| `prototypes/issue-11/test/fixtures/*.js|*.mjs|*.ts|*.ps1` | Handlers and process-tree descendants used by tests and the manual driver run. |
| `prototypes/issue-11/README.md` | Prerequisites, commands, protocol, manual Ctrl+C demonstration, and prototype limits. |

The files are deliberately kept flat: this prototype has two runtime adapters, not a general plugin or process abstraction.

### Task 1: Add runtime detection and the test harness

**Files:**

- Create: `prototypes/issue-11/package.json`
- Create: `prototypes/issue-11/runtime.mjs`
- Create: `prototypes/issue-11/test/prototype.test.mjs`

**Interfaces:**

- Produces `RUNTIME_DEFINITIONS`, `parseVersion(text)`, `parseRange(text)`, `satisfies(version, range)`, `classifyRuntime({ name, available, version })`, `detectRuntime(name)`, and `detectRuntimes()`.
- A runtime classification is `{ name, command, version, status, supported }`, where `status` is one of `compatible`, `incompatible`, `missing`, or `unsupported`; `version` is `null` when unavailable.
- `detectRuntimes()` returns an object with exactly `node`, `pwsh`, and `windowsPowerShell` properties.

- [ ] **Step 1: Add the minimal package metadata.**

Create `prototypes/issue-11/package.json`:

```json
{
  "name": "tbboot-issue-11-runtime-process-prototype",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.12 <25" },
  "scripts": {
    "check": "node --check runtime.mjs && node --check adapters.mjs && node --check runner.mjs && node --check process-tree.mjs && node --check driver.mjs && node --check test/support.mjs && node --check test/prototype.test.mjs",
    "test": "node --test test/prototype.test.mjs"
  }
}
```

No `npm install` is needed because the prototype has no dependencies.

- [ ] **Step 2: Write the failing classification tests.**

Add these tests at the top of `test/prototype.test.mjs`:

```js
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
  assert.equal(classifyRuntime({ name: 'windowsPowerShell', available: true, version: '5.1.0' }).status, 'unsupported');
});

test('detects the real Windows runtime set', { skip: process.platform === 'win32' ? false : 'Windows-only runtime probes' }, async () => {
  const runtimes = await detectRuntimes();
  assert.equal(runtimes.node.status, 'compatible');
  assert.ok(['compatible', 'incompatible', 'missing'].includes(runtimes.pwsh.status));
  assert.ok(['unsupported', 'missing'].includes(runtimes.windowsPowerShell.status));
});

test('reports an unavailable Windows probe without emulation', { skip: process.platform === 'win32' ? false : 'Windows-only runtime probes' }, async () => {
  const result = await detectRuntime('pwsh');
  assert.equal(typeof result.status, 'string');
});
```

Run from `prototypes/issue-11/`:

```powershell
npm test -- --test-name-pattern="parses versions|classifies"
```

Expected: FAIL because `runtime.mjs` and its exports do not exist.

- [ ] **Step 3: Implement the fixed parser and executable probes.**

Implement the following behavior in `runtime.mjs`:

```js
export const RUNTIME_DEFINITIONS = Object.freeze({
  node: { command: 'node', range: '>=24.12 <25', versionArgs: ['--version'] },
  pwsh: { command: 'pwsh', range: '>=7.6 <8', versionArgs: ['--version'] },
  windowsPowerShell: {
    command: 'powershell.exe',
    range: null,
    versionArgs: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
});
```

Use `promisify(execFile)` with `{ encoding: 'utf8', windowsHide: true, shell: false }`. Parse the first `major.minor` or `major.minor.patch` sequence from probe output, default a missing patch to `0`, and compare numeric tuples. Treat `ENOENT` as `missing`; treat an installed `windowsPowerShell` as `unsupported` before range comparison; classify an unparsable or out-of-range supported runtime as `incompatible`.

Use these small pure functions for the fixed range grammar:

```js
const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;
const RANGE_RE = /^>=(\d+(?:\.\d+){1,2})\s+<(\d+(?:\.\d+){1,2})$/;

export function parseVersion(text) {
  const match = String(text).match(VERSION_RE);
  return match ? { major: +match[1], minor: +match[2], patch: +(match[3] ?? 0) } : null;
}

export function parseRange(text) {
  const match = String(text).match(RANGE_RE);
  if (!match) throw new TypeError(`Unsupported runtime range: ${text}`);
  return {
    lower: { ...parseVersion(match[1]), inclusive: true },
    upper: { ...parseVersion(match[2]), inclusive: false },
  };
}

function compare(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function satisfies(version, rangeText) {
  const range = typeof rangeText === 'string' ? parseRange(rangeText) : rangeText;
  return compare(version, range.lower) >= 0 && compare(version, range.upper) < 0;
}
```

Implement `classifyRuntime` from the definition table, then let
`detectRuntime` run the definition’s `versionArgs`, map `ENOENT` to
`available: false`, and pass probe output through `parseVersion`. Implement
`detectRuntimes` with `Promise.all` over the three fixed names and return the
documented property names.

- [ ] **Step 4: Run the runtime tests and the syntax check.**

Run:

```powershell
npm test -- --test-name-pattern="parses versions|classifies"
npm run check
```

Expected: the focused tests pass, the Windows probe test is either passing on Windows or skipped elsewhere, and the syntax check exits `0`.

- [ ] **Step 5: Commit the runtime slice.**

```powershell
git add prototypes/issue-11/package.json prototypes/issue-11/runtime.mjs prototypes/issue-11/test/prototype.test.mjs
git commit -m "feat: detect issue 11 runtimes"
```

### Task 2: Add the common handler protocol and runtime adapters

**Files:**

- Create: `prototypes/issue-11/adapters.mjs`
- Create: `prototypes/issue-11/runner.mjs`
- Create: `prototypes/issue-11/test/fixtures/javascript-handler.js`
- Create: `prototypes/issue-11/test/fixtures/erasable-handler.ts`
- Create: `prototypes/issue-11/test/fixtures/powershell-handler.ps1`
- Create: `prototypes/issue-11/test/fixtures/invalid-result.js`
- Create: `prototypes/issue-11/test/fixtures/nonzero-result.js`
- Modify: `prototypes/issue-11/test/prototype.test.mjs`

**Interfaces:**

- `buildInvocation(runtime, { script, content })` returns `{ file, args }` and requires exactly one of `script` or `content`.
- `runHandler({ runtime, script, content, request, cwd, timeoutMs, signal })` resolves to `{ result, stdout, stderr, exitCode }` or rejects with an error whose stable `code` is `invalid-result`, `child-exit`, `timeout`, `cancelled`, or `tree-termination-failed`.
- `runner.mjs` keeps `waitForClose(child)`, `validateResult(value)`, and `runnerError(code, details)` private to the module.
- Node external handlers export `default async function handler(request)`; Node inline content is the function body wrapped by the adapter.
- PowerShell external and inline handlers receive `$Request` as a deserialized object and write exactly one JSON result to stdout; stderr is log-only.
- A valid result has an object shape with `status` in `ok|missing|drift|error` and boolean `changed`; `message` and `details` are optional.

- [ ] **Step 1: Add handler fixtures and failing protocol tests.**

Create the JavaScript fixture:

```js
export default async function handler(request) {
  console.error(`js-log:${request.operation}`);
  return { status: 'ok', changed: false, details: { language: 'javascript' } };
}
```

Create the erasable TypeScript fixture:

```ts
export default async function handler(request: { operation: string }) {
  const language: string = 'typescript';
  return { status: 'ok', changed: false, details: { language, operation: request.operation } };
}
```

Create the PowerShell fixture:

```powershell
$requestJson = [Console]::In.ReadToEnd()
$Request = $requestJson | ConvertFrom-Json
Write-Error "pwsh-log:$($Request.operation)" -ErrorAction Continue
[ordered]@{ status = 'ok'; changed = $false; details = @{ language = 'powershell' } } |
  ConvertTo-Json -Compress
```

Create `invalid-result.js`:

```js
export default async function handler() {
  process.stdout.write('not-json');
  return { status: 'ok', changed: false };
}
```

Create `nonzero-result.js`:

```js
export default async function handler() {
  console.error('failure-log');
  process.exitCode = 7;
  return { status: 'ok', changed: false };
}
```

Add these tests:

```js
import { join } from 'node:path';
import { runHandler } from '../runner.mjs';

const fixture = (name) => join(import.meta.dirname, 'fixtures', name);

test('executes JavaScript and erasable TypeScript through Node', async () => {
  const js = await runHandler({ runtime: 'node', script: fixture('javascript-handler.js'), request: { operation: 'check' } });
  assert.equal(js.result.details.language, 'javascript');
  assert.match(js.stderr, /js-log:check/);

  const ts = await runHandler({ runtime: 'node', script: fixture('erasable-handler.ts'), request: { operation: 'check' } });
  assert.equal(ts.result.details.language, 'typescript');
});

test('executes PowerShell handlers through pwsh', { skip: process.platform === 'win32' ? false : 'PowerShell 7 is Windows-only here' }, async (t) => {
  const runtime = await detectRuntime('pwsh');
  if (runtime.status !== 'compatible') { t.skip(`pwsh is ${runtime.status}`); return; }
  const result = await runHandler({ runtime: 'pwsh', script: fixture('powershell-handler.ps1'), request: { operation: 'check' } });
  assert.equal(result.result.details.language, 'powershell');
  assert.match(result.stderr, /pwsh-log:check/);
});

test('wraps inline PowerShell handler content', { skip: process.platform === 'win32' ? false : 'PowerShell 7 is Windows-only here' }, async (t) => {
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
```

Run:

```powershell
npm test -- --test-name-pattern="executes|wraps inline|rejects malformed"
```

Expected: FAIL because the adapter and runner do not exist.

- [ ] **Step 2: Implement direct invocation builders.**

In `adapters.mjs`, build Node invocations with `process.execPath`, `--input-type=module`, and a bootstrap that reads stdin, imports either a file URL or a `data:` URL, calls the default handler, and writes `JSON.stringify(result)` once. For inline Node content, wrap it exactly as `export default async function handler(request) { <content> }`; do not pass any type-transform or TypeScript runner flag.

Build PowerShell invocations with executable `pwsh`, `-NoLogo`, `-NoProfile`, `-NonInteractive`, and either `-File <script>` or `-Command <wrapper>`. The inline wrapper reads stdin, assigns `$Request`, evaluates the supplied handler body, and leaves stdout solely to the handler result. Use argument arrays and `spawn` with `shell: false`; never concatenate an executable command line.

Keep the adapter seam this small:

```js
export function buildInvocation(runtime, { script, content }) {
  if ((script == null) === (content == null)) throw new TypeError('Provide exactly one handler script or content');
  if (runtime === 'node') return { file: process.execPath, args: nodeArgs({ script, content }) };
  if (runtime === 'pwsh') return { file: 'pwsh', args: pwshArgs({ script, content }) };
  throw new TypeError(`Unsupported runtime: ${runtime}`);
}
```

`nodeArgs` passes a file URL for `script` or a `data:text/javascript,` URL
for the wrapped inline module to one Node bootstrap. `pwshArgs` passes a file
to `-File` or a wrapper body to `-Command`; both paths read one JSON request
from `[Console]::In.ReadToEnd()` and emit the handler’s one JSON result.

- [ ] **Step 3: Implement protocol validation and child I/O.**

In `runner.mjs`, spawn the invocation with `stdio: ['pipe', 'pipe', 'pipe']`, write exactly `JSON.stringify(request)` followed by `stdin.end()`, collect stdout and stderr separately, and wait for the `close` event. If the exit code is non-zero, reject with `child-exit` and include `exitCode` and captured stderr. If it is zero, parse trimmed stdout with `JSON.parse`; reject empty, multiple-value, non-object, invalid-status, or non-boolean-`changed` output as `invalid-result`. Preserve stderr in the resolved value and never print it to stdout.

The core lifecycle should have this shape before timeout support is added:

```js
const { file, args } = buildInvocation(runtime, { script, content });
const child = spawn(file, args, {
  cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.end(JSON.stringify(request));
const result = await waitForClose(child); // collect stdout/stderr and exit code
if (result.exitCode !== 0) throw runnerError('child-exit', result);
return { ...result, result: validateResult(JSON.parse(result.stdout.trim())) };
```

- [ ] **Step 4: Run the focused protocol tests and syntax check.**

Run:

```powershell
npm test -- --test-name-pattern="executes|wraps inline|rejects malformed"
npm run check
```

Expected: JavaScript, erasable TypeScript, inline Node, invalid-result, and non-zero-exit tests pass; both PowerShell tests pass on Windows or are skipped elsewhere.

- [ ] **Step 5: Commit the protocol slice.**

```powershell
git add prototypes/issue-11/adapters.mjs prototypes/issue-11/runner.mjs prototypes/issue-11/test
git commit -m "feat: run issue 11 handler protocols"
```

### Task 3: Terminate complete process trees on timeout

**Files:**

- Create: `prototypes/issue-11/process-tree.mjs`
- Create: `prototypes/issue-11/test/fixtures/tree-root.mjs`
- Create: `prototypes/issue-11/test/fixtures/tree-child.mjs`
- Create: `prototypes/issue-11/test/fixtures/tree-grandchild.mjs`
- Create: `prototypes/issue-11/test/fixtures/cancellable-handler.js`
- Modify: `prototypes/issue-11/runner.mjs`
- Modify: `prototypes/issue-11/test/support.mjs`
- Modify: `prototypes/issue-11/test/prototype.test.mjs`

**Interfaces:**

- `terminateProcessTree(pid)` runs `taskkill.exe /PID <pid> /T /F` on Windows, waits for that command, and resolves only after the tree-kill request completes.
- `runHandler` invokes `terminateProcessTree` once on timeout or `AbortSignal` cancellation, then waits for the spawned child’s `close` event before rejecting.
- Timeout errors have `code: 'timeout'`; cancellation errors have `code: 'cancelled'`; failure to issue or complete the tree termination has `code: 'tree-termination-failed'`.

- [ ] **Step 1: Add the Windows process-tree fixture and failing test.**

Make `tree-root.mjs` spawn `tree-child.mjs`, make the child spawn
`tree-grandchild.mjs`, write all three PIDs to the request’s `pidFile`, and
keep all processes alive. Make `cancellable-handler.js` write
`request.completedFile` and then await a promise that never resolves.

Create the three process-tree fixtures with these bodies:

```js
// test/fixtures/tree-grandchild.mjs
await new Promise(() => {});
```

```js
// test/fixtures/tree-child.mjs
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pidFile = process.argv[2];
const grandchild = spawn(process.execPath, [
  fileURLToPath(new URL('./tree-grandchild.mjs', import.meta.url)),
], { stdio: 'ignore', windowsHide: true, shell: false });
await writeFile(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
await new Promise(() => {});
```

```js
// test/fixtures/tree-root.mjs
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pidFile = process.argv[2];
spawn(process.execPath, [
  fileURLToPath(new URL('./tree-child.mjs', import.meta.url)), pidFile,
], { stdio: 'ignore', windowsHide: true, shell: false });
for (;;) {
  try {
    const descendants = JSON.parse(await readFile(pidFile, 'utf8'));
    await writeFile(pidFile, JSON.stringify([process.pid, descendants.child, descendants.grandchild]));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
await new Promise(() => {});
```

Create `cancellable-handler.js`:

```js
import { writeFile } from 'node:fs/promises';

export default async function handler(request) {
  await writeFile(request.completedFile, 'completed\n');
  await new Promise(() => {});
}
```

Add these support helpers to `test/support.mjs`:

```js
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

export async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for predicate');
}

export async function isProcessRunning(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`], {
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
    });
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}
```

`waitForFile` throws after its deadline and `isProcessRunning` returns `false`
for a missing process. Add these imports, without repeating the `join` and
`runHandler` imports already added in Task 2, and add the test:

```js
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isProcessRunning, waitFor, waitForFile } from './support.mjs';

test('timeout kills the root, child, and grandchild', { skip: process.platform === 'win32' ? false : 'Windows-only process-tree test' }, async () => {
  const pidFile = join(tmpdir(), `tbboot-issue-11-pids-${randomUUID()}.json`);
  await assert.rejects(
    runHandler({ runtime: 'node', script: fixture('tree-root.mjs'), request: { pidFile }, timeoutMs: 500 }),
    (error) => error.code === 'timeout',
  );
  const pids = JSON.parse(await readFile(pidFile, 'utf8'));
  await waitFor(() => Promise.all(pids.map(isProcessRunning)).then((states) => states.every((running) => !running)));
});
```

Run:

```powershell
npm test -- --test-name-pattern="timeout kills"
```

Expected: FAIL because no process-tree termination path exists.

- [ ] **Step 2: Implement the native Windows tree kill.**

In `process-tree.mjs`, reject with `tree-termination-failed` when
`process.platform !== 'win32'`. Otherwise call:

```js
await execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
  windowsHide: true,
  shell: false,
});
```

Capture command failures in an error that includes the PID and original stderr.
Do not fall back to `child.kill()`, enumerate descendants manually, or add a
Unix implementation; the prototype’s contract is Windows x64.

- [ ] **Step 3: Wire timeout and cancellation into the runner.**

Start one timer when the child is spawned. On timer expiry, set the reason to
`timeout`; on `signal.abort`, set it to `cancelled`. Both paths call one
idempotent `stop(reason)` function that awaits `terminateProcessTree(child.pid)`.
The `close` listener remains active until the child exits. After close, reject
with the recorded reason and never parse a partial stdout buffer. Clear the
timer and remove the abort listener on every completion path.

- [ ] **Step 4: Add deterministic cancellation/no-rollback coverage.**

Add this test, using the fixture that writes before blocking:

```js
test('cancellation exits through one path and leaves completed work', { skip: process.platform === 'win32' ? false : 'Windows-only process-tree test' }, async () => {
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
```

Run:

```powershell
npm test -- --test-name-pattern="timeout kills|cancellation exits"
```

Expected: both Windows tests pass; elsewhere both are explicitly skipped.

- [ ] **Step 5: Commit the process-control slice.**

```powershell
git add prototypes/issue-11/process-tree.mjs prototypes/issue-11/runner.mjs prototypes/issue-11/test
git commit -m "feat: terminate issue 11 process trees"
```

### Task 4: Add the SIGINT driver and exit code 130

**Files:**

- Create: `prototypes/issue-11/driver.mjs`
- Modify: `prototypes/issue-11/test/prototype.test.mjs`
- Modify: `prototypes/issue-11/test/support.mjs`

**Interfaces:**

- The driver accepts `--runtime node|pwsh`, `--script <path>`, `--request <json>`, `--timeout-ms <positive integer>`, and optional `--cancel-after-ms <positive integer>`.
- `SIGINT` and `--cancel-after-ms` both call the same `AbortController.abort()` path.
- A successful driver run prints the handler result JSON to stdout and exits `0`; a cancelled run logs to stderr and exits `130`; no rollback function or cleanup write is called.

- [ ] **Step 1: Add the failing driver test.**

Add `prototypeRoot` and `collectChild(child)` to `test/support.mjs`, where
`prototypeRoot` is the parent directory of `test/` and `collectChild` resolves
`{ code, signal, stdout, stderr }` after collecting both output streams and the
child `close` event. Then spawn the driver with the existing cancellable
fixture:

```js
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const prototypeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function collectChild(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
```

Add the imports not already present from Tasks 2 and 3 to
`test/prototype.test.mjs`, then add the test:

```js
import { spawn } from 'node:child_process';
import { collectChild, prototypeRoot } from './support.mjs';

test('driver maps deterministic cancellation to exit code 130', { skip: process.platform === 'win32' ? false : 'Windows-only driver test' }, async () => {
  const completedFile = join(tmpdir(), `tbboot-issue-11-driver-${randomUUID()}.txt`);
  const child = spawn(process.execPath, [
    'driver.mjs', '--runtime', 'node', '--script', fixture('cancellable-handler.js'),
    '--request', JSON.stringify({ completedFile }), '--cancel-after-ms', '100', '--timeout-ms', '5000',
  ], { cwd: prototypeRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const result = await collectChild(child);
  assert.equal(result.code, 130);
  assert.equal(await readFile(completedFile, 'utf8'), 'completed\n');
  assert.doesNotMatch(result.stderr, /rollback/i);
});
```

Run:

```powershell
npm test -- --test-name-pattern="driver maps"
```

Expected: FAIL because `driver.mjs` does not exist.

- [ ] **Step 2: Implement the small argument parser and driver lifecycle.**

Parse the listed flags, reject unknown or missing values with exit code `2`,
and resolve the script path from the current working directory. Create an
`AbortController`, register one `SIGINT` listener, and schedule the optional
`--cancel-after-ms` hook against the same abort callback. Call `runHandler`
with the parsed request and signal. Print successful `result` JSON once; map
`cancelled` to `process.exitCode = 130`, map other runner failures to
`process.exitCode = 1`, and write diagnostics only to stderr. Do not add a
rollback callback or delete the fixture’s completed file.

- [ ] **Step 3: Run driver tests and all existing tests.**

Run:

```powershell
npm test -- --test-name-pattern="driver maps"
npm test
```

Expected: the driver test passes on Windows and is skipped elsewhere; all
previous runtime/protocol tests remain green.

- [ ] **Step 4: Commit the driver slice.**

```powershell
git add prototypes/issue-11/driver.mjs prototypes/issue-11/test/prototype.test.mjs prototypes/issue-11/test/support.mjs
git commit -m "feat: map issue 11 cancellation to 130"
```

### Task 5: Document the prototype and perform final verification

**Files:**

- Create: `prototypes/issue-11/README.md`

- [ ] **Step 1: Write the README with the exact supported surface.**

Document:

```text
Prerequisites: Windows x64, Node >=24.12 <25; PowerShell 7 >=7.6 <8 is
required only for pwsh tests. Windows PowerShell 5.1 is detected but never
accepted as a supported runtime.

Run:
  Set-Location prototypes/issue-11
  npm run check
  npm test

Manual Ctrl+C demonstration:
  node driver.mjs --runtime node --script test/fixtures/cancellable-handler.js --request '{"completedFile":"C:\\temp\\tbboot-issue-11-completed.txt"}' --timeout-ms 30000
  Press Ctrl+C and verify the process exits 130 and the completed file remains.
```

Explain that handler stdin/stdout/stderr form the protocol, Node imports `.js`
and erasable `.ts` without transform flags, PowerShell uses `pwsh`, and
`taskkill.exe /T /F` kills the complete tree. State that non-Windows checks
skip rather than emulate, and that the prototype excludes catalogs, YAML,
authorization, installation, rollback, and production integration.

- [ ] **Step 2: Run the final syntax and test commands.**

Run from the repository root:

```powershell
npm run check --prefix prototypes/issue-11
npm test --prefix prototypes/issue-11
```

Expected: both exit `0`; all non-Windows tests are explicitly marked skipped,
and on Windows the runtime, handler, process-tree, and driver tests pass.

- [ ] **Step 3: Inspect the final scope and whitespace.**

Run:

```powershell
git diff --check
git status --short --branch
rg --files prototypes/issue-11
```

Expected: only `prototypes/issue-11/` is added or changed, there are no
whitespace errors, and no dependency lockfile or production source appears.

- [ ] **Step 4: Commit the documentation slice.**

```powershell
git add prototypes/issue-11/README.md prototypes/issue-11/package.json
git commit -m "docs: describe issue 11 runtime prototype"
```

## Self-review against the specification

- Runtime coverage maps to Task 1: Node and `pwsh` supported ranges, missing and incompatible classifications, and installed-but-unsupported `powershell.exe`.
- Handler coverage maps to Task 2: JavaScript, erasable TypeScript, PowerShell 7, inline wrapping, one JSON request/result, stderr logs, malformed output, and non-zero exits.
- Process coverage maps to Task 3: timeout, cancellation, `taskkill /T /F`, root/child/grandchild termination, waiting for close, exit-code-independent completed work, and non-Windows skips.
- Manual signal coverage maps to Task 4: real `SIGINT`, deterministic test hook through the same cancellation path, exit code `130`, and no rollback.
- Documentation and final verification map to Task 5; no catalogs, YAML, authorization, installation, rollback, package dependencies, or cross-platform abstraction are introduced.
- No deferred implementation item remains; every named export, fixture, command, and test seam is defined in a task.
- Type consistency: `runHandler` consumes the invocation produced by `buildInvocation`; both consume the runtime names from `RUNTIME_DEFINITIONS`; `driver.mjs` forwards the same request/signal contract used by the tests.
