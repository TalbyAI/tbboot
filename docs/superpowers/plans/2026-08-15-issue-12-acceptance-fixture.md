# Issue 12 Acceptance Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated, reusable end-to-end harness for testing future tbboot CLI commands against temporary Consumer repositories and Sources.

**Architecture:** Keep all files under `prototypes/issue-12/`. A checked-in fixture is copied to a unique temporary directory; `harness.mjs` launches configurable CLI child processes, captures exit code/stdout/stderr, parses one JSON document, and snapshots file paths plus raw bytes. Tests exercise the process boundary with a tiny probe CLI only because the production CLI does not exist yet.

**Tech Stack:** Node.js ESM, Node standard library, `node:test`, and `node:assert/strict`; no new dependencies and no imports from `prototypes/issue-5/`.

## Global Constraints

- Prototypes must keep their fixture, implementation, checks, and notes under `prototypes/issue-12/`.
- The fixture must create and clean isolated Consumer repositories and Sources deterministically.
- CLI results must retain exit code, stdout, and stderr as separate values.
- JSON parsing must accept one document with surrounding whitespace and reject empty or multiple documents.
- Filesystem snapshots must preserve relative paths and exact bytes.
- Tests must prove that a read-only command leaves the snapshot unchanged.
- Documentation must explain how to extend the acceptance matrix and must not present the probe CLI as production tbboot.

---

### Task 1: Add the isolated fixture package and template files

**Files:**
- Create: `prototypes/issue-12/package.json`
- Create: `prototypes/issue-12/fixture/consumer/tbboot.yaml`
- Create: `prototypes/issue-12/fixture/consumer/README.md`
- Create: `prototypes/issue-12/fixture/source/source.yaml`
- Create: `prototypes/issue-12/fixture/source/baseline/recipe.yaml`
- Create: `prototypes/issue-12/fixture/source/baseline/files/hello.txt`

**Interfaces:**
- Produces a self-contained npm package whose only command is `npm test`.
- Produces a valid minimal fixture shape for later local Source CLI tests.

- [ ] **Step 1: Write the package and fixture files.**

```json
{
  "name": "tbboot-issue-12-acceptance-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/prototype.test.mjs"
  }
}
```

```yaml
# fixture/consumer/tbboot.yaml
schemaVersion: 1
sources:
  - provider: local
    locator:
      path: ../source
```

```text
# fixture/consumer/README.md
This file belongs to the Consumer repository fixture.
```

```yaml
# fixture/source/source.yaml
schemaVersion: 1
```

```yaml
# fixture/source/baseline/recipe.yaml
schemaVersion: 1
steps:
  - type: file
    input: files/hello.txt
    target: generated/hello.txt
```

```text
# fixture/source/baseline/files/hello.txt
hello from the Source fixture
```

- [ ] **Step 2: Verify the package has no dependency install requirement.**

Run: `npm test --prefix prototypes/issue-12`

Expected: FAIL because `test/prototype.test.mjs` has not been created yet, but npm resolves the local package and reports the missing test file rather than a missing dependency.

### Task 2: Add fixture lifecycle and filesystem snapshot tests

**Files:**
- Create: `prototypes/issue-12/harness.mjs`
- Create: `prototypes/issue-12/test/prototype.test.mjs`

**Interfaces:**
- `createFixture() -> Promise<{ root, consumerRoot, sourceRoot, cleanup }>` copies `fixture/` into a unique temporary directory.
- `snapshotFiles(root) -> Promise<Array<{ path, bytes }>>` recursively records sorted relative file paths and `Buffer` contents.

- [ ] **Step 1: Write the failing lifecycle and snapshot tests.**

```js
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
    await second.cleanup();
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
```

- [ ] **Step 2: Run the focused tests to verify they fail.**

Run: `node --test prototypes/issue-12/test/prototype.test.mjs`

Expected: FAIL with an import or missing-export error for `../harness.mjs`.

- [ ] **Step 3: Implement the minimum fixture and snapshot helpers.**

```js
// prototypes/issue-12/harness.mjs
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, 'fixture');

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'tbboot-issue-12-'));
  await cp(fixtureRoot, root, { recursive: true });
  let cleaned = false;
  return {
    root,
    consumerRoot: join(root, 'consumer'),
    sourceRoot: join(root, 'source'),
    cleanup: async () => {
      if (!cleaned) {
        cleaned = true;
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export async function snapshotFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          path: relative(root, absolute).split(sep).join('/'),
          bytes: await readFile(absolute),
        });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
```

- [ ] **Step 4: Run the focused tests to verify they pass.**

Run: `node --test prototypes/issue-12/test/prototype.test.mjs`

Expected: 2 passing tests and 0 failures.

### Task 3: Add process execution, JSON parsing, and read-only acceptance tests

**Files:**
- Modify: `prototypes/issue-12/harness.mjs`
- Create: `prototypes/issue-12/test/fixtures/cli.mjs`
- Modify: `prototypes/issue-12/test/prototype.test.mjs`

**Interfaces:**
- `runCommand({ file, args = [], cwd, env }) -> Promise<{ exitCode, stdout, stderr }>` launches without a shell and does not merge streams.
- `parseJsonOutput(stdout) -> unknown` parses exactly one non-empty JSON document.

- [ ] **Step 1: Write failing process, JSON, and read-only tests.**

```js
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

test('rejects empty and multiple JSON documents', () => {
  assert.throws(() => parseJsonOutput(''));
  assert.throws(() => parseJsonOutput('{"one":1}\n{"two":2}'));
});

test('proves a read-only command leaves the Consumer snapshot byte-for-byte unchanged', async () => {
  const fixture = await createFixture();
  try {
    const before = await snapshotFiles(fixture.consumerRoot);
    const result = await runCommand({
      file: process.execPath,
      args: [cliPath, '--root', fixture.consumerRoot],
      cwd: fixture.consumerRoot,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(await snapshotFiles(fixture.consumerRoot), before);
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the focused tests to verify they fail.**

Run: `node --test prototypes/issue-12/test/prototype.test.mjs`

Expected: FAIL because `runCommand` and `parseJsonOutput` are not exported and the child-process probe does not exist.

- [ ] **Step 3: Implement the process boundary and probe CLI.**

Append these helpers to `harness.mjs`:

```js
import { spawn } from 'node:child_process';

export function runCommand({ file, args = [], cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

export function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (text.length === 0) throw new Error('stdout did not contain a JSON document');
  return JSON.parse(text);
}
```

Create the probe CLI:

```js
// prototypes/issue-12/test/fixtures/cli.mjs
const value = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const root = value('--root');
process.stderr.write('probe stderr\n');
process.stdout.write(`${JSON.stringify({
  status: 'ok',
  cwdMatchesRoot: process.cwd() === root,
})}\n`);
process.exitCode = Number(value('--exit', '0'));
```

The test module resolves `cliPath` with `fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))` and imports the four helpers from `../harness.mjs`.

- [ ] **Step 4: Run the focused tests to verify they pass.**

Run: `node --test prototypes/issue-12/test/prototype.test.mjs`

Expected: all lifecycle, snapshot, process, JSON, and read-only tests pass with 0 failures.

### Task 4: Document extension and run the complete verification

**Files:**
- Create: `prototypes/issue-12/README.md`
- Modify: `prototypes/issue-12/test/prototype.test.mjs` only if the documented extension example reveals a missing public seam.

**Interfaces:**
- Documentation points future acceptance tests at `createFixture`, `runCommand`, `snapshotFiles`, and `parseJsonOutput`.

- [ ] **Step 1: Write the prototype README.**

Document:

```text
Set-Location prototypes/issue-12
npm test
```

Explain that the fixture is copied to a unique temporary directory, cleanup is required in `finally`, and future tests should invoke the production CLI through `runCommand` rather than importing production modules. Show the read-only pattern: snapshot, run `doctor` or `install --dry-run`, snapshot again, and compare. State that `test/fixtures/cli.mjs` is only a process-boundary probe and that Issue 5 is not a production dependency.

- [ ] **Step 2: Run package tests and the repository-wide available checks.**

Run: `npm test --prefix prototypes/issue-12`

Expected: all Issue 12 tests pass with 0 failures.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the planned Issue 12 prototype, plan, and design files are changed.

- [ ] **Step 3: Review the diff against Issue 12.**

Confirm each acceptance criterion maps to a concrete test or README section:

1. fixture creation/cleanup: lifecycle test and fixture templates;
2. exit code/stdout/stderr and one JSON document: process and parser tests;
3. byte-for-byte filesystem comparison for read-only commands: snapshot test;
4. extension guidance and Issue 5 separation: README.

- [ ] **Step 4: Commit the implementation.**

```powershell
git add prototypes/issue-12
git commit -m "test: add issue 12 CLI acceptance fixture"
```
