# Issue 10 Git Selector Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the isolated Issue #10 prototype that resolves Git refs and ancestry ranges, intersects selectors, and reports incompatible or ambiguous results using reproducible local Git fixtures.

**Architecture:** Keep all implementation under `prototypes/issue-10/`. `proposed/git-source.mjs` owns Git CLI calls, ref resolution, range candidate enumeration, and selector intersection; tests build temporary repositories and call its public functions directly. Candidate revisions are unique peeled commits from local heads and tags, and maxima are determined with Git ancestry checks.

**Tech Stack:** Node.js `>=24.12 <25`, ECMAScript modules, built-in `node:test`, `node:assert/strict`, `node:child_process`, and the installed Git CLI. No third-party dependency.

## Global Constraints

- Prototype files must remain isolated under `prototypes/issue-10/`.
- Git selectors support exact `ref` values and bounded `{ from, to }` ranges only.
- Fully qualified refs are limited to `refs/tags/...` and `refs/heads/...`; short names must reject tag/branch collisions.
- Ranges are inclusive and are valid only when `from` is an ancestor of `to`; equal bounds select one commit.
- Selector intersection must demonstrate an empty result and multiple incomparable maximal revisions.
- Tests must use reproducible local Git repositories and Node's built-in test runner.
- Never interpolate selector data into a shell command; pass Git arguments as an array.
- Every non-trivial implementation branch gets a focused automated check before the implementation is considered complete.

---

### Task 1: Create the isolated package and deterministic Git fixture helper

**Files:**
- Create: `prototypes/issue-10/package.json`
- Create: `prototypes/issue-10/test/fixture.mjs`

**Interfaces:**
- Produces `createFixtureRepo()` returning `{ repoPath, revisions }` and `removeFixtureRepo(repoPath)` for later tests.
- `revisions` contains `base`, `x`, `y`, `upperA`, and `upperB` commit IDs.

- [ ] **Step 1: Create package metadata and scripts**

```json
{
  "name": "tbboot-issue-10-prototype",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.12 <25" },
  "scripts": {
    "check": "node --check proposed/git-source.mjs && node --check test/fixture.mjs && node --check test/prototype.test.mjs",
    "test": "node --test test/prototype.test.mjs"
  }
}
```

- [ ] **Step 2: Write the fixture helper**

Use `execFileSync('git', ['-C', repoPath, ...args])`, `mkdtemp(join(tmpdir(), 'tbboot-issue-10-'))`, `writeFile`, and `rm`. Initialize `main`, configure `fixture@example.test`, and create this topology: `base` on `main`; `x` on `line-x`; `y` on `line-y`; `upperA` by merging `line-y` into `upper-a`; and `upperB` by merging `line-x` into `upper-b`. Add tags `v1` at `base`, `v2` and `same` at `x`, `range-a` at `upperA`, and `range-b` at `upperB`; add branch `same` at `y`.

```js
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function commit(repoPath, file, content, message) {
  await writeFile(join(repoPath, file), content, 'utf8');
  git(repoPath, ['add', '--', file]);
  git(repoPath, ['commit', '--quiet', '-m', message]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

export async function createFixtureRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), 'tbboot-issue-10-'));
  git(repoPath, ['init', '--quiet', '--initial-branch=main']);
  git(repoPath, ['config', 'user.name', 'tbboot fixture']);
  git(repoPath, ['config', 'user.email', 'fixture@example.test']);

  const base = await commit(repoPath, 'base.txt', 'base\n', 'base');
  git(repoPath, ['branch', 'line-x']);
  git(repoPath, ['checkout', '--quiet', 'line-x']);
  const x = await commit(repoPath, 'x.txt', 'x\n', 'x');
  git(repoPath, ['checkout', '--quiet', 'main']);
  git(repoPath, ['branch', 'line-y']);
  git(repoPath, ['checkout', '--quiet', 'line-y']);
  const y = await commit(repoPath, 'y.txt', 'y\n', 'y');

  git(repoPath, ['checkout', '--quiet', '-b', 'upper-a', 'line-x']);
  git(repoPath, ['merge', '--quiet', '--no-ff', '--no-edit', 'line-y']);
  const upperA = git(repoPath, ['rev-parse', 'HEAD']);
  git(repoPath, ['checkout', '--quiet', '-b', 'upper-b', 'line-y']);
  git(repoPath, ['merge', '--quiet', '--no-ff', '--no-edit', 'line-x']);
  const upperB = git(repoPath, ['rev-parse', 'HEAD']);

  git(repoPath, ['tag', 'v1', base]);
  git(repoPath, ['tag', 'v2', x]);
  git(repoPath, ['tag', 'same', x]);
  git(repoPath, ['tag', 'range-a', upperA]);
  git(repoPath, ['tag', 'range-b', upperB]);
  git(repoPath, ['branch', 'same', y]);
  return { repoPath, revisions: { base, x, y, upperA, upperB } };
}

export function removeFixtureRepo(repoPath) {
  return rm(repoPath, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run the syntax check**

Run: `node --check prototypes/issue-10/test/fixture.mjs`

Expected: exit code 0 and no syntax errors. The package-level check starts after the implementation and test files exist.

- [ ] **Step 4: Commit the fixture setup**

```powershell
git add prototypes/issue-10/package.json prototypes/issue-10/test/fixture.mjs
git commit -m "test: add issue 10 git fixture"
```

### Task 2: Define exact-ref tests and the public error seam

**Files:**
- Create: `prototypes/issue-10/test/prototype.test.mjs`
- Create: `prototypes/issue-10/proposed/git-source.mjs`

**Interfaces:**
- `resolveSelector(repoPath, { ref })` returns `{ revision, refs }`.
- `GitSelectorError` exposes `code` and serializable `details`.
- Later tasks reuse the same `resolveSelector` function.

- [ ] **Step 1: Write the failing exact-ref tests**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureRepo, removeFixtureRepo } from './fixture.mjs';
import { GitSelectorError, resolveSelector } from '../proposed/git-source.mjs';

async function withFixture(callback) {
  const fixture = await createFixtureRepo();
  try { return await callback(fixture); } finally { await removeFixtureRepo(fixture.repoPath); }
}

test('resolves short and fully qualified tag and branch refs', () => withFixture(({ repoPath, revisions }) => {
  assert.equal(resolveSelector(repoPath, { ref: 'v1' }).revision, revisions.base);
  assert.equal(resolveSelector(repoPath, { ref: 'refs/tags/v2' }).revision, revisions.x);
  assert.equal(resolveSelector(repoPath, { ref: 'line-y' }).revision, revisions.y);
  assert.equal(resolveSelector(repoPath, { ref: 'refs/heads/line-x' }).revision, revisions.x);
}));

test('rejects a short name shared by a tag and branch', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => resolveSelector(repoPath, { ref: 'same' }),
    (error) => error instanceof GitSelectorError && error.code === 'git-ref-ambiguous',
  );
}));

test('rejects a missing ref', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => resolveSelector(repoPath, { ref: 'missing' }),
    (error) => error instanceof GitSelectorError && error.code === 'git-ref-not-found',
  );
}));
```

- [ ] **Step 2: Run the focused test and verify the expected red state**

Run: `node --test prototypes/issue-10/test/prototype.test.mjs`

Expected: FAIL because `proposed/git-source.mjs` is missing. Add only the importable error/function stubs below to turn setup failure into assertion failure, then run the same command again.

```js
export class GitSelectorError extends Error {}
export function resolveSelector() {
  throw new Error('not implemented');
}
```

Expected after the stub: the three tests fail because the required ref behavior is not implemented.

- [ ] **Step 3: Implement exact ref resolution**

Add `GitSelectorError`, a Git argument-array runner, `resolveRef`, and `resolveSelector` to `proposed/git-source.mjs`. Check short names against exactly `refs/tags/<name>` and `refs/heads/<name>`; check fully qualified refs in their declared namespace; peel with `<ref>^{commit}`; return `{ revision, refs: [ref] }`; throw `git-ref-not-found` or `git-ref-ambiguous` with the candidate refs in `details`.

```js
import { execFileSync } from 'node:child_process';

export class GitSelectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitSelectorError';
    this.code = code;
    this.details = details;
  }
}

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function refNames(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new TypeError('Git ref must be a non-empty string');
  }
  if (name.startsWith('refs/tags/') || name.startsWith('refs/heads/')) return [name];
  if (name.startsWith('refs/')) return [];
  return [`refs/tags/${name}`, `refs/heads/${name}`];
}

function existingRef(repoPath, ref) {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function resolveRef(repoPath, name) {
  const refs = refNames(name).filter((ref) => existingRef(repoPath, ref));
  if (refs.length === 0) {
    throw new GitSelectorError('git-ref-not-found', `Git ref not found: ${name}`, { name });
  }
  if (refs.length > 1) {
    throw new GitSelectorError('git-ref-ambiguous', `Git ref is ambiguous: ${name}`, { name, refs });
  }
  return { revision: git(repoPath, ['rev-parse', '--verify', `${refs[0]}^{commit}`]), ref: refs[0] };
}

export function resolveSelector(repoPath, selector) {
  if (!selector || typeof selector !== 'object' || !('ref' in selector)) {
    throw new TypeError('Exact selector must contain ref');
  }
  const resolved = resolveRef(repoPath, selector.ref);
  return { revision: resolved.revision, refs: [resolved.ref] };
}
```

- [ ] **Step 4: Run the focused tests and commit**

Run: `node --test prototypes/issue-10/test/prototype.test.mjs`

Expected: 3 passing tests, 0 failures.

```powershell
git add prototypes/issue-10/proposed/git-source.mjs prototypes/issue-10/test/prototype.test.mjs
git commit -m "feat: resolve exact git source refs"
```

### Task 3: Add inclusive ancestry-range behavior

**Files:**
- Modify: `prototypes/issue-10/proposed/git-source.mjs`
- Modify: `prototypes/issue-10/test/prototype.test.mjs`

**Interfaces:**
- `resolveSelector(repoPath, { from, to })` returns the unique maximal `{ revision, refs }` candidate.
- Invalid bound order throws `GitSelectorError` with code `git-range-invalid`.
- A range with no candidate throws `git-selector-incompatible`.

- [ ] **Step 1: Write the failing range tests**

```js
test('resolves inclusive ranges and equal bounds by ancestry', () => withFixture(({ repoPath, revisions }) => {
  assert.equal(resolveSelector(repoPath, { from: 'v1', to: 'v2' }).revision, revisions.x);
  assert.equal(resolveSelector(repoPath, { from: 'v2', to: 'v2' }).revision, revisions.x);
  assert.equal(resolveSelector(repoPath, { from: 'refs/tags/v1', to: 'refs/heads/line-x' }).revision, revisions.x);
}));

test('rejects a range whose lower bound is not an ancestor', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => resolveSelector(repoPath, { from: 'v2', to: 'v1' }),
    (error) => error instanceof GitSelectorError && error.code === 'git-range-invalid',
  );
}));
```

- [ ] **Step 2: Run the range tests and verify red**

Run: `node --test prototypes/issue-10/test/prototype.test.mjs`

Expected: the existing exact tests pass and the two new range tests fail because range selectors are not implemented.

- [ ] **Step 3: Implement range candidate enumeration**

Add these helpers to `git-source.mjs`: `isAncestor`, `candidateRevisions`, `rangeCandidates`, and `chooseCandidate`. Enumerate unique peeled commits from `refs/heads` and `refs/tags`; keep candidates where `from` is an ancestor of the candidate and the candidate is an ancestor of `to`; include both endpoints. Use the lower/upper refs' revisions for bounds and throw the specified codes.

```js
function isAncestor(repoPath, ancestor, descendant) {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function candidateRevisions(repoPath) {
  const refs = git(repoPath, [
    'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags',
  ]).split('\n').filter(Boolean);
  const byRevision = new Map();
  for (const ref of refs) {
    const revision = git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    const entry = byRevision.get(revision) ?? { revision, refs: [] };
    entry.refs.push(ref);
    byRevision.set(revision, entry);
  }
  return [...byRevision.values()];
}

function rangeCandidates(repoPath, selector) {
  const lower = resolveRef(repoPath, selector.from);
  const upper = resolveRef(repoPath, selector.to);
  if (!isAncestor(repoPath, lower.revision, upper.revision)) {
    throw new GitSelectorError('git-range-invalid', 'Range lower bound is not an ancestor of its upper bound', {
      from: selector.from, to: selector.to,
    });
  }
  return candidateRevisions(repoPath).filter(({ revision }) =>
    isAncestor(repoPath, lower.revision, revision)
    && isAncestor(repoPath, revision, upper.revision));
}

function chooseCandidate(repoPath, candidates) {
  if (candidates.length === 0) {
    throw new GitSelectorError('git-selector-incompatible', 'Selector has no candidate revision');
  }
  // ponytail: O(n²) ancestry checks, replace with one graph walk if candidate sets grow.
  const maxima = candidates.filter((candidate, index) => candidates.every((other, otherIndex) =>
    index === otherIndex || !isAncestor(repoPath, candidate.revision, other.revision)));
  if (maxima.length > 1) {
    throw new GitSelectorError('git-selector-ambiguous', 'Selector has incomparable maximal revisions', {
      revisions: maxima.map(({ revision }) => revision),
    });
  }
  return maxima[0];
}
```

Update `resolveSelector` to dispatch `{ ref }` to `resolveRef` and `{ from, to }` through `rangeCandidates` and `chooseCandidate`.

- [ ] **Step 4: Run the full prototype test file**

Run: `node --test prototypes/issue-10/test/prototype.test.mjs`

Expected: 5 passing tests, 0 failures.

- [ ] **Step 5: Commit range behavior**

```powershell
git add prototypes/issue-10/proposed/git-source.mjs prototypes/issue-10/test/prototype.test.mjs
git commit -m "feat: resolve inclusive git selector ranges"
```

### Task 4: Add selector intersection and ambiguity tests

**Files:**
- Modify: `prototypes/issue-10/proposed/git-source.mjs`
- Modify: `prototypes/issue-10/test/prototype.test.mjs`

**Interfaces:**
- `intersectSelectors(repoPath, selectors)` returns one `{ revision, refs }` or throws `git-selector-incompatible` / `git-selector-ambiguous`.

- [ ] **Step 1: Write the failing intersection tests**

```js
import { intersectSelectors } from '../proposed/git-source.mjs';

test('reports an empty selector intersection', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => intersectSelectors(repoPath, [{ ref: 'v1' }, { ref: 'v2' }]),
    (error) => error instanceof GitSelectorError && error.code === 'git-selector-incompatible',
  );
}));

test('intersects refs that identify the same revision', () => withFixture(({ repoPath, revisions }) => {
  const result = intersectSelectors(repoPath, [
    { ref: 'v2' },
    { ref: 'refs/heads/line-x' },
  ]);
  assert.equal(result.revision, revisions.x);
}));

test('reports an empty intersection between ranges', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => intersectSelectors(repoPath, [
      { from: 'line-x', to: 'range-a' },
      { from: 'line-y', to: 'range-b' },
    ]),
    (error) => error instanceof GitSelectorError && error.code === 'git-selector-incompatible',
  );
}));

test('reports several incomparable maximal revisions', () => withFixture(({ repoPath, revisions }) => {
  assert.throws(
    () => intersectSelectors(repoPath, [
      { from: 'v1', to: 'range-a' },
      { from: 'v1', to: 'range-b' },
    ]),
    (error) => error instanceof GitSelectorError
      && error.code === 'git-selector-ambiguous'
      && error.details.revisions.includes(revisions.x)
      && error.details.revisions.includes(revisions.y),
  );
}));
```

- [ ] **Step 2: Run the intersection tests and verify red**

Run: `node --test prototypes/issue-10/test/prototype.test.mjs`

Expected: the earlier tests pass and the four intersection tests fail because `intersectSelectors` is not exported/implemented.

- [ ] **Step 3: Implement set intersection and reuse maxima selection**

Add:

```js
function selectorCandidates(repoPath, selector) {
  if (selector && typeof selector === 'object' && 'ref' in selector) {
    const resolved = resolveRef(repoPath, selector.ref);
    return [{ revision: resolved.revision, refs: [resolved.ref] }];
  }
  if (selector && typeof selector === 'object' && 'from' in selector && 'to' in selector) {
    return rangeCandidates(repoPath, selector);
  }
  throw new TypeError('Git selector must contain ref or from/to');
}

export function intersectSelectors(repoPath, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new TypeError('At least one Git selector is required');
  }
  let common = selectorCandidates(repoPath, selectors[0]);
  for (const selector of selectors.slice(1)) {
    const allowed = new Set(selectorCandidates(repoPath, selector).map(({ revision }) => revision));
    common = common.filter(({ revision }) => allowed.has(revision));
  }
  return chooseCandidate(repoPath, common);
}
```

Refactor `resolveSelector` to call `chooseCandidate` for range selectors while retaining exact-ref behavior, so both public seams use the same empty/maxima diagnostics.

- [ ] **Step 4: Run the complete test file**

Run: `node --test prototypes/issue-10/test/prototype.test.mjs`

Expected: 9 passing tests, 0 failures, including the successful intersection, empty range intersection, and incomparable-maxima cases.

- [ ] **Step 5: Commit intersections**

```powershell
git add prototypes/issue-10/proposed/git-source.mjs prototypes/issue-10/test/prototype.test.mjs
git commit -m "feat: intersect git source selectors"
```

### Task 5: Add prototype documentation and run final checks

**Files:**
- Create: `prototypes/issue-10/README.md`

- [ ] **Step 1: Write the README**

Document that this is a throwaway local-Git prototype, list the supported exact/range/intersection semantics and stable diagnostic codes, and include exactly these commands:

```powershell
Set-Location prototypes/issue-10
npm run check
npm test
```

State explicitly that no remote repository, lockfile, YAML, or product CLI is implemented.

- [ ] **Step 2: Run the syntax check**

Run: `npm run check --prefix prototypes/issue-10`

Expected: exit code 0 and no syntax errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test --prefix prototypes/issue-10`

Expected: exit code 0, 9 tests passing, 0 failures.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff main...HEAD --check; git diff main...HEAD --stat; git status --short --branch`

Expected: no whitespace errors, only `.gitignore`, the Issue #10 design/plan and `prototypes/issue-10/` files, plus the already requested `AGENTS.md` change; branch is `issue/10-prototype`.

- [ ] **Step 5: Commit the README**

```powershell
git add prototypes/issue-10/README.md
git commit -m "docs: describe issue 10 git selector prototype"
```

### Task 6: Final review and handoff

**Files:**
- Review: `main...HEAD`

- [ ] **Step 1: Run the complete verification commands again after the final commit**

```powershell
npm run check --prefix prototypes/issue-10
npm test --prefix prototypes/issue-10
```

Expected: both commands exit 0; the test output reports 9 passing tests.

- [ ] **Step 2: Review the branch against the issue and design**

Confirm the diff contains exact tags, branches, fully qualified refs, short-name ambiguity, inclusive/equal/invalid ranges, empty intersections, incomparable maxima, deterministic local Git fixtures, and no production integration.

- [ ] **Step 3: Use the code-review skill against `main`**

Run the standards and spec review before claiming completion. Fix any Critical or Important finding, rerun both prototype commands, and keep Minor findings only if they do not affect Issue #10.
