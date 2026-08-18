# Issue 14 Local Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local `install` and `install --dry-run` for File and File Fragment steps with complete preflight, safe drift handling, idempotence and a local Installation record.

**Architecture:** Reuse `src/doctor.ts` as the single local planner and expose the bytes and canonical paths needed by installation. Keep filesystem mutation, state validation, SHA-256 fingerprints and metadata updates in a focused `src/install.ts`; `src/cli.ts` only parses and dispatches the new command. Extend the existing real-process E2E seam instead of adding a second fixture system.

**Tech Stack:** TypeScript, Node.js `node:fs/promises`, `node:crypto`, existing `yaml` and AJV contract validation, Node test runner, Biome.

## Global Constraints

- Issue #14 remains open and assigned to `iskandersierra`; do not close, push, or approve a pull request.
- Only local Sources are supported in this slice; Git, Source dependencies, Custom, Catalogs and uninstall remain out of scope.
- All YAML documents use `schemaVersion: 1` and the closed contract in `schemas/contract-v1.json`.
- Preflight must complete before any Artifact, state or metadata write.
- `doctor` and `install --dry-run` remain completely read-only, including `.tbboot/state.yaml`, `.tbboot/.gitignore`, lockfile and trust.
- File copies bytes exactly; File Fragment normalizes managed content to LF and preserves unrelated content.
- Drift is blocked by default; `--force` only reconciles a drifted File or its own Managed block, never structural conflicts.
- SHA-256 fingerprints are lowercase hexadecimal.
- Every production behavior change gets a failing E2E test before implementation code.

## Files and responsibilities

- Modify `src/doctor.ts`: expose the reusable local plan and retain all discovery, path safety, collision and artifact-state rules.
- Create `src/install.ts`: validate state, apply File/File Fragment changes, maintain effects, hash bytes and update `.tbboot/.gitignore`.
- Modify `src/cli.ts`: parse `install`, `--dry-run` and `--force`, dispatch to `runInstall`, and render the common envelope.
- Modify `test/doctor.e2e.test.ts`: add real CLI tests using its existing fixture, process runner and complete tree snapshots.

### Task 1: Expose one reusable local installation plan

**Files:**

- Modify: `src/doctor.ts`
- Test: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
export type PlannedArtifact = {
  source: SourceReference;
  sourceRoot: string;
  sourceInput: Buffer;
  recipe: string;
  step: number;
  type: "file" | "file-fragment";
  marker?: string;
  input: Buffer;
  targetPath: string;
  targetBefore?: Buffer;
  targetAfter: Buffer;
  created: boolean;
  optional: boolean;
  action: ArtifactAction;
};

export type LocalInstallPlan = {
  consumerRoot: string;
  actions: ArtifactAction[];
  diagnostics: Diagnostic[];
  artifacts: PlannedArtifact[];
};

export function planLocalInstall(
  root: string,
  force: boolean,
): Promise<LocalInstallPlan>;
```

- [ ] **Step 1: Write the failing test**

Add an E2E test that runs `install --dry-run --root <fixture>` with a missing
File target and asserts command `install`, one `missing` action, `changed: false`,
exit code `0`, and unchanged Consumer/profile snapshots. The current CLI must
reject `install`, so the failure must be a command-boundary failure.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install dry-run"
```

Expected: FAIL because `cli.ts` accepts only `doctor`.

- [ ] **Step 3: Implement the smallest planner seam**

Refactor the existing descriptor evaluation so it records input bytes, current
target bytes, canonical target path, Source reference and the target content
needed by installation. Keep `runDoctor` as a read-only consumer of the same
planner. Do not duplicate Source/Recipe discovery or collision logic.

- [ ] **Step 4: Run the focused doctor and install tests**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "File states|File Fragment|install dry-run"
```

Expected: existing doctor cases stay green; the new test remains red only until
the CLI dispatch task is complete.

### Task 2: Parse and render the install command

**Files:**

- Modify: `src/cli.ts`
- Create: `src/install.ts`
- Test: `test/doctor.e2e.test.ts`

**Interfaces:**

```ts
export type InstallEnvelope = {
  schemaVersion: 1;
  command: "install";
  status: "ok" | "warning" | "error";
  changed: boolean;
  actions: ArtifactAction[];
  diagnostics: Diagnostic[];
};

export type InstallResult = {
  envelope: InstallEnvelope;
  exitCode: 0 | 1;
};

export function runInstall(
  root: string,
  options: { dryRun: boolean; force: boolean },
): Promise<InstallResult>;
```

- [ ] **Step 1: Add failing argument and output tests**

Cover `install --json`, omitted `--root`, duplicate `--force`, invalid option,
and missing `--root` value. Assert invalid usage exits `2`, writes no files,
and valid JSON has exactly one stdout document and empty stderr.

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install.*(json|root|argument)"
```

Expected: FAIL because the parser and install renderer do not exist.

- [ ] **Step 3: Implement parser and dispatch**

Extend `parseCommandLine` with a discriminated `doctor`/`install` result. Keep
the existing `parseArgs` strictness and root normalization. Render both
commands through a shared field-only human renderer, while JSON serializes the
envelope once and appends one newline.

- [ ] **Step 4: Implement read-only `runInstall` path**

Call `planLocalInstall(root, force)`, copy actions/diagnostics into an install
envelope, return `changed: false` for dry-run, and return exit code `1` only
when an error diagnostic exists. Do not write state yet.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install"
```

Expected: parser, JSON, dry-run and existing doctor tests pass.

### Task 3: Apply File artifacts and record state

**Files:**

- Modify: `src/install.ts`
- Modify: `src/doctor.ts`
- Test: `test/doctor.e2e.test.ts`

- [ ] **Step 1: Add failing File application tests**

Add tests for a missing File target, a satisfied pre-existing target, required
drift, and `--force` drift. Assert exact bytes, no writes after an unforced
preflight error, declaration order, and `changed`.

- [ ] **Step 2: Run the File tests and verify RED**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install.*File|force.*File|drift"
```

Expected: FAIL because `runInstall` currently only reports the plan.

- [ ] **Step 3: Add SHA-256 and state helpers**

Use Node's standard library and the existing YAML dependency:

```ts
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type State = { schemaVersion: 1; effects: StateEffect[] };
```

Read an absent state as an empty state. Validate an existing state with
`validateDocument({ kind: "state", ... })`; invalid state is a preflight error
and prevents every write. Deduplicate effects by Source, Recipe, Step, type,
target and marker, replacing the existing record with the newly reconciled
fingerprints.

- [ ] **Step 4: Apply File writes in plan order**

For each eligible File, skip a satisfied target whose state effect is already
current, create parent directories only for a real write, write input bytes,
then append its effect with `created: true` only when the target was absent.
When `--force` reconciles drift, preserve `created: false` for a pre-existing
target.

- [ ] **Step 5: Write state and metadata minimally**

Serialize `{ schemaVersion: 1, effects }` with `YAML.stringify`. Create or
update `.tbboot/.gitignore` only when state changes, preserve every existing
line, and ensure exactly `/state.yaml` is present. Never touch the root
`.gitignore`. Set `changed` when an Artifact or this metadata changes.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install.*File|force.*File|drift"
```

Expected: all focused File and state tests pass and no existing doctor test
changes behavior.

### Task 4: Apply File Fragment blocks, force and idempotence

**Files:**

- Modify: `src/install.ts`
- Modify: `src/doctor.ts`
- Test: `test/doctor.e2e.test.ts`

- [ ] **Step 1: Add failing fragment tests**

Cover creation in an absent target, append beside unrelated content, two
distinct markers sharing a target, exact second-run no-op, drift, force-only
own-block replacement, duplicate/incomplete marker conflicts and a preflight
error mixed with a valid File. Snapshot all Consumer and profile entries before
and after dry-run and preflight failure.

- [ ] **Step 2: Run fragment tests and verify RED**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install.*Fragment|Managed|idempotent|preflight"
```

Expected: FAIL because installation currently handles only complete Files.

- [ ] **Step 3: Compute fragment output without mutating the target**

Use the existing marker parser and apply the same result rules as `doctor`.
For a missing own block, append the normalized block while preserving unrelated
text. For force drift, replace only the byte span of the own block. For two
fragments sharing a target, feed each descriptor the in-memory result of the
previous descriptor before writing the next result.

- [ ] **Step 4: Record Fragment effects**

Store `type: "file-fragment"`, the marker, Source input SHA-256 and the
reconciled managed-block SHA-256. Do not add a `created` property because the
effect owns only its block, not the containing file.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
node --test test/doctor.e2e.test.ts --test-name-pattern "install.*Fragment|Managed|idempotent|preflight"
```

Expected: fragment creation, preservation, drift, force, conflicts, state and
second-run no-op all pass.

### Task 5: Complete verification and review

- [ ] **Step 1: Run typechecking and focused tests**

```powershell
npm run typecheck
node --test test/doctor.e2e.test.ts
```

- [ ] **Step 2: Run repository checks**

```powershell
npm run check
npm run build
```

- [ ] **Step 3: Run the complete test script and diff hygiene checks**

```powershell
npm test
git diff --check
git status --short
```

- [ ] **Step 4: Run `/code-review` against `main`**

Review `git diff main...HEAD` on Standards and Spec axes. Fix any finding
that contradicts Issue #14, the ADRs or the repository's documented rules.

- [ ] **Step 5: Commit the implementation**

```powershell
git add src/cli.ts src/doctor.ts src/install.ts test/doctor.e2e.test.ts
git commit -m "feat: install local file artifacts safely"
```

Do not push or close Issue #14.

## Self-review checklist

- [ ] Every Issue #14 acceptance item has a task and a real CLI assertion.
- [ ] No production write exists before a failing test demonstrates the
      behavior it enables.
- [ ] Planner and installer share one source of truth for discovery, paths,
      states and conflicts.
- [ ] No Git, Source dependency, Custom, Catalog or uninstall code is added.
- [ ] State and metadata stay untouched in doctor, dry-run and failed preflight.
- [ ] The plan contains no unresolved placeholders or unspecified helper names.
