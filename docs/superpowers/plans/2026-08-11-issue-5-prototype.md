# Issue 5 Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`-`) syntax for tracking.

**Goal:** Build the isolated Windows comparison prototype requested by issue #5 and record whether the proposed declarative semantics justify a product beyond composing existing tools.

**Architecture:** Keep all experiment code under `prototypes/issue-5/`. The proposed path is a small Node.js CLI with one YAML dependency and a pure filesystem planning/apply core. The composition path uses `chezmoi` for complete files and a minimal PowerShell fragment adapter, with optional `mise` tasks to run the comparison. Both paths operate on copies of the same checked-in fixture.

**Tech Stack:** Node.js, `node:test`, `node:fs`, `node:path`, `node:child_process`, the `yaml` npm package, and Windows PowerShell.

## Global Constraints

- All prototype files live under `prototypes/issue-5/`; production directories remain untouched.
- Use only local sources, complete source installation, ordered `file` and `file-fragment` steps, and repository-relative targets.
- `doctor` is read-only; `install --dry-run` performs no writes; `install` preflights every source and step before its first write.
- Reject duplicate normalized source references, source-input escapes, target escapes, complete-file target collisions, duplicate fragment markers, drift, and known conflicts before writing.
- Existing identical files and managed blocks are no-ops; a second installation must not change bytes.
- Do not implement catalogs, Git providers, recipe selection, versions, parameters, command checks, interactive mode, packages, arbitrary scripts, rollback, or production architecture.
- Use `node:test` and temporary fixture copies; do not add a test framework or a second runtime dependency.
- Commit each completed task with the message specified in that task.

---

### Task 1: Add prototype isolation rule and the shared comparison fixture

**Files:**

- Modify: `AGENTS.md`
- Create: `prototypes/issue-5/package.json`
- Create: `prototypes/issue-5/README.md`
- Create: `prototypes/issue-5/fixture/consumer/manifest.yaml`
- Create: `prototypes/issue-5/fixture/consumer/AGENTS.md`
- Create: `prototypes/issue-5/fixture/source/source.yaml`
- Create: `prototypes/issue-5/fixture/source/shared/editorconfig`
- Create: `prototypes/issue-5/fixture/source/01-baseline/recipe.yaml`
- Create: `prototypes/issue-5/fixture/source/01-baseline/files/project-guide.md`
- Create: `prototypes/issue-5/fixture/source/01-baseline/files/agents-block.md`
- Create: `prototypes/issue-5/fixture/source/02-review/recipe.yaml`
- Create: `prototypes/issue-5/fixture/source/02-review/files/review-block.md`
- Create: `prototypes/issue-5/composition/mise.toml`
- Create: `prototypes/issue-5/composition/README.md`

**Interfaces:**

- The fixture consumer manifest references `../source`.
- The source has one shared input, one recipe-local complete file, and two distinct fragment recipes targeting the same `AGENTS.md`.
- Later tasks expose `npm test`, `npm run doctor -- --root <consumer>`, `npm run apply -- --root <consumer>`, and `npm run compare`.

- [ ] **Step 1: Add the repository instruction.**

Append this to `AGENTS.md`:

```md
### Prototype isolation

Los prototipos experimentales deben vivir en `prototypes/<prototype-name>/`.
Cada prototipo debe mantener dentro de esa carpeta su fixture, implementación,
comprobaciones y notas, sin mezclar archivos del experimento con la forma de
producción del repositorio.
```

- [ ] **Step 2: Add the minimal Node package.**

Create `prototypes/issue-5/package.json`:

```json
{
  "name": "tbboot-issue-5-prototype",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "doctor": "node proposed/cli.mjs doctor",
    "apply": "node proposed/cli.mjs install",
    "compare": "powershell -NoProfile -ExecutionPolicy Bypass -File run-comparison.ps1"
  },
  "dependencies": {
    "yaml": "^2.8.1"
  }
}
```

Run `npm install` from `prototypes/issue-5/` to create the lockfile. Do not
add another dependency.

- [ ] **Step 3: Add the fixture manifests and inputs.**

Use these exact declarations:

```yaml
# fixture/consumer/manifest.yaml
sources:
  - ../source
```

```md
<!-- fixture/consumer/AGENTS.md -->
# Consumer instructions

Keep this unmanaged text.
```

```yaml
# fixture/source/source.yaml
id: local-setup
```

```ini
# fixture/source/shared/editorconfig
root = true

[*]
charset = utf-8
```

```yaml
# fixture/source/01-baseline/recipe.yaml
id: baseline
steps:
  - type: file
    input: ../shared/editorconfig
    target: .editorconfig
  - type: file
    input: files/project-guide.md
    target: docs/project-guide.md
  - type: file-fragment
    input: files/agents-block.md
    target: AGENTS.md
```

```md
# Project setup

This file came from a recipe-local source input.
```

```md
## Baseline rules

- Run the repository checks before opening a pull request.
```

```yaml
# fixture/source/02-review/recipe.yaml
id: review
steps:
  - type: file-fragment
    input: files/review-block.md
    target: AGENTS.md
```

```md
## Review checklist

- Include the relevant issue in the change description.
```

- [ ] **Step 4: Add comparison notes and the optional `mise` task file.**

Create `composition/mise.toml`:

```toml
[tasks.doctor]
run = "powershell -NoProfile -ExecutionPolicy Bypass -File composition/composition.ps1 -Mode doctor"

[tasks.install]
run = "powershell -NoProfile -ExecutionPolicy Bypass -File composition/composition.ps1 -Mode install"

[tasks.dry-run]
run = "powershell -NoProfile -ExecutionPolicy Bypass -File composition/composition.ps1 -Mode dry-run"
```

`composition/README.md` must state that `chezmoi` is required for the
composition path, `mise` is optional because the same tasks can be invoked
directly with PowerShell, and link to the official `chezmoi` global flags and
`apply` command documentation.

- [ ] **Step 5: Check the scaffold and commit it.**

Run:

```powershell
Set-Location prototypes/issue-5
npm install
Get-ChildItem -Recurse fixture | Where-Object { $_.PSIsContainer -eq $false }
```

Expected: `npm install` exits 0 and the fixture contains all listed manifest,
source, recipe, input, and consumer files.

Commit:

```powershell
git add AGENTS.md prototypes/issue-5
git commit -m "chore: scaffold issue 5 prototype fixture"
```

### Task 2: Plan and apply complete-file steps from local sources

**Files:**

- Create: `prototypes/issue-5/proposed/core.mjs`
- Create: `prototypes/issue-5/test/support.mjs`
- Create: `prototypes/issue-5/test/prototype.test.mjs`

**Interfaces:**

- `planInstall(consumerRoot)` returns `{ writes, diagnostics }` and performs no writes.
- `applyInstall(plan)` applies a validated plan and returns applied actions.
- A write has `{ kind, target, content, action, source, recipe }`; action is `create`, `update`, or `noop`.
- A diagnostic has `{ severity, code, message }`; preflight errors use `severity: "error"`.

- [ ] **Step 1: Write the failing end-to-end file test.**

Add this test:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixtureConsumer } from './support.mjs';
import { applyInstall, planInstall } from '../proposed/core.mjs';

test('installs shared and recipe-local complete files', async () => {
  const { consumerRoot } = await fixtureConsumer();
  const plan = await planInstall(consumerRoot);

  assert.deepEqual(plan.diagnostics, []);
  await applyInstall(plan);

  assert.equal(await readFile(consumerRoot + '/.editorconfig', 'utf8'),
    'root = true\n\n[*]\ncharset = utf-8\n');
  assert.equal(await readFile(consumerRoot + '/docs/project-guide.md', 'utf8'),
    '# Project setup\n\nThis file came from a recipe-local source input.\n');
});
```

- [ ] **Step 2: Run the focused test and confirm red.**

Run `npm test -- --test-name-pattern="installs shared"` from
`prototypes/issue-5/`. Expected: FAIL because `proposed/core.mjs` does not exist.

- [ ] **Step 3: Add the fixture-copy helper and the smallest source planner.**

Create `test/support.mjs`:

```js
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixture');

export async function fixtureConsumer() {
  const root = await mkdtemp(join(tmpdir(), 'tbboot-issue-5-'));
  await cp(fixtureRoot, root, { recursive: true });
  return { root, consumerRoot: join(root, 'consumer') };
}
```

Implement `proposed/core.mjs` with `YAML.parse`, `node:fs/promises`, and
`node:path`. It must read `manifest.yaml`, resolve local references relative
to the consumer root, reject unsupported URI schemes, load `source.yaml`,
discover only first-level directories containing `recipe.yaml`, sort recipes
by folder name, resolve each input inside the source root, resolve each target
inside the consumer root, and build complete-file writes.

Treat relative paths, drive-letter paths (`C:\\\...`), and UNC paths
(`\\\\\\\\server\\\\share\\\...`) as local. A reference such as
`https://example.test/source` is an unsupported scheme. Use normalized
absolute paths for duplicate detection and `path.relative` to reject escapes.

- [ ] **Step 4: Make the focused test green.**

Run `npm test -- --test-name-pattern="installs shared"`. Expected: PASS with
the two files created and no diagnostics.

- [ ] **Step 5: Commit the first vertical slice.**

```powershell
git add prototypes/issue-5/proposed prototypes/issue-5/test
git commit -m "feat: plan local source file steps"
```

### Task 3: Add managed fragments, no-ops, and idempotence

**Files:**

- Modify: `prototypes/issue-5/proposed/core.mjs`
- Modify: `prototypes/issue-5/test/prototype.test.mjs`

**Interfaces:**

- Fragment markers are deterministic:
  `<!-- managed-by: <source-folder-name>/<recipe-id> -->` and
  `<!-- end-managed-by: <source-folder-name>/<recipe-id> -->`.
- Distinct fragment markers may target one file and are composed in recipe order;
  the same marker may occur only once.

- [ ] **Step 1: Write the failing fragment/idempotence test.**

```js
test('installs distinct managed fragments and is idempotent', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await applyInstall(await planInstall(consumerRoot));
  const first = await readFile(consumerRoot + '/AGENTS.md', 'utf8');

  const secondPlan = await planInstall(consumerRoot);
  assert.deepEqual(secondPlan.diagnostics, []);
  assert.ok(secondPlan.writes
    .filter(({ kind }) => kind === 'file-fragment')
    .every(({ action }) => action === 'noop'));
  await applyInstall(secondPlan);

  assert.equal(await readFile(consumerRoot + '/AGENTS.md', 'utf8'), first);
  assert.match(first, /managed-by: source\\/baseline/);
  assert.match(first, /managed-by: source\\/review/);
  assert.match(first, /Keep this unmanaged text\./);
});
```

- [ ] **Step 2: Run the focused test and confirm red.**

Run `npm test -- --test-name-pattern="managed fragments"`. Expected: FAIL
because `file-fragment` is not yet planned.

- [ ] **Step 3: Implement fragment planning and grouped target simulation.**

For each target file, start from its current bytes and apply planned fragment
operations in recipe order in memory. If a marker pair is absent, append the
complete block with one separating newline. If the marker pair and exact block
are present, emit `noop`. If the marker is duplicated, only one marker end is
missing, or the existing block differs, emit an error diagnostic. Write one
final content value per target so two new fragments do not overwrite each other.

- [ ] **Step 4: Run the focused test and confirm green.**

Run `npm test -- --test-name-pattern="managed fragments"`. Expected: PASS,
including unchanged bytes after the second installation.

- [ ] **Step 5: Commit the fragment slice.**

```powershell
git add prototypes/issue-5/proposed/core.mjs prototypes/issue-5/test/prototype.test.mjs
git commit -m "feat: manage idempotent file fragments"
```

### Task 4: Enforce complete preflight and conflict behavior

**Files:**

- Modify: `prototypes/issue-5/proposed/core.mjs`
- Modify: `prototypes/issue-5/test/prototype.test.mjs`

**Interfaces:**

- `planInstall` never writes, even when it finds errors.
- Any preflight error prevents `applyInstall` from writing and reports the
  offending source, recipe, step, and target.

- [ ] **Step 1: Add failing tests for the safety matrix.**

Add tests that mutate a temporary manifest/source and assert the diagnostic code
plus unchanged filesystem state for duplicate normalized source references,
source-input escapes, absolute/escaping targets, two `file` steps sharing a
target, a `file` step sharing a target with a fragment, modified complete
files, modified fragments, incomplete marker pairs, and duplicate fragment
markers. Add one test confirming all errors are reported in one plan.

Use this assertion shape:

```js
import { access, writeFile } from 'node:fs/promises';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('rejects duplicate normalized source references before writing', async () => {
  const { consumerRoot } = await fixtureConsumer();
  await writeFile(consumerRoot + '/manifest.yaml',
    'sources:\n  - ../source\n  - ./../source\n');
  const plan = await planInstall(consumerRoot);

  assert.ok(plan.diagnostics.some(({ code }) => code === 'duplicate-source'));
  await applyInstall(plan);
  assert.equal(await exists(consumerRoot + '/.editorconfig'), false);
});
```

- [ ] **Step 2: Run the focused safety tests and confirm red.**

Run `npm test -- --test-name-pattern="duplicate|escape|conflict|drift|preflight"`.
Expected: at least one failure for every rule not yet implemented.

- [ ] **Step 3: Add validation before the write phase.**

Use stable diagnostic codes:
`duplicate-source`, `unsupported-source-scheme`,
`source-input-escape`, `target-escape`, `file-target-collision`,
`fragment-marker-collision`, `file-drift`, `fragment-drift`, and
`incomplete-fragment`. Collect every diagnostic while planning. Make
`applyInstall` return without calling `writeFile` when any error exists.

- [ ] **Step 4: Run the safety tests and confirm green.**

Run the focused command again, then `npm test`. Expected: every preflight
case fails safely with no new or modified target files.

- [ ] **Step 5: Commit the safety slice.**

```powershell
git add prototypes/issue-5/proposed/core.mjs prototypes/issue-5/test/prototype.test.mjs
git commit -m "feat: preflight prototype writes and conflicts"
```

### Task 5: Expose `doctor`, dry-run, and install through the CLI

**Files:**

- Create: `prototypes/issue-5/proposed/cli.mjs`
- Modify: `prototypes/issue-5/test/prototype.test.mjs`
- Modify: `prototypes/issue-5/package.json`

**Interfaces:**

- `node proposed/cli.mjs doctor --root <consumer-root>` performs no writes.
- `node proposed/cli.mjs install --dry-run --root <consumer-root>` performs no writes and prints the plan.
- `node proposed/cli.mjs install --root <consumer-root>` preflights, then applies.
- Exit code is 0 for a clean plan, 1 for preflight/conflict diagnostics, and 2
  for invalid CLI usage or missing external comparison prerequisites.

- [ ] **Step 1: Write failing CLI tests.**

Spawn the CLI with `process.execPath` and assert output, exit code, and consumer
bytes for read-only doctor, no-write dry-run, successful install, and failed
install with no writes.

- [ ] **Step 2: Run the CLI tests and confirm red.**

Run `npm test -- --test-name-pattern="doctor|dry-run|CLI"`. Expected: FAIL
because `proposed/cli.mjs` does not exist.

- [ ] **Step 3: Implement the minimal argument parser and output formatter.**

Accept only `doctor` and `install`, optional `--dry-run`, and required
`--root <path>`. Call `planInstall`, print diagnostics as
`<severity> [<code>] <message>`, print actions as `<action> <target>`, and
call `applyInstall` only for a non-dry-run plan with no errors. Set
`process.exitCode` instead of throwing user-facing errors.

- [ ] **Step 4: Run the CLI tests and confirm green.**

Run the focused command and then `npm test`. Expected: doctor and dry-run leave
the fixture byte-identical; install creates the expected files; invalid plans
write nothing.

- [ ] **Step 5: Commit the CLI slice.**

```powershell
git add prototypes/issue-5/proposed/cli.mjs prototypes/issue-5/package.json prototypes/issue-5/test/prototype.test.mjs
git commit -m "feat: expose prototype doctor and install commands"
```

### Task 6: Implement the composition comparison path

**Files:**

- Create: `prototypes/issue-5/composition/chezmoi-source/dot_editorconfig`
- Create: `prototypes/issue-5/composition/chezmoi-source/docs/project-guide.md`
- Create: `prototypes/issue-5/composition/composition.ps1`
- Create: `prototypes/issue-5/composition.ps1`
- Modify: `prototypes/issue-5/composition/README.md`

**Interfaces:**

- `composition/composition.ps1` accepts `-ConsumerRoot`, `-Mode doctor|dry-run|install`, and `-SourceRoot`.
- It uses `chezmoi --source <source> --destination <consumer> apply`, with `--dry-run --verbose` for dry-run and `--error-on-conflict` for install.
- It applies the two `AGENTS.md` blocks with the smallest PowerShell helper, preserving unmanaged text and refusing changed/incomplete markers.
- Root `composition.ps1` forwards the same modes so `npm run compare` has one stable entry point.

- [ ] **Step 1: Add the composition source state and prerequisite check.**

Copy the exact complete-file contents from the proposed fixture into the two
chezmoi source files, using `dot_editorconfig` for `.editorconfig`. The
comparison adapter must fail clearly with exit code 2 when `chezmoi` is
unavailable instead of silently substituting the proposed path.

- [ ] **Step 2: Implement the composition adapter.**

Use this command shape:

```powershell
$chezmoiArgs = @('--source', $SourceRoot, '--destination', $ConsumerRoot,
  '--no-pager', 'apply', '--error-on-conflict')
if ($Mode -eq 'dry-run') { $chezmoiArgs += @('--dry-run', '--verbose') }
& chezmoi @chezmoiArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The fragment helper reads each block, derives the same marker from its recipe
name, appends absent blocks, leaves exact blocks unchanged, and returns an
error for drift or incomplete markers. It never invokes a shell command from
fixture data.

- [ ] **Step 3: Run the composition smoke check.**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/issue-5/composition.ps1 -Mode doctor -ConsumerRoot <temp-consumer> -SourceRoot <composition-source>
```

Expected: a read-only diagnostic with `chezmoi`, or exit code 2 with a clear
prerequisite message when it is unavailable.

- [ ] **Step 4: Commit the composition slice.**

```powershell
git add prototypes/issue-5/composition prototypes/issue-5/composition.ps1
git commit -m "feat: add issue 5 composition comparison"
```

### Task 7: Run the matrix, write the report and verdict, and verify the prototype

**Files:**

- Create: `prototypes/issue-5/run-comparison.ps1`
- Create: `prototypes/issue-5/comparison-report.md`
- Modify: `prototypes/issue-5/README.md`
- Modify: `prototypes/issue-5/test/prototype.test.mjs`

**Interfaces:**

- `run-comparison.ps1` copies the fixture to separate temporary consumer roots,
  runs the same scenario matrix through both paths, and writes a report with
  commands, setup steps, custom-code footprint, diagnostics, conflict/drift
  behavior, and idempotence.
- The report contains an explicit verdict: keep the project as an integration
  repository or proceed with a differentiated product. The verdict cites
  measured setup cost, custom code, and scenario coverage.

- [ ] **Step 1: Add the matrix cases.**

For each path, execute source/recipe discovery, complete-file creation,
recipe-local input, two fragments in one target, doctor, dry-run, preflight
failure, identical no-op, drift, conflict, duplicate source reference, and a
second install. Capture exit codes and target snapshots before and after every
write-capable command.

- [ ] **Step 2: Generate the report from observed results.**

Write a Markdown table with one row per scenario and columns for composition,
proposed semantics, writes, diagnostics, and notes. Add a measured comparison
of setup instructions and non-fixture code. End with a verdict that the
experiment can be rerun from the documented commands.

- [ ] **Step 3: Document the Windows run commands.**

`README.md` must contain:

```powershell
Set-Location prototypes/issue-5
npm install
npm test
npm run compare
```

It must state that the fixture is throwaway, that `doctor` and dry-run are
read-only, and that composition requires the external tools documented in
`composition/README.md`.

- [ ] **Step 4: Run final verification.**

Run from the repository root:

```powershell
npm test --prefix prototypes/issue-5
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/issue-5/run-comparison.ps1
git diff --check HEAD~1..HEAD
git status --short
```

Expected: the Node suite exits 0; the comparison runner either records both
paths or records the missing composition prerequisite without claiming that
path was exercised; `git diff --check` is clean; and only intended prototype,
documentation, and `AGENTS.md` files are changed.

- [ ] **Step 5: Review and commit the complete prototype.**

Run `git diff --stat origin/main..HEAD` and inspect the final report against every
issue #5 acceptance criterion. Then commit:

```powershell
git add prototypes/issue-5
git commit -m "feat: add issue 5 declarative environment prototype"
```

## Coverage self-review

- Prototype isolation instruction: Task 1.
- Local source and `recipe.yaml` discovery: Tasks 1–2.
- Shared and recipe-local inputs plus complete files: Tasks 1–2.
- Fragments, multiple targets, no-ops, idempotence, drift, and conflicts: Tasks 3–4.
- Read-only doctor and no-write dry-run: Task 5.
- Preflight before writes and duplicate references: Task 4.
- Composition with existing tooling: Task 6.
- Setup, custom code, diagnostics, conflict behavior, drift, idempotence, and written verdict: Task 7.
- Excluded production features: Global Constraints.
