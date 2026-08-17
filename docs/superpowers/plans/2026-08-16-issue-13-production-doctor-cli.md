# Production `doctor` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `tbboot doctor` for local Sources and first-level Recipes, with closed schema validation, File/File Fragment checks, human/JSON output, and a byte-for-byte read-only guarantee.

**Architecture:** `src/cli.ts` owns argument parsing, rendering, and exit codes. `src/contract.ts` owns YAML 1.2 parsing, AJV validation, and Issue #9 diagnostics. `src/doctor.ts` owns local traversal, canonical path safety, collision registration, Artifact checks, and envelope aggregation. Tests invoke the real CLI process and inspect only its streams, exit code, envelope, and filesystem.

**Tech Stack:** Node `>=24.12 <25` with native type stripping, npm, `yaml` version `^2.8.1`, `ajv` version `^8.17.1`, and Node built-ins.

## Global Constraints

- Production files are `package.json`, `schemas/contract-v1.json`, `src/cli.ts`, `src/contract.ts`, `src/doctor.ts`, and `test/doctor.e2e.test.ts` at the repository root. Do not create `prototypes/issue-13/`.
- Promote `prototypes/issue-9/contract.schema.json` byte-for-byte; production code must not import from prototypes.
- Command: `tbboot doctor [--root <consumer-root>] [--json]`. Omitted root means the current directory. Unknown or malformed arguments print usage to stderr and return `2`.
- JSON stdout is exactly one document and contains no logs. Human stdout contains actionable diagnostics and states.
- Envelope: `{ schemaVersion: 1, command: "doctor", status, changed: false, actions, diagnostics }`; status is `ok`, `warning`, or `error`.
- AJV is created once with `{ strict: true, allErrors: true, discriminator: true }`; the promoted schema must compile and validate a canonical document before implementation proceeds.
- Every Artifact action contains `source`, `recipe`, one-based `step`, `type`, declared `target`, and state in `satisfied`, `missing`, `drift`, `conflict`.
- Every diagnostic contains `code`, `severity`, and `message`, plus available `document`, JSON Pointer `path`, `source`, `recipe`, and one-based `step`.
- Preserve #9 codes: `yaml-parse-error`, `schema-version-missing`, `schema-version-unsupported`, `schema-validation-failed`, `recipes-empty`, `recipes-not-supported`, `requires-not-supported`.
- Add only: `manifest-read`, `source-read`, `recipe-read`, `unsupported-source-provider`, `duplicate-source`, `unsupported-step`, `source-input-missing`, `source-input-escape`, `target-escape`, `target-read`, `file-missing`, `file-drift`, `file-target-collision`, `fragment-missing`, `fragment-drift`, `fragment-marker-collision`, `incomplete-fragment`.
- Production `doctor` never calls `mkdir`, `writeFile`, `rm`, `rename`, or an equivalent write/delete API.
- Git, Source dependencies, Custom, installation, uninstall, Catalogs, and effective Recipe selection are out of scope.
- File Fragment markers are exactly `<!-- managed-by: <source-folder>/<recipe-path> -->` and `<!-- end-managed-by: <source-folder>/<recipe-path> -->`.
- Required failure means status `error` and non-zero exit. Optional missing/drift is a warning and does not fail. Clean is `0`.
- Tests snapshot the complete directory trees and file bytes before and after. The child process receives an isolated temporary `USERPROFILE` (and `HOME`) so the snapshot includes `%USERPROFILE%\.tbboot\trust.yaml`, any metadata directory, the Consumer tree, Artifacts, lockfile, and Installation record.
- Optionality applies to step-level artifact/read failures only: optional missing/drift, missing Source input, target read failures, and unsupported Custom Steps are warnings; contract errors, source/provider failures, path escapes, and structural collisions remain fatal regardless of `optional`.
- File Fragment checks read UTF-8 text, normalize CRLF and lone CR to LF without trimming other content, and compare the exact managed block defined in Task 5. The block has no trailing LF; marker line boundaries and surrounding separators are handled as specified there.

## File Map

- `package.json` / `package-lock.json`: root package, executable bin, scripts, and dependency lock.
- `schemas/contract-v1.json`: closed Issue #9 schema for Manifest, Source, Recipe, Catalog, lockfile, Installation record, and trust.
- `src/contract.ts`: validator and stable contract diagnostics.
- `src/doctor.ts`: read-only discovery, paths, collisions, File/Fragment checks, envelope.
- `src/cli.ts`: parser, output, exit codes.
- `test/doctor.e2e.test.ts`: real-process fixture and acceptance matrix.

## Interfaces

```ts
type DocumentKind =
  | 'manifest' | 'source' | 'recipe' | 'catalog'
  | 'lockfile' | 'state' | 'trust';

type Diagnostic = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  document?: string; path?: string; source?: string;
  recipe?: string; step?: number;
};

type ValidationResult = {
  value?: Record<string, unknown>;
  diagnostics: Diagnostic[];
};

function validateDocument(options: {
  kind: DocumentKind; text: string; document: string;
  source?: string; recipe?: string;
}): ValidationResult;

type DoctorAction = {
  source: string; recipe: string; step: number;
  type: 'file' | 'file-fragment'; target: string;
  state: 'satisfied' | 'missing' | 'drift' | 'conflict';
};

type DoctorEnvelope = {
  schemaVersion: 1; command: 'doctor';
  status: 'ok' | 'warning' | 'error'; changed: false;
  actions: DoctorAction[]; diagnostics: Diagnostic[];
};

function runDoctor(root: string): Promise<{
  envelope: DoctorEnvelope; exitCode: 0 | 1;
}>;
```

`source` is the canonical absolute local Source root; `recipe` is its first-level folder; `target` is the declared repository-relative target.

### Task 1: Bootstrap package and schema

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `schemas/contract-v1.json`

**Interfaces:** Produces the package and schema consumed by Task 2.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "tbboot",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.12 <25" },
  "bin": { "tbboot": "src/cli.ts" },
  "scripts": {
    "check": "node --check src/cli.ts && node --check src/contract.ts && node --check src/doctor.ts && node --check test/doctor.e2e.test.ts",
    "test": "node --test test/doctor.e2e.test.ts",
    "doctor": "node src/cli.ts doctor"
  },
  "dependencies": { "ajv": "^8.17.1", "yaml": "^2.8.1" }
}
```

- [ ] **Step 2: Promote and verify the schema**

Copy `prototypes/issue-9/contract.schema.json` to `schemas/contract-v1.json`. Verify:

```powershell
Compare-Object (Get-Content -Raw prototypes/issue-9/contract.schema.json) (Get-Content -Raw schemas/contract-v1.json)
```

Expected: no output. Do not change `$id`, `$defs`, closed fields, or schemaVersion constraints.

- [ ] **Step 3: Install and check package metadata**

Run `npm install`, `node --version`, and `npm pkg get engines.node`. Expected: Node is in `>=24.12 <25`, only `ajv` and `yaml` are direct dependencies, and `package-lock.json` exists.

- [ ] **Step 4: Commit**

If on `main`, create `issue/13-production-doctor-cli` first. Commit:

```powershell
git add package.json package-lock.json schemas/contract-v1.json
git commit -m "chore: bootstrap production tbboot package"
```

### Task 2: Contract validator and CLI boundary

**Files:**

- Create: `src/contract.ts`
- Create: `src/cli.ts`
- Create: `src/doctor.ts`
- Create: `test/doctor.e2e.test.ts`

**Interfaces:** Consumes Task 1 schema; produces `validateDocument`, `runDoctor`, and the `doctor` process.

- [ ] **Step 1: Write failing process tests**

Use Node built-ins and the reusable Issue #12 harness:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonOutput, runCommand, snapshotFiles }
  from '../prototypes/issue-12/harness.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'src', 'cli.ts');

test('unknown arguments return 2 and print usage only on stderr', async () => {
  const result = await runCommand({
    file: process.execPath,
    args: [cliPath, 'doctor', '--unknown'],
    cwd: projectRoot,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: tbboot doctor/);
});
```

Add a fixture helper in this test file that creates a temporary Consumer and Source, writes canonical `tbboot.yaml`, `source.yaml`, `recipe.yaml`, and returns { root, consumerRoot, sourceRoot, cleanup }. Add an invalid-YAML process test: `doctor --json`, exit `1`, empty stderr, exactly one JSON document, and one `yaml-parse-error` for `tbboot.yaml`.

Add an AJV compile/validation smoke test through the real CLI using the
canonical fixture. It must reach a valid Manifest and return `0` with no
`schema-validation-failed` diagnostic; an AJV discriminator compile failure
must fail this test rather than being swallowed by the child-process harness.

- [ ] **Step 2: Run focused tests**

Run `node --test test/doctor.e2e.test.ts --test-name-pattern "unknown arguments|invalid YAML"`. Expected: failure because production files do not exist.

- [ ] **Step 3: Implement contract.ts**

Load the promoted schema once with the exact AJV options required by its
discriminators:

```ts
const ajv = new Ajv({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(contract);
```

Compile every document validator during module initialization and fail fast if
any `$defs` validator is missing. The valid-fixture process test is the
compile/validation smoke test. Parse with `parseAllDocuments` using
`schema: 'core'`, `uniqueKeys: true`, `version: '1.2'`. Reject YAML 1.1
directives, empty/multiple documents, and parse errors as `yaml-parse-error`.
Check schemaVersion before AJV. Map AJV `additionalProperties`, `required`,
`dependencies`, `discriminator`, and `uniqueItems` to JSON Pointer paths; derive
one-based Step context from `/steps/<index>`. Apply reserved `recipes` and
`requires` diagnostics, and omit unavailable context properties instead of
writing null.

```ts
if (parseFailed) return {
  value: undefined,
  diagnostics: [diagnostic('yaml-parse-error', message, context)],
};
if (missingVersion) return {
  value: undefined,
  diagnostics: [diagnostic('schema-version-missing',
    'Missing required schemaVersion',
    { ...context, path: '/schemaVersion' })],
};
if (value.schemaVersion !== 1) return {
  value: undefined,
  diagnostics: [diagnostic('schema-version-unsupported',
    'Unsupported schemaVersion: ' + JSON.stringify(value.schemaVersion),
    { ...context, path: '/schemaVersion' })],
};
if (!validator(value)) return {
  value: undefined,
  diagnostics: actionableErrors(validator.errors).map(toSchemaDiagnostic),
};
```

- [ ] **Step 4: Implement cli.ts and manifest foundation**

Parse only `doctor`, `--root <value>`, and `--json`. Normalize root with `resolve(cwd, value)`; default to `resolve(cwd)`. Missing command/value, duplicate root, and unknown args print usage to stderr and return `2`.

```ts
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv, process.cwd());
  if (!options.ok) {
    process.stderr.write(options.message + '\n'
      + 'usage: tbboot doctor [--root <consumer-root>] [--json]\n');
    return 2;
  }
  const result = await runDoctor(options.root);
  process.stdout.write(options.json
    ? JSON.stringify(result.envelope) + '\n'
    : renderHuman(result.envelope));
  return result.exitCode;
}
```

Set `process.exitCode` from `main`. Implement `runDoctor` to initialize the common envelope, read `<root>/tbboot.yaml`, emit `manifest-read` on read failure, call `validateDocument` for kind `manifest`, stop before Source resolution on contract failure, and return `1` only for error diagnostics.

- [ ] **Step 5: Verify and commit**

Run `npm run check` and the focused tests; expected: pass, one JSON document, no JSON stderr. Commit:

```powershell
git add src/contract.ts src/cli.ts src/doctor.ts test/doctor.e2e.test.ts
git commit -m "feat: add doctor contract and cli boundary"
```

### Task 3: Local Source/Recipe discovery and path safety

**Files:**

- Modify: `src/doctor.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:** Consumes Task 2; produces internal `StepDescriptor` values with canonical Source root, Recipe path, one-based Step, type, input, target, optionality, and path errors.

- [ ] **Step 1: Add failing discovery tests**

Create direct `alpha` and `zulu` Recipe folders, nested `nested/child/recipe.yaml`, and two Steps in `zulu`. Assert order `alpha/1`, `zulu/1`, `zulu/2`. Cover Git provider rejection, normalized duplicate local locators, missing input, input symlink escape, target symlink escape, unknown schema/version, unknown fields, `recipes`, and `requires`. Assert stable codes and JSON Pointer paths and snapshot before/after.

- [ ] **Step 2: Run discovery tests**

Run `node --test test/doctor.e2e.test.ts --test-name-pattern "first-level|provider|duplicate|symlink"`. Expected: failure because Source traversal is absent.

- [ ] **Step 3: Add local Source resolution**

Iterate Manifest Sources in declaration order. Reject non-local providers with `unsupported-source-provider` and `/sources/<index>/provider`. Resolve local locators against the Consumer root, canonicalize existing Source roots, key normalized identity with Windows case folding, reject repeats with `duplicate-source`, read `source.yaml` first, and do not resolve `source.dependencies`.

`resolveLocalSource` must catch every failure while resolving the locator. A
missing path, a path that canonicalizes to a file rather than a directory, a
permission failure, and a broken link all produce exactly one `source-read`
diagnostic with `document: 'tbboot.yaml'` and path
`/sources/<index>/locator/path`. If no canonical root exists, omit `source`
context; do not throw and do not create actions for that Source. Continue with
the next Manifest Source. A successfully canonicalized directory whose
`source.yaml` cannot be read follows the same continue-with-next-source policy
using `source-read` at `source.yaml`.

```ts
for (const [index, reference] of manifest.sources.entries()) {
  if (reference.provider !== 'local') {
    add('unsupported-source-provider',
      { document: 'tbboot.yaml', path: '/sources/' + index + '/provider' });
    continue;
  }
  const sourceRoot = await resolveLocalSource(root, reference.locator.path);
  if (!sourceRoot) continue;
  const key = pathKey(sourceRoot);
  if (seenSources.has(key)) {
    add('duplicate-source',
      { document: 'tbboot.yaml',
        path: '/sources/' + index + '/locator/path',
        source: sourceRoot });
    continue;
  }
  seenSources.add(key);
  await collectSourceSteps(sourceRoot, descriptors);
}
```

- [ ] **Step 4: Discover and validate first-level Recipes**

Call `validateDocument` for `source.yaml` with canonical Source context. Enumerate only direct child directories containing direct `recipe.yaml`, sort lexical names deterministically, and validate each Recipe with `document: 'recipe.yaml'`, Source context, and folder name. Do not use `id` fields or recurse. Preserve Step order and store `step: index + 1`. Emit `source-read` / `recipe-read` for read failures. For schema-valid `custom` Steps, emit `unsupported-step`, create no Artifact action, and do not execute the Step; apply the Step's `optional` severity rule so optional Custom Steps warn and required Custom Steps error.

- [ ] **Step 5: Enforce canonical containment**

Add private `isInside` and `realPathWithMissing` helpers. Inputs resolve from the Recipe directory and must remain in the canonical Source root. Targets resolve from the Consumer root and must remain in its canonical root after existing symlinks are followed. Missing input -> `source-input-missing`; input escape -> `source-input-escape`; target escape -> `target-escape`; other target read failure -> `target-read`. Add a `conflict` action for each affected Artifact Step.

Keep `source-input-escape` and `target-escape` as fatal safety diagnostics even
when the Step is optional. A missing input or ordinary target read failure is a
step-level failure and receives warning severity for an optional Step and error
severity for a required Step. Source-root resolution failures remain fatal
Source-level errors and are never downgraded by a Recipe Step's optionality.

- [ ] **Step 6: Verify and commit**

Run `npm run check` and the discovery/path tests; expected: deterministic order, one-based Steps, reserved-field codes, provider rejection, duplicate detection, and symlink protection pass. Commit:

```powershell
git add src/doctor.ts test/doctor.e2e.test.ts
git commit -m "feat: discover local sources and recipes safely"
```

### Task 4: File Steps and collision semantics

**Files:**

- Modify: `src/doctor.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:** Consumes `StepDescriptor`; produces File actions and `file-missing`, `file-drift`, and `file-target-collision` diagnostics.

- [ ] **Step 1: Add failing File tests**

Cover target bytes that produce `satisfied`, missing target, and drift. Assert action order, `file-missing`/`file-drift`, required exit `1`, and unchanged snapshots. Add a File and File Fragment sharing one target; assert both actions become `conflict` and emit `file-target-collision`.

- [ ] **Step 2: Run File tests**

Run `node --test test/doctor.e2e.test.ts --test-name-pattern "File states|target collision"`. Expected: failure because Artifact checking is absent.

- [ ] **Step 3: Register writers before content checks**

Use `targetWriters: Map<string, StepDescriptor[]>` keyed by canonical target
path and `markerWriters: Map<string, StepDescriptor[]>` keyed by the derived
`<source-folder>/<recipe-path>` marker. Registration is a separate pass before
state checks. Distinct File Fragment markers may share a target. A target group
with more than one writer and at least one File marks every participant
`conflict` and emits one `file-target-collision` diagnostic per participant in
declaration order. A marker group with more than one participant marks every
participant `conflict` and emits one `fragment-marker-collision` diagnostic per
participant, even when the duplicate marker appears on different targets. A
group with only one File or with distinct File Fragment markers is not a
collision.

```ts
type TargetWriter = {
  type: 'file' | 'file-fragment';
  marker?: string;
  descriptorIndex: number;
};
```

- [ ] **Step 4: Implement byte-exact File checks**

Read source and target as Buffers:

```text
input absent                 -> conflict + source-input-missing
target absent                -> missing + file-missing
Buffer.equals(input,target)  -> satisfied
otherwise                    -> drift + file-drift
```

Required missing/drift is error; optional missing/drift is warning. Escapes and structural collisions remain error/conflict; optional input/target read failures are warnings as defined in Tasks 3 and 5. Attach all available context.

- [ ] **Step 5: Verify and commit**

Run `npm run check` and the File tests; expected: all File states, collision updates, severity rules, and snapshots pass. Commit:

```powershell
git add src/doctor.ts test/doctor.e2e.test.ts
git commit -m "feat: diagnose complete file artifacts"
```

### Task 5: File Fragments, output, and final acceptance matrix

**Files:**

- Modify: `src/doctor.ts`
- Modify: `src/cli.ts`
- Modify: `test/doctor.e2e.test.ts`

**Interfaces:** Consumes Tasks 3–4; produces complete Issue #13 behavior.

- [ ] **Step 1: Add failing Fragment/output/read-only tests**

Seed `AGENTS.md` with:

```text
<!-- managed-by: source/baseline -->
base
<!-- end-managed-by: source/baseline -->
```

Create `profileRoot` under the fixture's temporary root and pass
`env: { USERPROFILE: profileRoot, HOME: profileRoot }` to every child-process
case. Add a local `snapshotTree(...roots)` test helper that recursively records
each directory entry as `{ root, path, kind }` and each file as
`{ root, path, kind: 'file', bytes }`; compare the sorted snapshots before and
after. This records empty directories as well as bytes and explicitly covers
`join(profileRoot, '.tbboot', 'trust.yaml')`.

Assert baseline satisfied, a distinct marker on the same target missing with
`fragment-missing`, and no collision. Add changed block -> `fragment-drift`;
duplicate markers -> `fragment-marker-collision`; unmatched/mismatched marker
lines -> `incomplete-fragment`; duplicate declared marker, including duplicate
markers on different targets -> `fragment-marker-collision` for every
participant. Include Source input with CRLF, no final newline, and empty
content; target text with and without a final newline; marker-like text inline
with ordinary content; and both input and target missing. The both-missing case
must emit only `source-input-missing` and the action must be `conflict`, because
the Source input is read before target state is evaluated. Add optional tests
for missing/drift, missing input, target read failure, unsupported Custom,
path escape, and structural collision to lock the severity policy. All
optional artifact/read cases and the optional unsupported Custom Step are
warnings with exit `0`; path escapes and structural collisions remain errors
with exit `1`; the optional unsupported Custom Step has no Artifact action.
Add human/JSON tests and snapshot the complete Consumer tree plus an isolated
temporary user profile before and after.

- [ ] **Step 2: Run Fragment tests**

Run `node --test test/doctor.e2e.test.ts --test-name-pattern "Fragment|optional|human|read-only"`. Expected: failure because Fragment and final output semantics are incomplete.

- [ ] **Step 3: Implement exact Fragment states**

Derive marker from `basename(sourceRoot)` and the first-level Recipe folder.
Read Source input and target as UTF-8 and never write. Normalize every `\r\n`
and lone `\r` to `\n`; do not trim or otherwise alter the input. With

```ts
const start = `<!-- managed-by: ${marker} -->`;
const end = `<!-- end-managed-by: ${marker} -->`;
const body = normalizeNewlines(input);
const expected = `${start}\n${body}${body.endsWith('\n') ? '' : '\n'}${end}`;
```

the managed block is exactly `expected`, with no trailing LF included in the
block. A start marker matches only at byte 0 or immediately after `\n` and
must be followed by `\n`; an end marker matches only at the start of a line
and must be followed by `\n` or EOF. A trailing LF after the end marker is
outside the block, as are all surrounding separators and unrelated text. Thus
an existing block at EOF is valid with or without that final LF, but a marker
embedded in ordinary text is not a marker line. A literal own start/end token
that is not a complete marker line is `incomplete-fragment`, not a match.

Use:

```text
input absent                   -> conflict + source-input-missing
target absent                   -> missing + fragment-missing
duplicate own start/end         -> conflict + fragment-marker-collision
unmatched/mismatched markers    -> conflict + incomplete-fragment
own block absent                -> missing + fragment-missing
own block exact                 -> satisfied
own block different             -> drift + fragment-drift
```

If target reading fails for a reason other than absence, emit `target-read` and
use `conflict`. Compare the exact own block with `expected`; ignore unrelated
target text and distinct complete markers. Structural collision diagnostics
are applied by the registration pass before these states.

- [ ] **Step 4: Finish status, severity, and rendering**

Use:

```ts
const hasError = envelope.diagnostics.some(({ severity }) => severity === 'error');
const hasWarning = envelope.diagnostics.some(({ severity }) => severity === 'warning');
envelope.status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
return { envelope, exitCode: hasError ? 1 : 0 };
```

Use warning severity for optional `source-input-missing`, `target-read`,
`file-missing`, `file-drift`, `fragment-missing`, `fragment-drift`, and
`unsupported-step`; the corresponding required Step diagnostics are errors.
Always use error severity for contract diagnostics, `manifest-read`,
`source-read`, `recipe-read`, `unsupported-source-provider`, `duplicate-source`,
`source-input-escape`, `target-escape`, `file-target-collision`,
`fragment-marker-collision`, and `incomplete-fragment`. An optional Step does
not make an escape or structural collision safe. Keep `changed: false`. Human
output is actionable; JSON calls no human renderer and writes one serialized
envelope plus one newline.

- [ ] **Step 5: Run the complete matrix**

Run real-process cases for valid documents, missing schemaVersion,
schemaVersion `!= 1`, duplicate YAML keys, multiple documents, YAML 1.1,
reserved empty/non-empty `recipes`, `requires`, invalid Source documents,
invalid Recipe documents, required/optional missing, empty/invalid YAML,
unknown closed field, unsupported provider, duplicate Source, missing/non-
directory/unreadable local Source, File satisfied/missing/drift/conflict,
Fragment satisfied/missing/drift/conflict, optionality categories, deterministic
ordering, and omitted `--root`. Assert exit code, stdout, stderr, status,
stable codes/context, one diagnostic per collision participant, and equality of
the complete Consumer and isolated profile snapshots before and after.

- [ ] **Step 6: Verify scope and commit**

Run:

```powershell
npm run check
npm test
git diff --check
git status --short
git diff --stat
```

Expected: all tests pass; production sources contain no write API; only the root package/lockfile, promoted schema, three production modules, and E2E test changed. Do not touch prototypes or the unrelated untracked `docs/superpowers/specs/2026-08-16-issue-13-show-me.html`. Commit:

```powershell
git add src/cli.ts src/contract.ts src/doctor.ts test/doctor.e2e.test.ts
git commit -m "feat: add read-only local doctor command"
```

## Self-Review

- Coverage: every spec requirement is assigned to Tasks 1–5: bootstrap, schema promotion, Manifest-first validation, local providers, duplicate identity, first-level ordering, contract codes/context, path safety, File/Fragment states, collisions, optional warnings, output, exit codes, and read-only E2E.
- Scope: no Git, Source dependency resolution, Custom, install, uninstall, Catalog, Recipe selection, or production prototype is introduced.
- Placeholder scan: every step names files, interfaces, commands, expected results, and concrete logic.
- Type consistency: `validateDocument` returns `ValidationResult` and `runDoctor` returns `{ envelope, exitCode }` throughout.
- Read-only check: only test cleanup removes temporary data; production code remains read-only.

## Review resolution

All eight findings are accepted as plan gaps; none is rejected. The decisions
are now encoded in the tasks above:

- **AJV configuration — accepted.** `strict`, `allErrors`, and `discriminator`
  are fixed together, with a real-process compile/validation smoke test.
- **Read-only proof — accepted.** Tests redirect `USERPROFILE` and `HOME` to a
  temporary profile and compare complete directory entries and file bytes,
  including `.tbboot\trust.yaml` and empty directories.
- **File Fragment contract — accepted and decided.** UTF-8 text normalizes
  only line endings to LF; the exact block has no trailing LF; marker lines
  require line boundaries; surrounding separators are outside the block; and
  missing input wins over missing target with a conflict action.
- **Optionality — accepted and decided.** Optional artifact/read failures are
  warnings; contract errors, source/provider failures, escapes, and structural
  collisions remain fatal. Optional unsupported Custom Steps warn and produce
  no Artifact action.
- **Local resolution errors — accepted.** Missing, non-directory, broken-link,
  and canonicalization failures emit one `source-read`, return a valid
  envelope, create no actions for that Source, and continue with later Sources.
- **Collision reporting — accepted and decided.** Each collision group marks
  every participant as `conflict` and emits one diagnostic per participant in
  declaration order, including duplicate markers on different targets.
- **Issue #9 coverage — accepted.** The final process matrix now exercises the
  preserved parser, version, reserved-field, Source, and Recipe diagnostics.
- **Plan state — accepted.** The unresolved checklist and execution-choice
  prompt were replaced by this resolution record; the plan no longer claims
  completion while retaining open decisions.
