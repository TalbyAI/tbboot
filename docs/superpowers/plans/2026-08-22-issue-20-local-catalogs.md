# Local Catalog Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Issue 20 local Catalog registry and deterministic discovery commands without coupling direct Source installation to the registry.

**Architecture:** Extend the existing versioned contract with a small Catalog registry document. Put registry I/O, Catalog validation, Source identity normalization, and search in one `src/catalog.ts` module; keep `src/cli.ts` responsible for parsing and rendering. Exercise the real CLI with temporary profile and Catalog files.

**Tech Stack:** Node `>=24.12 <25`, native TypeScript, `node:util.parseArgs`, `node:fs/promises`, `yaml`, `ajv`, and `node:test`.

## Global Constraints

- Catalog files keep the existing `schemaVersion: 1` and `entries` shape.
- The registry is `%USERPROFILE%\\.tbboot\\catalogs.yaml` with `schemaVersion: 1` and `{ name, path }` entries.
- Registry names resolve case-insensitively; the displayed spelling is preserved.
- Default names are the Catalog basename without its extension.
- Normalized registry paths are unique; Source identities are unique only within one Catalog.
- Relative local Source locators resolve from the Catalog file directory.
- `doctor`, `install`, and `uninstall` do not read the Catalog registry.
- No new dependency, cache, remote Source resolution, or Catalog mutation is added.
- Public acceptance is through the real CLI; no mocks of internal collaborators.

---

### Task 1: Add the Catalog registry contract

**Files:**

- Modify: `schemas/contract-v1.json`
- Modify: `src/contract.ts`
- Create: `test/catalog-contract.test.ts`

**Interfaces:**

- Produces `CatalogEntry`, `CatalogDocument`, `CatalogRegistryEntry`, and `CatalogRegistryDocument` types.
- Extends `DocumentKind`, `DocumentByKind`, and `validateDocument` with `catalog-registry`.

- [ ] **Step 1: Write the failing contract tests.**

Create `test/catalog-contract.test.ts` with the public validator seam:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { validateDocument } from "../src/contract.ts";

test("accepts the local Catalog registry shape", () => {
 const result = validateDocument({
  kind: "catalog-registry",
  text: "schemaVersion: 1\\ncatalogs:\\n  - name: team\\n    path: C:/shared/catalog.yaml\\n",
  document: ".tbboot/catalogs.yaml",
 });
 assert.deepEqual(result.diagnostics, []);
 assert.equal(result.value?.catalogs[0]?.name, "team");
});

test("rejects a registry with an empty name", () => {
 const result = validateDocument({
  kind: "catalog-registry",
  text: "schemaVersion: 1\\ncatalogs:\\n  - name: ''\\n    path: C:/catalog.yaml\\n",
  document: ".tbboot/catalogs.yaml",
 });
 assert.equal(result.value, undefined);
 assert.equal(result.diagnostics[0]?.code, "schema-validation-failed");
});
```

- [ ] **Step 2: Run the contract test and verify it fails.**

Run: `node --test test/catalog-contract.test.ts`
Expected: FAIL because `catalog-registry` is not yet a supported document kind.

- [ ] **Step 3: Add the JSON schema and TypeScript types.**

Add a `$defs.catalog-registry` object requiring `schemaVersion` and a
`catalogs` array of `{ name, path }` objects with no additional properties.
Add these types to `src/contract.ts`:

```ts
export type CatalogEntry = {
 title: string;
 description: string;
 keywords: string[];
 source: SourceReference;
};
export type CatalogDocument = { schemaVersion: 1; entries: CatalogEntry[] };
export type CatalogRegistryEntry = { name: string; path: string };
export type CatalogRegistryDocument = {
 schemaVersion: 1;
 catalogs: CatalogRegistryEntry[];
};
```

Add `"catalog-registry"` to `DocumentKind`, `DocumentByKind`, and
`documentKinds`; replace the current `Record<string, unknown>` Catalog type
with `CatalogDocument`.

- [ ] **Step 4: Run the contract test and verify it passes.**

Run: `node --test test/catalog-contract.test.ts`
Expected: both tests pass.

- [ ] **Step 5: Commit the contract slice.**

```text
git add schemas/contract-v1.json src/contract.ts test/catalog-contract.test.ts
git commit -m "feat: define local catalog registry contract"
```

### Task 2: Implement Catalog registry loading and discovery

**Files:**

- Create: `src/catalog.ts`
- Create: `test/catalog.e2e.test.ts`

**Interfaces:**

- Consumes `CatalogDocument`, `CatalogRegistryDocument`, `SourceReference`, `Diagnostic`, `validateDocument`, `normalizeGitRepository`, and `normalizeGitPath`.
- Produces `runCatalog(command, options): Promise<CatalogResult>` for the CLI.

Use these public command types:

```ts
export type CatalogCommand =
 | { name: "add"; path: string; catalogName?: string }
 | { name: "list" }
 | { name: "info"; selector: string }
 | { name: "search"; term: string; catalogName?: string }
 | { name: "remove"; selector: string };
export type CatalogRunOptions = { cwd?: string; profileRoot?: string };
export type CatalogResult = {
 envelope: CatalogEnvelope;
 exitCode: 0 | 1;
 stderr: string;
};
export async function runCatalog(
 command: CatalogCommand,
 options?: CatalogRunOptions,
): Promise<CatalogResult>;
```

- [ ] **Step 1: Write the first failing E2E test.**

Create a temporary profile and valid Catalog, invoke `node src/cli.ts catalog
add <path> --json`, and assert that the registry contains the default basename
without extension. Use `runCommand` from `test/support.ts`, set both
`USERPROFILE` and `HOME` to the temporary profile, and assert the original
Catalog remains unchanged.

- [ ] **Step 2: Run the E2E test and verify it fails.**

Run: `node --test test/catalog.e2e.test.ts`
Expected: FAIL because the CLI rejects the `catalog` command.

- [ ] **Step 3: Implement the registry and Catalog helpers.**

Implement these minimum helpers in `src/catalog.ts`:

```ts
function registryPath(profileRoot: string): string;
async function readRegistry(profileRoot: string): Promise<CatalogRegistryDocument>;
async function writeRegistry(profileRoot: string, document: CatalogRegistryDocument): Promise<void>;
async function readCatalog(path: string): Promise<CatalogDocument>;
async function sourceIdentity(catalogPath: string, source: SourceReference): Promise<string>;
```

Use `process.env.USERPROFILE ?? process.env.HOME` when `profileRoot` is not
provided. Treat a missing registry as `{ schemaVersion: 1, catalogs: [] }`.
Validate YAML through `validateDocument`; map invalid registry/Catalog reads to
the stable diagnostic codes in the spec. Resolve Catalog paths with `realpath`
so symlink aliases are duplicates. Resolve relative local and non-URL Git
locators against the Catalog directory; omit selectors from identities and use
case-folding only where the existing filesystem semantics require it.

Reject duplicate names case-insensitively, duplicate normalized registry paths,
and duplicate Source identities within one Catalog. Do not resolve Git refs or
read remote repositories. Read operations return data and diagnostics without
writes. Write the registry only after validation, creating `.tbboot` and
replacing the file after the complete new document is serialized.

- [ ] **Step 4: Run the first E2E test and verify it passes.**

Run: `node --test test/catalog.e2e.test.ts`
Expected: the add scenario passes and the original Catalog file is unchanged.

- [ ] **Step 5: Add one behavior at a time with red-green checks.**

Extend the same E2E seam in this order and run the single file after each
behavior:

```text
list -> info by name -> info by path -> remove -> invalid Catalog ->
duplicate name/path -> duplicate Source within one Catalog -> duplicate Source
across Catalogs -> relative local locator -> global search -> scoped search ->
case-insensitive terms -> multiple terms -> deterministic ordering -> no matches
```

Each test must assert the real exit code, JSON envelope, filesystem result, and
that read-only commands leave the profile and Catalog files unchanged.

- [ ] **Step 6: Commit the Catalog module and tests.**

```text
git add src/catalog.ts test/catalog.e2e.test.ts
git commit -m "feat: add local catalog discovery"
```

### Task 3: Wire Catalog commands into the CLI

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/catalog.e2e.test.ts`

**Interfaces:**

- `parseCommandLine` accepts the five `catalog` forms and `--json`.
- `main` dispatches the parsed discriminated union to `runCatalog`.
- Human output renders Catalog actions, summaries, results, and diagnostics.

- [ ] **Step 1: Add parser tests that fail.**

Add E2E usage cases for missing subcommands, unknown options, extra
positionals, missing path/name/term, and valid quoted multi-word search terms.
Assert exit code `2`, empty stdout, and usage on stderr for invalid cases.

- [ ] **Step 2: Run the parser tests and verify they fail.**

Run: `node --test test/catalog.e2e.test.ts`
Expected: FAIL because the current parser accepts only `doctor`, `install`, and
`uninstall`.

- [ ] **Step 3: Add the catalog parser and dispatch.**

Add catalog usage lines and a parser branch before the existing root/options
logic. Use `parseArgs({ allowPositionals: true, strict: true })`, accept only
`--json`, and enforce these positional counts:

```text
add:    1 or 2
list:   0
info:   1
search: 1 or 2
remove: 1
```

Add `CatalogEnvelope` to `CommandEnvelope`, dispatch `runCatalog`, and keep the
existing three commands unchanged. Render Catalog-specific payload fields
before shared diagnostics in human mode.

- [ ] **Step 4: Run the parser and command tests.**

Run: `node --test test/catalog.e2e.test.ts`
Expected: all Catalog command and usage tests pass.

- [ ] **Step 5: Commit the CLI slice.**

```text
git add src/cli.ts test/catalog.e2e.test.ts
git commit -m "feat: expose catalog CLI commands"
```

### Task 4: Verify, review, and prepare the pull request

**Files:**

- Modify only files identified by verification or review findings.

- [ ] **Step 1: Run the focused tests and typecheck.**

```text
npm run typecheck
node --test test/catalog-contract.test.ts test/catalog.e2e.test.ts
```

Expected: exit code `0` for both commands.

- [ ] **Step 2: Run repository checks.**

```text
npm run check
npm run build
npm test
```

Expected: all commands exit `0`; the full test suite reports no failures.

- [ ] **Step 3: Run the two-axis code review against `main`.**

Use `git diff main...HEAD` and review standards and spec coverage separately.
Fix only actionable findings within Issue 20, then rerun the focused checks and
full suite.

- [ ] **Step 4: Commit any review fixes and verify the branch.**

```text
git status --short --branch
git log main..HEAD --oneline
git diff --check main...HEAD
```

Expected: only Issue 20 files and its design/plan artifacts are changed; the
branch is clean after committing fixes.

- [ ] **Step 5: Push and create the pull request without closing the issue.**

```text
git push --set-upstream origin issue/20-local-catalogs
gh pr create --base main --head issue/20-local-catalogs --title "feat: discover Sources through local Catalogs" --body-file <reviewed-body-file>
```

The PR body must reference `#20` without `Closes #20` or another closing
keyword. Re-read the PR after creation and verify its body, base, head, and
that Issue 20 remains open.

## Self-review checklist

- [x] Every command and acceptance criterion in the design has a task.
- [x] The plan uses the existing validator, Git helpers, YAML dependency, CLI
  parser, test runner, and process helper.
- [x] No task adds a cache, dependency, remote resolution, or unrelated
  refactor.
- [x] The TDD seam is the real CLI; contract validation is covered only at its
  exported public validator boundary.
- [x] No placeholders or unspecified future work are required to execute the
  tasks.
