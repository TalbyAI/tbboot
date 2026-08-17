# CI Quality Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize the local quality scripts and finish a reproducible Windows GitHub Actions pipeline for Markdown, code, typecheck, build, and tests.

**Architecture:** Reuse the existing Biome, markdownlint, and configuration files. `package.json` exposes six canonical local quality commands; the workflow runs the two read-only check components plus typecheck, build, and tests as separate fail-fast steps on `windows-latest` after `npm ci`.

**Tech Stack:** Node `>=24.12 <25`, npm, ESM with native Node type stripping, `@biomejs/biome`, `markdownlint-cli2`, GitHub Actions `actions/checkout@v6`, `actions/setup-node@v6`, TypeScript, and Node’s built-in test runner.

## Global Constraints

- The package is ESM and uses native Node type stripping to execute `src/cli.ts` directly.
- `package.json` declares Node `>=24.12 <25` and the bin points to `src/cli.ts`.
- CI uses `windows-latest`, runs `npm ci`, and reads the Node version from `package.json` with `node-version-file: package.json`.
- Biome `check` runs over `src/` and `test/`, covering lint and code format; its existing scope configuration remains unchanged.
- Markdown checks cover only `AGENTS.md`, `CONTEXT.md`, and `docs/**/*.md`; `prototypes/**` is excluded.
- `fix:md`, `fix:code`, and `fix` are opt-in local fixes and are never run by CI or hooks.
- No dependency, formatter configuration, transpiler, bundler, generated output, coverage, security analysis, deployment, publication, or new test framework is added.
- Do not change the JSON contract, diagnostics, exit codes, CLI behavior, persistence, or production implementation semantics.
- `prototypes/` is not part of the main repository pipeline.
- Do not use `continue-on-error`, `|| true`, or equivalent failure suppression.
- Keep commits on the existing `issue/33-ci-quality-pipeline` branch and never push automatically.

---

## File Map

- Modify `package.json`: replace the old quality script names with the six canonical commands.
- Verify `package-lock.json`, `biome.json`, and `.markdownlint-cli2.jsonc`: reuse the existing dependencies and scopes without adding configuration.
- Modify the existing canonical Markdown documents listed in Task 3: apply fixable standard-rule corrections without changing their meaning.
- Modify `.github/workflows/ci.yml`: run the five CI quality gates on pull requests and pushes to `main`.
- Modify `src/cli.ts`, `src/contract.ts`, `src/doctor.ts`, or `test/doctor.e2e.test.ts` only when `fix:code` reports a mechanical change; retain behavior and verify the existing suite.

## Interfaces

Task 1 produces these exact six local quality commands, which later tasks and the workflow consume:

```json
{
  "check:md": "markdownlint-cli2",
  "check:code": "biome check src test",
  "check": "npm run check:md && npm run check:code",
  "fix:md": "markdownlint-cli2 --fix",
  "fix:code": "biome check --write src test",
  "fix": "npm run fix:md && npm run fix:code"
}
```

The existing `biome.json` provides scope `src/**` and `test/**`; `biome check` uses that scope for both lint and format.

The existing `.markdownlint-cli2.jsonc` provides the Markdown globs; invoking `markdownlint-cli2` with no arguments uses the same scope locally and in CI.

Task 4 consumes `check:md`, `check:code`, `typecheck`, `build`, and `test` and exposes each as a separate workflow step. It does not expose the local aggregate `check` as an additional CI step.

### Task 1: Normalize reproducible local quality scripts

**Files:**

- Modify: `package.json`

**Interfaces:** Produces exact local `check:md`, `check:code`, `check`, `fix:md`, `fix:code`, and `fix` commands while preserving `test`, `doctor`, `typecheck`, and `build`.

- [ ] **Step 1: Record the current regression baseline**

Run:

```powershell
npm run check
npm test
npm run typecheck
npm run build
```

Expected: all commands exit `0`; the current test run reports 18 passing tests and 1 platform-specific skipped test. Do not change source files during this baseline.

- [ ] **Step 2: Verify the existing dependency and configuration boundary**

Run:

```powershell
npm ci
npm pkg get devDependencies
Test-Path biome.json
Test-Path .markdownlint-cli2.jsonc
```

Expected: `npm ci` succeeds; `@biomejs/biome` and `markdownlint-cli2` are already under `devDependencies`; both configuration files exist; and this task does not change `package-lock.json`.

- [ ] **Step 3: Add the exact npm scripts**

Replace the old quality entries with these exact entries:

```json
"check:md": "markdownlint-cli2",
"check:code": "biome check src test",
"check": "npm run check:md && npm run check:code",
"fix:md": "markdownlint-cli2 --fix",
"fix:code": "biome check --write src test",
"fix": "npm run fix:md && npm run fix:code"
```

Remove `lint`, `lint:fix`, `format:check`, and `format:md`. Preserve these commands exactly: `test`, `doctor`, `typecheck`, and `build`; `build` remains `node --check src/cli.ts` and does not emit JavaScript.

- [ ] **Step 4: Verify the clean-install dependency boundary**

Run:

```powershell
npm ci
npm pkg get scripts.check:md scripts.check:code scripts.check scripts.fix:md scripts.fix:code scripts.fix scripts.test scripts.doctor scripts.typecheck scripts.build
rg -n '"(lint|lint:fix|format:check|format:md)"' package.json
```

Expected: `npm ci` succeeds using the unchanged lockfile, the six canonical scripts match the exact values above, the preserved scripts remain available, and `rg` finds no removed script name in `package.json`.

- [ ] **Step 5: Commit the package boundary**

```powershell
git add package.json
git commit -m "chore: normalize quality scripts"
```

### Task 2: Verify the Biome code gate and keep scoped fixes safe

**Files:**

- Modify only when reported by Biome: `src/cli.ts`
- Modify only when reported by Biome: `src/contract.ts`
- Modify only when reported by Biome: `src/doctor.ts`
- Modify only when reported by Biome: `test/doctor.e2e.test.ts`

**Interfaces:** Consumes the existing `@biomejs/biome` executable and `biome.json`, and produces the read-only `npm run check:code` gate over production source and tests plus the explicit local `npm run fix:code` command.

- [ ] **Step 1: Verify the existing Biome configuration**

Confirm `biome.json` contains the existing scope and recommended linter:

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "files": {
    "includes": ["src/**", "test/**"]
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  }
}
```

Keep this configuration unchanged. Do not add a `prototypes` glob, a schema/document glob, generated-file coverage, a global suppression, or a separate formatter configuration.

- [ ] **Step 2: Run the code gate before applying fixes**

Run:

```powershell
npm run check:code
```

Expected: the command exits `0` when the current files satisfy the recommended Biome lint and format rules; every finding is under `src/` or `test/` and is a real Biome diagnostic rather than a prototype or documentation diagnostic.

- [ ] **Step 3: Apply only Biome’s explicit local code fixes**

Run:

```powershell
npm run fix:code
git diff -- src test
```

Keep only mechanical lint or format changes that preserve the existing JSON contract, diagnostics, exit codes, action ordering, filesystem behavior, and E2E assertions. Do not add suppressions merely to avoid a finding, and do not change tests to weaken their assertions.

- [ ] **Step 4: Verify the source boundary and runtime behavior**

Run:

```powershell
npm run check:code
npm run typecheck
npm run check
npm test
git diff --check
```

Expected: all commands pass; any changed source or test file contains only mechanical code-quality edits; no `.js`, source map, or build directory is emitted.

- [ ] **Step 5: Commit the Biome gate**

```powershell
git add src/cli.ts src/contract.ts src/doctor.ts test/doctor.e2e.test.ts
git commit -m "chore: normalize Biome code gate"
```

### Task 3: Configure Markdown scope and normalize existing rule violations

**Files:**

- Verify: `.markdownlint-cli2.jsonc`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md` only if the fix command reports a fixable violation
- Modify: `docs/agents/domain.md`
- Modify: `docs/PROJECT-APPROACH.md`
- Modify: `docs/superpowers/plans/2026-08-15-issue-12-acceptance-fixture.md`
- Modify: `docs/superpowers/plans/2026-08-16-issue-13-production-doctor-cli.md`
- Modify: `docs/superpowers/plans/2026-08-16-issue-31-static-typecheck.md`
- Modify: other files under `docs/**/*.md` only when the standard fix command identifies a concrete fixable violation

**Interfaces:** Consumes the existing `.markdownlint-cli2.jsonc` through `check:md` and `fix:md`, sharing the same Markdown scope between local development and CI while keeping `prototypes/**` out of the file set.

- [ ] **Step 1: Verify the existing Markdown configuration**

Confirm `.markdownlint-cli2.jsonc` contains:

```jsonc
{
  "config": {
    "default": true,
    "MD013": false
  },
  "globs": [
    "AGENTS.md",
    "CONTEXT.md",
    "docs/**/*.md",
    "!prototypes/**"
  ]
}
```

`MD013` is the only disabled rule because the current canonical corpus has 519 existing line-length findings, including long ADR lines that are intentionally kept intact. Keep all other standard rules enabled; this is not a global Markdown-lint disable. Do not broaden the globs or change the configuration as part of script normalization.

- [ ] **Step 2: Apply the approved local Markdown fix command**

Run:

```powershell
npm run fix:md
```

Review the resulting diff. Keep structural or whitespace fixes that do not change document meaning, and confirm no file under `prototypes/` changed.

- [ ] **Step 3: Make the known non-auto-fix corrections**

Apply these exact corrections if the previous command leaves them present:

- In `docs/agents/domain.md`, label the repository-tree fenced block as `text`.
- In `docs/PROJECT-APPROACH.md`, change the first `## Project Approach...` heading to a top-level `#` heading and add spaces around every pipe in the compact table at the artifact-model section.
- In the three existing superpowers plans listed in this task, place a blank line before and after each `Files` and `Interfaces` list reported by `MD032`, and remove the one duplicate blank line reported by `MD012` in the Issue #13 plan.

Do not disable `MD032`, `MD040`, `MD041`, or `MD060` to avoid these corrections.

- [ ] **Step 4: Verify the exact Markdown scope**

Run:

```powershell
npm run check:md
git diff --check
git status --short
```

Expected: `check:md` exits `0`; the output does not mention `prototypes/`; only the approved canonical Markdown files are changed.

- [ ] **Step 5: Commit the Markdown gate**

```powershell
git add AGENTS.md CONTEXT.md docs/agents/domain.md docs/PROJECT-APPROACH.md docs/superpowers/plans/2026-08-15-issue-12-acceptance-fixture.md docs/superpowers/plans/2026-08-16-issue-13-production-doctor-cli.md docs/superpowers/plans/2026-08-16-issue-31-static-typecheck.md
git commit -m "chore: normalize Markdown quality gate"
```

### Task 4: Normalize the fail-fast GitHub Actions workflow

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:** Consumes `check:md`, `check:code`, `typecheck`, `build`, and `test`; produces one identifiable CI step for each required quality control without adding the local aggregate `check` as a sixth step.

- [ ] **Step 1: Update the workflow with the approved triggers and runner**

Update `.github/workflows/ci.yml` to:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  quality:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version-file: package.json
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Check Markdown
        run: npm run check:md

      - name: Check TypeScript and JavaScript
        run: npm run check:code

      - name: Typecheck TypeScript
        run: npm run typecheck

      - name: Build CLI entrypoint
        run: npm run build

      - name: Run tests
        run: npm test
```

Do not add `continue-on-error`; default GitHub Actions behavior must stop the job on the first non-zero command and retain the named step.

- [ ] **Step 2: Verify every workflow command locally in order**

Run:

```powershell
npm ci
npm run check:md
npm run check:code
npm run typecheck
npm run build
npm test
```

Expected: every command exits `0`, and `npm run build` only syntax-checks `src/cli.ts`; it does not create an output directory.

- [ ] **Step 3: Check workflow scope and commit it**

Run:

```powershell
$workflow = Get-Content -Raw .github/workflows/ci.yml
if ($workflow -notmatch 'pull_request:' -or $workflow -notmatch 'branches: \[main\]' -or $workflow -notmatch 'runs-on: windows-latest') { throw 'CI trigger or runner scope is incorrect' }
if ($workflow -notmatch 'actions/checkout@v6' -or $workflow -notmatch 'actions/setup-node@v6' -or $workflow -notmatch 'node-version-file: package.json' -or $workflow -notmatch 'cache: npm') { throw 'CI setup is incorrect' }
foreach ($command in @('npm run check:md', 'npm run check:code', 'npm run typecheck', 'npm run build', 'npm test')) { if ($workflow.IndexOf($command) -lt 0) { throw "Missing CI gate: $command" } }
if ($workflow -match '(?m)^\s*run:\s*npm run check\s*$|npm run lint|npm run format:check|continue-on-error|\|\| true') { throw 'A removed command or failure suppression is present' }

git add .github/workflows/ci.yml
git commit -m "ci: normalize quality pipeline steps"
```

### Task 5: Run the complete acceptance matrix and scope audit

**Files:** None beyond the files already listed above.

**Interfaces:** Confirms the six local scripts, unchanged dependency/configuration boundary, five workflow gates, and existing runtime suite work together from a clean install.

- [ ] **Step 1: Recreate the CI install and run the exact verification sequence**

Run:

```powershell
npm ci
npm run fix:md
npm run fix:code
npm run check:md
npm run check:code
npm run check
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: all commands exit `0`; fix commands do not run in the workflow and leave no unreviewed changes.

- [ ] **Step 2: Confirm dependency and workflow acceptance criteria**

Run:

```powershell
npm pkg get engines.node devDependencies
$scripts = npm pkg get scripts | ConvertFrom-Json
if ($scripts.'check:md' -ne 'markdownlint-cli2' -or $scripts.'check:code' -ne 'biome check src test' -or $scripts.check -ne 'npm run check:md && npm run check:code' -or $scripts.'fix:md' -ne 'markdownlint-cli2 --fix' -or $scripts.'fix:code' -ne 'biome check --write src test' -or $scripts.fix -ne 'npm run fix:md && npm run fix:code') { throw 'Canonical quality scripts are incorrect' }
if ($scripts.PSObject.Properties.Name -contains 'lint' -or $scripts.PSObject.Properties.Name -contains 'lint:fix' -or $scripts.PSObject.Properties.Name -contains 'format:check' -or $scripts.PSObject.Properties.Name -contains 'format:md') { throw 'Removed script names remain' }
Select-String -Path .github/workflows/ci.yml -Pattern 'pull_request:|branches: \[main\]|runs-on: windows-latest|npm ci|npm run check:md|npm run check:code|npm run typecheck|npm run build|npm test'
$workflow = Get-Content -Raw .github/workflows/ci.yml
if ($workflow -match '(?m)^\s*run:\s*npm run check\s*$|npm run lint|npm run format:check|continue-on-error|\|\| true') { throw 'Workflow contains a removed command or failure suppression' }
```

Expected: the engine remains `>=24.12 <25`; both tools remain development dependencies; all six canonical local scripts match exactly; the workflow contains the five CI commands after `npm ci`; and the workflow has only the pull-request and `main` push triggers.

- [ ] **Step 3: Confirm no generated artifacts or prototype scope leakage**

Run:

```powershell
$generated = rg --files -g '*.js' -g '*.map' -g '!node_modules/**' -g '!prototypes/**'
if ($generated) { $generated; throw 'Generated JavaScript or source maps are present outside prototypes' }

$prototypeChanges = git status --short -- prototypes
if ($prototypeChanges) { $prototypeChanges; throw 'The main CI work changed prototypes' }

git status --short
git diff --stat HEAD~4..HEAD
```

Expected: no emitted JavaScript or maps exist outside excluded prototype content; no prototype file changed; and the final diff contains only normalized scripts, approved Markdown/code-quality corrections, and the workflow.

- [ ] **Step 4: Record the final regression result**

Run:

```powershell
npm run check
npm test
npm run typecheck
```

Expected: the existing 19-test suite remains 18 passed and 1 skipped on this Windows filesystem, with no production behavior or JSON output changes.

## Self-Review

- Spec coverage: Task 1 covers the six canonical local scripts and removed names; Task 2 covers the existing Biome scope and code checks/fixes; Task 3 covers Markdown scope, fixes, and prototype exclusion; Task 4 covers triggers, Windows runner, Node setup, `npm ci`, and five identifiable fail-fast checks; Task 5 covers exact-script verification, generated-output checks, and regression protection.
- Acceptance coverage: every Issue #33 criterion is directly exercised by a listed command or workflow assertion.
- Placeholder scan: every implementation step names its file paths, configuration contents, commands, and expected outcomes.
- Scope review: no task adds a dependency, formatter configuration, compiler, bundler, test framework, deployment, release, coverage, security analysis, prototype pipeline, or production behavior change.
- Baseline evidence: `npm run check`, `npm test`, and `npm run typecheck` already pass; Markdown baseline is 548 findings, with `MD013` accounting for 519 and therefore the only configured exception.
