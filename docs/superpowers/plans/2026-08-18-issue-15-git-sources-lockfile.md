# Git Sources and Authoritative Lockfile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production Git Source resolution, authoritative `tbboot.lock.yaml` handling, and explicit `--update-lock`/`--frozen-lockfile` behavior to the existing CLI.

**Architecture:** Keep one discovery/planning path in `src/doctor.ts`. Add a small `src/git.ts` provider that invokes Git with `execFile`, materializes selected revisions in a temporary directory outside the Consumer repository, and returns resolved Source roots plus revision/fingerprint data. Let `src/install.ts` own lockfile read/write policy and pass resolved Sources into the existing local Artifact planner/applicator.

**Tech Stack:** Node.js 24 standard library (`child_process`, `crypto`, `fs/promises`, `os`, `path`), existing `yaml` and `ajv` dependencies, TypeScript strict mode, `node:test`, real temporary Git repositories, and the real installed CLI.

## Global Constraints

- Issue #15 is authoritative; the design is recorded in `docs/superpowers/specs/2026-08-18-issue-15-git-sources-lockfile-design.md`.
- Support Git Sources at repository root and at a safe repository-relative `path`.
- Support short refs, `refs/tags/...`, `refs/heads/...`, inclusive `{ from, to }` ranges, selector intersections, empty intersections, and incomparable maximal revisions.
- `tbboot.lock.yaml` is schema-versioned, versioned with the Consumer repository, and authoritative for normal `install`.
- `--update-lock` explicitly renews affected entries; `--frozen-lockfile` forbids creation or modification and fails on missing or stale entries.
- `doctor` and `install --dry-run` remain byte-for-byte read-only, including lockfile, state, metadata, trust, Sources, and Artifacts.
- Only `install`, after complete preflight and before the first Artifact write, may write the lockfile.
- No Git library, cache, Source dependency, Recipe selection, Custom, Catalog, or uninstall implementation is added.
- Git arguments are passed as arrays to `execFile`; selector values never enter a shell command.
- Production behavior is written test-first: each new test is run red before its implementation and green immediately after.
- Use Node's built-in test runner and the repository's existing E2E seam; do not add a test framework or dependency.

## File map

- Modify `src/contract.ts`: add typed selector fields and the lockfile document type without changing the closed schema contract.
- Create `src/git.ts`: Git command wrapper, ref/range resolution, selector intersection, Source materialization, tree fingerprint, and stable provider errors.
- Modify `src/doctor.ts`: accept resolved local/Git Sources, preserve one discovery/path/artifact plan, and carry Git revision into planned Artifacts.
- Modify `src/install.ts`: parse and validate lockfile state, enforce lock modes, write the prepared lockfile at the install boundary, and include revisions in state effects.
- Modify `src/cli.ts`: parse `--update-lock` and `--frozen-lockfile`, reject duplicates/incompatible flags, and pass options through.
- Modify `test/doctor.e2e.test.ts`: add temporary Git repositories and real-CLI acceptance tests for resolution, lock policy, application, and read-only guarantees.
- Modify `package.json` only if a separately named Git test file is needed; prefer the existing E2E file to avoid another test command.

---

### Task 1: Extend the contract and CLI lock options

**Files:**

- Modify: `src/contract.ts`
- Modify: `src/cli.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
export type GitSelector =
  | { ref: string }
  | { from: string; to: string };

export type SourceReference =
  | { provider: "local"; locator: { path: string }; selector?: Record<string, never> }
  | { provider: "git"; locator: { repository: string; path?: string }; selector?: GitSelector };

export type LockEntry = {
  source: SourceReference;
  revision: string;
  fingerprint: string;
};

export type LockfileDocument = { schemaVersion: 1; sources: LockEntry[] };
```

- [ ] **Step 1: Write failing parser tests.**

Add real CLI cases asserting that `install --update-lock`,
`install --frozen-lockfile`, and both together are parsed at the command
boundary. Assert duplicate occurrences of either option return exit code `2`,
write no stdout, and include the existing install usage text on stderr. Add a
successful JSON invocation with both flags absent and assert the parsed
envelope still has `command: "install"`.

- [ ] **Step 2: Run the focused tests to verify RED.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "lock|install.*argument"
```

Expected: FAIL because the parser does not expose either lock option and the
source types do not yet include selectors.

- [ ] **Step 3: Add the minimal types and parser fields.**

Extend the existing discriminated install parse result with:

```ts
options: {
  root: string;
  json: boolean;
  dryRun: boolean;
  force: boolean;
  updateLock: boolean;
  frozenLockfile: boolean;
}
```

Register both boolean options with `parseArgs`, count option tokens for
duplicates, and reject the combination with the message
`--update-lock and --frozen-lockfile cannot be used together`. Keep invalid
usage at exit code `2`; do not read or write a Consumer repository for parser
errors.

- [ ] **Step 4: Run the focused tests to verify GREEN.**

Run the same command. Expected: all new parser cases pass and the existing
doctor/install parser cases remain green.

- [ ] **Step 5: Run the static typecheck.**

Run `npm run typecheck`. Expected: exit code `0`; use this check before adding
provider code so later type errors stay local to the next task.

### Task 2: Implement and test the Git selector provider

**Files:**

- Create: `src/git.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
export type GitSource = {
  source: GitSourceReference;
  sourceRoot: string;
  revision: string;
  fingerprint: string;
  cleanup: () => Promise<void>;
};

export class GitSourceError extends Error {
  constructor(
    readonly code:
      | "git-ref-not-found"
      | "git-ref-ambiguous"
      | "git-range-invalid"
      | "git-selector-incompatible"
      | "git-selector-ambiguous"
      | "git-repository-read"
      | "git-source-missing",
    message: string,
    readonly details: Record<string, unknown> = {},
  );
}

export function resolveGitSelector(
  repositoryRoot: string,
  selectors: readonly GitSelector[],
): Promise<{ revision: string }>;

export function materializeGitSource(
  consumerRoot: string,
  reference: GitSourceReference,
  revision: string,
): Promise<GitSource>;
```

- [ ] **Step 1: Write failing provider tests.**

Build a temporary Git fixture in the existing test file with a base commit,
two descendant branches, tags, a tag/branch short-name collision, and two
divergent tips. Test the real exported provider functions for:

```ts
assert.equal((await resolveGitSelector(repo, [{ ref: "v1" }])).revision, base);
assert.equal((await resolveGitSelector(repo, [{ from: "v1", to: "v2" }])).revision, tip);
await assert.rejects(
  () => resolveGitSelector(repo, [{ ref: "same" }]),
  (error) => error instanceof GitSourceError && error.code === "git-ref-ambiguous",
);
```

Add equivalent assertions for missing refs, a lower bound that is not an
ancestor, an empty intersection, and multiple incomparable maxima. Add a
materialization case for repository root and a nested `path`, asserting
`source.yaml` exists and the fingerprint is stable for the same tree.

- [ ] **Step 2: Run the provider tests to verify RED.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "Git selector|Git Source provider|materialize"
```

Expected: FAIL because `src/git.ts` does not exist.

- [ ] **Step 3: Add the minimum Git command wrapper.**

Implement one async `execFile` helper invoking `git` with `-C <repo>` and an
argument array. Trim only command output used as a revision/ref; keep raw
NUL-delimited output for tree fingerprints. Translate Git exit status `1` for
`show-ref --verify` and `merge-base --is-ancestor` into ordinary false results;
translate other failures to `git-repository-read`.

- [ ] **Step 4: Implement ref resolution and range candidates.**

For a short name, inspect exactly `refs/tags/<name>` and
`refs/heads/<name>` (plus cloned remote branch refs when materializing a
remote). A fully qualified `refs/tags/...` or `refs/heads/...` is checked only
in its named namespace. Resolve matches to peeled commit IDs. Enumerate
unique commits pointed to by local tags/branches, include both range bounds,
and use `merge-base --is-ancestor` for membership. Reject non-ancestor bounds.

- [ ] **Step 5: Implement selector intersection and materialization.**

Intersect candidate revision sets by commit ID, then select a candidate that
has no descendant among the remaining candidates. Return
`git-selector-incompatible` for an empty set and `git-selector-ambiguous` for
more than one incomparable maximum. Clone/check out the selected revision into
an OS temp directory outside the Consumer root, use `git archive` or equivalent
Git object extraction to expose only the selected root/path, verify
`source.yaml`, hash a deterministic tree listing with SHA-256, and expose
cleanup in a `finally`-safe result.

- [ ] **Step 6: Run the provider tests to verify GREEN.**

Run the same focused command. Expected: all selector/materialization cases
pass, including the original prototype semantics, and no repository files are
created outside the test temp directory.

### Task 3: Feed resolved Git Sources into the shared planner

**Files:**

- Modify: `src/doctor.ts`
- Modify: `src/git.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
type ResolvedSource = {
  reference: SourceReference;
  sourceRoot: string;
  revision?: string;
  fingerprint?: string;
  cleanup: () => Promise<void>;
};

export function planSources(
  root: string,
  sources: readonly ResolvedSource[],
  mode: "doctor" | "install",
  force: boolean,
): Promise<LocalInstallPlan>;
```

- [ ] **Step 1: Write a failing real-CLI Git planning test.**

Add a fixture whose Manifest points at a Git repository root with a tag and a
second fixture whose Manifest points at `path: nested/source`. Run
`doctor --json` and assert exit code `0`, two planned actions in the existing
lexical/step order, Git source context, and no changes to the Consumer, source
repository, profile, or lockfile.

- [ ] **Step 2: Run the planning test to verify RED.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "Git.*doctor|Git.*path"
```

Expected: FAIL because `doctor.ts` currently reports every non-local provider
as unsupported and does not accept a resolved Source list.

- [ ] **Step 3: Refactor the existing local planner behind resolved Sources.**

Keep local Source normalization/discovery unchanged, but create resolved
Source descriptors for local entries and Git entries before the existing
`collectSourceSteps` loop. Group Git declarations by normalized
`repository + path`, resolve their selectors once, and give the common planner
the materialized Source root and revision. Preserve duplicate identity
diagnostics, declaration order, Recipe lexical order, Step order, path escape
checks, collisions, and File/Fragment states.

- [ ] **Step 4: Carry revision through planned Artifacts.**

Add optional `revision` and `sourceFingerprint` to `PlannedArtifact`; include
`revision` only for Git references. Do not add a revision to local state. Make
`runDoctor` call the same planning path in read-only mode and clean all Git
temporaries in a `finally` block.

- [ ] **Step 5: Run focused Git and existing doctor tests.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "Git|valid canonical|discovers only|rejects unsupported"
```

Expected: Git planning tests and existing local doctor tests pass; unsupported
provider assertions must be updated only where the provider is now supported.

### Task 4: Add authoritative lockfile planning and read-only modes

**Files:**

- Modify: `src/install.ts`
- Modify: `src/doctor.ts`
- Modify: `src/cli.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
type LockMode = "normal" | "update" | "frozen";

type LockResolution = {
  entries: LockEntry[];
  sources: ResolvedSource[];
  changed: boolean;
};

async function resolveLock(
  root: string,
  references: readonly SourceReference[],
  mode: LockMode,
): Promise<LockResolution>;
```

- [ ] **Step 1: Write failing lockfile acceptance tests.**

Cover these real CLI behaviors:

1. Normal `install --json` with a Git Source and no lockfile creates the
   Artifact and `tbboot.lock.yaml` with `schemaVersion: 1`, one normalized
   source locator, the original selector, a full revision, and a fingerprint.
2. A second normal install reuses the lock entry even after the repository's
   selected branch advances; the lock revision and Artifact remain unchanged.
3. A changed selector fails with a stale diagnostic and does not modify the
   Artifact or lockfile.
4. `--update-lock` resolves the changed selector and updates the lockfile.
5. `--frozen-lockfile` fails on a missing or stale entry and leaves every
   watched tree unchanged; it succeeds with a compatible entry.
6. `doctor` and `install --dry-run` never create or modify the lockfile.

- [ ] **Step 2: Run the lock tests to verify RED.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "lockfile|frozen-lockfile|update-lock|authoritative"
```

Expected: FAIL because `runInstall` currently ignores the lockfile and does
not pass lock mode into the planner.

- [ ] **Step 3: Read and validate the existing lockfile.**

Use `validateDocument({ kind: "lockfile", text, document: "tbboot.lock.yaml" })`.
Treat an absent lockfile as empty in normal/update mode and as a blocking
`lockfile-missing` diagnostic in frozen mode. Treat malformed or schema-invalid
content as `lockfile-invalid` and stop before Git materialization writes or any
Artifact write.

- [ ] **Step 4: Match entries by normalized identity and selector.**

For each grouped Git identity, compare the normalized source locator and the
serialized original selector. Reuse the lock revision only when the current
selector constraints accept it and the checked-out Source fingerprint equals
the stored fingerprint. Report `lockfile-stale` for changed selectors,
unreachable revisions, missing `source.yaml`, or fingerprint mismatch. Normal
mode may resolve a new identity; only update mode may replace a stale entry.

- [ ] **Step 5: Thread lock mode through install and preserve read-only paths.**

Extend `runInstall` options with `updateLock` and `frozenLockfile`. Resolve the
lock before `planLocalInstall`, merge lock diagnostics into the common
envelope, and return before applying Artifacts whenever an error exists or
`dryRun` is true. In doctor, do not read the lockfile as a mutable authority;
resolve Git for inspection and discard all temporaries without writes.

- [ ] **Step 6: Run focused lock tests to verify GREEN.**

Run the same lock-focused command, then:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "Git|lockfile|frozen-lockfile|update-lock|doctor|dry-run"
```

Expected: all lock policy and read-only cases pass.

### Task 5: Write lockfile at the install boundary and persist Git revisions

**Files:**

- Modify: `src/install.ts`
- Modify: `src/doctor.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
async function persistLockfile(
  root: string,
  document: LockfileDocument,
): Promise<boolean>;
```

- [ ] **Step 1: Write failing boundary/state tests.**

Add a preflight-failure case with one valid Git Artifact and one invalid
required Artifact; assert the lockfile, Artifact, `.tbboot/state.yaml`, and
`.tbboot/.gitignore` are all absent or byte-identical after install. Add a
successful Git install assertion that the state effect contains the exact Git
`source`, full `revision`, source input fingerprint, and artifact fingerprint.
Add a satisfied second run assertion that changes neither Artifact nor
metadata.

- [ ] **Step 2: Run the tests to verify RED.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "preflight.*lock|state.*revision|Git.*second run"
```

Expected: FAIL because the lockfile is not written and state effects currently
do not carry Git revisions.

- [ ] **Step 3: Persist the prepared lockfile once, before Artifact writes.**

Serialize the complete `{ schemaVersion: 1, sources }` document with the
existing YAML dependency. Compare bytes before writing so unchanged lockfiles
are not rewritten. Create parent directories only at this install boundary;
never call this function from doctor or dry-run. Set `envelope.changed` only if
the lockfile bytes actually change.

- [ ] **Step 4: Include revision and Source fingerprint in state effects.**

Update `effectFor` to copy `artifact.revision` when present and keep local
effects unchanged. Use the existing SHA-256 helper for Source input bytes and
reconciled Artifact bytes. Ensure the state schema validator accepts the Git
revision already defined in `schemas/contract-v1.json`.

- [ ] **Step 5: Preserve temporary cleanup and failure semantics.**

Wrap resolution, planning, lock persistence, and apply in `try/finally` so
every materialized Source is removed. If lock persistence fails, return an
install diagnostic and do not start Artifact writes. If a later Artifact write
fails, preserve the existing partial-state reconciliation behavior and retain
the already-written lock entry.

- [ ] **Step 6: Run the focused tests to verify GREEN.**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "Git|lockfile|state.*revision|preflight"
```

Expected: all Git install, state, idempotence, preflight, and read-only tests
pass.

### Task 6: Complete verification, review, and implementation commit

**Files:**

- Modify only files required by Tasks 1–5.

- [ ] **Step 1: Run typechecking and the focused E2E file.**

```powershell
npm run typecheck
node --test test/doctor.e2e.test.ts
```

Expected: both commands exit `0` with no failed tests.

- [ ] **Step 2: Run repository checks and build.**

```powershell
npm run check
npm run build
```

Expected: Biome, Markdownlint, and Node syntax checks exit `0`.

- [ ] **Step 3: Run the complete test script and hygiene checks.**

```powershell
npm test
git diff --check
git status --short
```

Expected: the complete configured suite exits `0`, no whitespace errors are
reported, and only intentional Issue #15 files are modified.

- [ ] **Step 4: Review the branch against `main`.**

Pin `main` and inspect `git diff main...HEAD` using the code-review skill on
both Standards and Spec axes. Check each Issue #15 acceptance criterion,
especially lock authority, stale/frozen behavior, path safety, and read-only
guarantees. Fix any finding with a new focused test before changing code.

- [ ] **Step 5: Commit the implementation.**

```powershell
git add src/contract.ts src/git.ts src/doctor.ts src/install.ts src/cli.ts test/doctor.e2e.test.ts package.json package-lock.json
git commit -m "feat: resolve Git sources with authoritative lockfile"
```

Do not push, close Issue #15, approve a pull request, or modify `main`.

## Self-review checklist

- [ ] Git root and internal path are both resolved by the production CLI.
- [ ] Short/full refs, inclusive ranges, selector intersections, and all
      ambiguity/incompatibility diagnostics are covered by tests.
- [ ] Lock entries contain normalized locator, original selector, revision,
      and fingerprint and are reused authoritatively.
- [ ] Normal mode creates only missing entries; update mode renews affected
      entries; frozen mode fails before writes on missing/stale entries.
- [ ] Doctor and dry-run do not modify Consumer, Source, profile, lockfile,
      state, trust, or metadata trees.
- [ ] Git revisions reach Installation record effects and local behavior is
      unchanged.
- [ ] No dependencies or unrelated abstractions were added.
