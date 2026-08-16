# Strict TypeScript Typecheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible strict TypeScript check for `src/**/*.ts` and `test/**/*.ts`, then annotate the existing runtime without changing its JSON contract, exit codes, diagnostics, ordering, or behavior.

**Architecture:** Keep AJV and the JSON Schema as the runtime validation authority. Add small consumer-shaped TypeScript types in `src/contract.ts`, share the diagnostic and validated-document types with `src/doctor.ts`, expose the doctor envelope to `src/cli.ts` and the E2E test, and use one narrow declaration for the existing `.mjs` harness only if TypeScript requires it.

**Tech Stack:** Node `>=24.12 <25`, ESM/NodeNext, native `.ts` execution with Node type stripping, local `typescript`, local `@types/node`, `ajv`, `yaml`, and Node’s built-in test runner.

TypeScript 7 requires `--ignoreConfig` when a focused compiler invocation
names source files alongside the repository `tsconfig.json`; the public
project check continues to use `tsconfig.json` through `npm run typecheck`.

## Global Constraints

- `npm run typecheck` is the public command and must execute TypeScript without emitting files.
- `tsconfig.json` uses `target: "ES2024"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, `noEmit: true`, `allowImportingTsExtensions: true`, `esModuleInterop: true`, and `types: ["node"]`.
- `tsconfig.json` includes only `src/**/*.ts` and `test/**/*.ts`.
- `npm run check` remains the Node syntax check and `npm test` remains the real-process E2E suite.
- Do not use `allowJs`, global suppressions, weakened strictness, generated schema types, a runtime compiler, a testing library, or an emit step.
- AJV and `schemas/contract-v1.json` remain the runtime validation authority; TypeScript types describe only consumed properties.
- Keep the import from `prototypes/issue-12/harness.mjs`; moving helpers to `test/support.ts` belongs to Issue #32.
- Do not change the CLI parser, `node:util.parseArgs`, JSON output, diagnostics, exit codes, action ordering, or functional behavior; parser work belongs to Issue #27.
- A clean installation must use `npm ci` before running `npm run typecheck`.
- If typing requires an observable behavior, contract, compatibility, persistence, security, or scope change, stop and update Issue #31 before implementation continues.

---

## File Map

- Modify `package.json`: add the two development dependencies and the exact `typecheck` script.
- Modify `package-lock.json`: record the dependency resolutions produced by npm.
- Create `tsconfig.json`: define the strict, no-emit NodeNext project and its two source globs.
- Modify `src/contract.ts`: type YAML values, AJV errors, document models, diagnostics, and `validateDocument` without duplicating the complete schema.
- Modify `src/doctor.ts`: type diagnostics, the final envelope, Artifact actions, Step descriptors, path resolutions, filesystem errors, and `runDoctor`.
- Modify `src/cli.ts`: type the discriminated parser result, human renderer inputs, and `main`’s numeric result.
- Modify `test/doctor.e2e.test.ts`: type fixtures, recipe helpers, child-process values, snapshots, caught errors, and parsed envelopes.
- Conditionally create `prototypes/issue-12/harness.d.mts`: type only `runCommand` and `parseJsonOutput` if the existing `.mjs` import produces a missing-declaration diagnostic. Do not edit `harness.mjs`.

## Interfaces

These are the small interfaces the tasks share. Keep them in the existing files; do not create a new type-only module for one feature.

```ts
// src/contract.ts
export type DocumentKind =
  | 'manifest' | 'source' | 'recipe' | 'catalog'
  | 'lockfile' | 'state' | 'trust';

export type DiagnosticSeverity = 'error' | 'warning';

export type Diagnostic = {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  document?: string;
  path?: string;
  source?: string;
  recipe?: string;
  step?: number;
};

export type LocalSourceReference = {
  provider: 'local';
  locator: { path: string };
  recipes?: string[];
};

export type GitSourceReference = {
  provider: 'git';
  locator: { repository: string; path?: string };
  recipes?: string[];
};

export type SourceReference = LocalSourceReference | GitSourceReference;
export type SourceDependency = SourceReference & { name: string };
export type ManifestDocument = { schemaVersion: 1; sources: SourceReference[] };
export type SourceDocument = { schemaVersion: 1; dependencies?: SourceDependency[] };
export type FileStep = {
  type: 'file' | 'file-fragment';
  input: string;
  target: string;
  optional?: boolean;
};
export type CustomStep = { type: 'custom'; optional?: boolean; check: unknown };
export type Step = FileStep | CustomStep;
export type RecipeDocument = {
  schemaVersion: 1;
  steps: Step[];
  requires?: Array<{ source: string; recipe: string }>;
};

export type DocumentByKind = {
  manifest: ManifestDocument;
  source: SourceDocument;
  recipe: RecipeDocument;
  catalog: Record<string, unknown>;
  lockfile: Record<string, unknown>;
  state: Record<string, unknown>;
  trust: Record<string, unknown>;
};

export type ValidationResult<T = DocumentByKind[DocumentKind]> = {
  value?: T;
  diagnostics: Diagnostic[];
};

export type ValidateDocumentOptions<K extends DocumentKind = DocumentKind> = {
  kind: K;
  text: string;
  document: string;
  source?: string;
  recipe?: string;
};

export function validateDocument<K extends DocumentKind>(
  options: ValidateDocumentOptions<K>,
): ValidationResult<DocumentByKind[K]>;

// src/doctor.ts
export type ArtifactState = 'satisfied' | 'missing' | 'drift' | 'conflict';
export type ArtifactType = 'file' | 'file-fragment';
export type ArtifactAction = {
  source: string;
  recipe: string;
  step: number;
  type: ArtifactType;
  target: string;
  state: ArtifactState;
};
export type DoctorEnvelope = {
  schemaVersion: 1;
  command: 'doctor';
  status: 'ok' | 'warning' | 'error';
  changed: false;
  actions: ArtifactAction[];
  diagnostics: Diagnostic[];
  consumerRoot?: string;
};
export type DoctorResult = {
  envelope: DoctorEnvelope;
  exitCode: 0 | 1;
};

export function runDoctor(root: string): Promise<DoctorResult>;
```

The `DocumentByKind` entries for documents not consumed by production remain intentionally minimal. The validator still checks those documents through AJV; no generated or hand-copied full schema model is introduced.

### Task 1: Bootstrap strict typechecking

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.json`

**Interfaces:** Produces the local TypeScript executable, Node declarations, `npm run typecheck`, and the project configuration consumed by Tasks 2–4.

- [ ] **Step 1: Record the pre-change regression baseline**

Run:

```powershell
npm run check
npm test
```

Expected: both commands pass with the existing 19-test suite and no production files are changed.

- [ ] **Step 2: Add local compiler dependencies and the public script**

Run:

```powershell
npm install --save-dev typescript @types/node
```

Then ensure `package.json` contains the existing scripts plus exactly this new script:

```json
"typecheck": "tsc --project tsconfig.json --noEmit"
```

Keep `typescript` and `@types/node` under `devDependencies`; keep `ajv` and `yaml` under `dependencies`; preserve the existing Node engine and all existing scripts.

- [ ] **Step 3: Create the minimal NodeNext project**

Create `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Do not add `allowJs`, `outDir`, `declaration`, `skipLibCheck`, or any prototype/document/schema glob.

- [ ] **Step 4: Run the new check as the intentional red baseline**

Run:

```powershell
npm run typecheck -- --pretty false
```

Expected: a non-zero exit caused by the current implicit-`any` and `unknown` errors in the unannotated `.ts` files. Do not suppress or delete those errors; Tasks 2–4 remove them at their actual boundaries.

- [ ] **Step 5: Verify metadata and commit the tooling boundary**

Run:

```powershell
npm pkg get devDependencies
npm pkg get scripts.typecheck
npm run check
npm test
git diff --check
```

Expected: the two development dependencies and exact script are present, the runtime regression suite passes, and the diff has no whitespace errors. Commit on the existing `issue/31-static-typecheck-design` branch:

```powershell
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add strict TypeScript typecheck"
```

### Task 2: Type the contract validation boundary

**Files:**
- Modify: `src/contract.ts`

**Interfaces:** Consumes the existing AJV/YAML implementation and produces the exported `DocumentKind`, document models, `Diagnostic`, `ValidationResult`, and typed `validateDocument` contract used by `src/doctor.ts`.

- [ ] **Step 1: Add the consumer-shaped type aliases**

Add the aliases from the shared interface section near the top of `src/contract.ts`. Keep `Step` as a discriminated union so this existing branch remains the narrowing point:

```ts
for (const [index, step] of recipeResult.value.steps.entries()) {
  if (step.type === 'custom') {
    // existing unsupported-step behavior
    continue;
  }
  // step.input and step.target are strings in this branch
}
```

Include only fields read by the current code: manifest/source/recipe `schemaVersion`, manifest `sources`, source `dependencies` and their reserved `recipes`, recipe `steps` and `requires`, and the file/custom Step fields. Keep YAML and JSON values as `unknown` until the existing guards and successful AJV validation establish their use.

- [ ] **Step 2: Type the AJV validator map and diagnostic helpers**

Import AJV’s type-only `ErrorObject` and `ValidateFunction`. Type the validator map as a partial `Record<DocumentKind, ValidateFunction<unknown>>` until the existing missing-schema guard proves it complete. Type `diagnostic`, `escapePointerToken`, `errorPath`, `schemaMessage`, `actionableErrors`, `stepFromPath`, and `reservedDiagnostics` explicitly.

Use a small local conversion for caught and AJV values rather than changing messages:

```ts
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

For AJV `params`, read `additionalProperty`, `missingProperty`, `property`, `tag`, `tagValue`, and `i` through a typed narrow or string conversion. Preserve all existing JSON Pointer rules and diagnostic text.

- [ ] **Step 3: Type YAML and JSON as `unknown` before validation**

Change the parsed document flow to make the boundary explicit without changing its branches:

```ts
const value: unknown = yamlDocuments[0].toJS();
if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(value, 'schemaVersion')) {
  // existing schema-version-missing result
}
```

Use a typed record guard for the `schemaVersion` read, retain the current YAML 1.1/multiple/empty-document checks, and keep the existing `JSON.stringify` fallback for unsupported schema versions. After `validator(value)` succeeds, narrow or assert to `DocumentByKind[K]` only at that validated boundary; do not introduce `any` or a second schema validator.

- [ ] **Step 4: Preserve the typed return contract for every branch**

Declare `validateDocument` with the generic `ValidateDocumentOptions<K>` / `ValidationResult<DocumentByKind[K]>` interface. Every parse, version, AJV, and reserved-diagnostic failure returns `value: undefined` with the existing diagnostics. The success branch returns the validated document only when reserved diagnostics are empty.

The manifest and source branches must continue to support `reservedDiagnostics`’s existing `recipes` checks, and the recipe branch must continue to support the existing `requires` check. No diagnostic code, message, context omission, or runtime ordering may change.

- [ ] **Step 5: Run the contract-focused static and runtime checks**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --esModuleInterop --types node src/contract.ts
npm run check
npm test
git diff --check
```

Expected: the focused compiler invocation passes for `src/contract.ts`; the existing syntax and E2E checks remain green. The project-wide `npm run typecheck` may still report errors in the untouched doctor, CLI, and test files until Tasks 3–4.

- [ ] **Step 6: Commit the contract types**

```powershell
git add src/contract.ts
git commit -m "refactor: type contract validation boundaries"
```

### Task 3: Type doctor discovery and Artifact evaluation

**Files:**
- Modify: `src/doctor.ts`

**Interfaces:** Consumes `Diagnostic`, `DocumentKind`, `RecipeDocument`, `Step`, `SourceReference`, and typed `validateDocument`; produces `ArtifactAction`, `DoctorEnvelope`, `DoctorResult`, and the typed `runDoctor` boundary.

- [ ] **Step 1: Add the internal doctor models**

Add the exported envelope/action/result types and local types for the internal state:

```ts
type PathResolution =
  | { path: string; escape: false }
  | { escape: true }
  | { error: unknown };

type StepDescriptor = {
  source: string;
  recipe: string;
  step: number;
  type: ArtifactType;
  input: string;
  target: string;
  optional: boolean;
  recipeRoot: string;
  inputPath?: PathResolution;
  targetPath?: PathResolution;
  marker?: string;
  collision?: boolean;
  action: ArtifactAction;
};
```

Use `DoctorEnvelope.consumerRoot?: string` for the temporary internal root; preserve the existing `delete envelope.consumerRoot` before returning the final envelope.

- [ ] **Step 2: Type diagnostic and filesystem helpers**

Import the contract types with `import type`. Type `diagnostic`, `finish`, `isNotFound`, `isInside`, `realPathWithMissing`, `resolveContained`, `contextFor`, `stepPath`, `stepSeverity`, `addStepDiagnostic`, `artifactAction`, and `pathKey`.

Treat catches as `unknown` and add local conversion helpers that preserve current messages and error-code checks:

```ts
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}
```

Use `errorMessage(error)` for every existing `${error.message}` interpolation. Keep `PathResolution` results explicit: return `{ escape: true }` for escapes, `{ path, escape: false }` for contained paths, and `{ error }` for non-not-found resolution failures.

- [ ] **Step 3: Type Source and Recipe traversal without changing narrowing**

Type `resolveLocalSource` as `(root: string, locator: string, index: number, envelope: DoctorEnvelope) => Promise<string | undefined>` and `collectSourceSteps` as `(sourceRoot: string, descriptors: StepDescriptor[], envelope: DoctorEnvelope) => Promise<void>`.

Keep the current discriminated narrowing and ordering:

```ts
for (const [index, step] of recipeResult.value.steps.entries()) {
  const stepNumber = index + 1;
  if (step.type === 'custom') {
    // existing unsupported-step diagnostic and continue
  }
  // only file/file-fragment steps reach descriptor construction
}
```

Type `readdir(..., { withFileTypes: true })` entries as the Node-provided `Dirent` values, keep first-level lexical Recipe discovery, and preserve the current read-failure diagnostics and source/provider behavior.

- [ ] **Step 4: Type collision and state helpers**

Type `registerCollisions`, `normalizeNewlines`, `exactMarkerLines`, `fragmentState`, and `evaluateDescriptor`. Define the fragment result as a discriminated union so assigning `result.state` and checking `result.code !== undefined` remains safe:

```ts
type FragmentResult =
  | { state: 'satisfied' }
  | { state: 'missing' | 'drift' | 'conflict'; code: string };
```

Use `Map<string, StepDescriptor[]>` for writer groups. Keep collision flags, action states, diagnostic severity, marker derivation, Buffer comparisons, missing-target precedence, and read-only filesystem calls unchanged.

- [ ] **Step 5: Type and verify `runDoctor`**

Declare `runDoctor(root: string): Promise<DoctorResult>`. Type the manifest result as `ManifestDocument`, the source references as `SourceReference`, the descriptor collection as `StepDescriptor[]`, and `seenSources` as `Map<string, number>` so the existing `provider === 'local'` branch narrows `reference.locator.path`.

Run:

```powershell
npx tsc --ignoreConfig --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --esModuleInterop --types node src/contract.ts src/doctor.ts
npm run check
npm test
git diff --check
```

Expected: the focused compiler invocation passes for the contract and doctor modules; all existing process tests still pass and no production write API is introduced.

- [ ] **Step 6: Commit the doctor types**

```powershell
git add src/doctor.ts
git commit -m "refactor: type doctor diagnostics and actions"
```

### Task 4: Type the CLI, E2E boundary, and harness declaration

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/doctor.e2e.test.ts`
- Create conditionally: `prototypes/issue-12/harness.d.mts`

**Interfaces:** Consumes `DoctorEnvelope` and `DoctorResult`; produces a fully typed project so `npm run typecheck` passes while the CLI remains a real child process and the harness runtime remains untouched.

- [ ] **Step 1: Type the CLI parser and renderer**

Import `DoctorEnvelope` and `runDoctor` with type/value imports as appropriate. Add the discriminated result used by the current branches:

```ts
type ParseResult =
  | { ok: true; root: string; json: boolean }
  | { ok: false; message: string };

function parseArgs(argv: string[], cwd: string): ParseResult {
  // preserve the existing parser body and messages
}

function renderHuman(envelope: DoctorEnvelope): string {
  // preserve the existing line order and formatting
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // preserve the existing exit-code and stream behavior
}
```

Type `argv`, `cwd`, `root`, `json`, `envelope`, `action`, and `diagnostic` so strict narrowing handles `options.ok` without assertions. Keep the existing `realpathSync` entrypoint check and `process.exitCode` assignment.

- [ ] **Step 2: Run the project check to expose only the E2E boundary errors**

Run:

```powershell
npm run typecheck -- --pretty false
```

Expected: the remaining errors are limited to `test/doctor.e2e.test.ts` and, if present, the missing declaration for `../prototypes/issue-12/harness.mjs`. Do not add a declaration before confirming that TypeScript reports that module boundary.

- [ ] **Step 3: Add the narrow harness declaration only when required**

If the previous command reports TS7016 or an equivalent missing-declaration error for the `.mjs` import, create `prototypes/issue-12/harness.d.mts` with only these declarations:

```ts
export type RunCommandOptions = {
  file: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  ready?: string;
  readyTimeoutMs?: number;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export function runCommand(options: RunCommandOptions): Promise<CommandResult>;
export function parseJsonOutput<T = unknown>(stdout: string): T;
```

If no missing-declaration error is reported, do not create the file. In either case, do not add the prototype directory to `tsconfig.json`’s `include` list and do not edit the JavaScript harness.

- [ ] **Step 4: Type the fixture and process helpers**

Add these local test types and use them at helper boundaries:

```ts
type Fixture = {
  root: string;
  consumerRoot: string;
  sourceRoot: string;
  profileRoot: string;
  cleanup: () => Promise<void>;
};

type RecipeStepFixture = {
  type?: 'file' | 'file-fragment' | 'custom';
  input?: string;
  inputContent?: string;
  inputMissing?: boolean;
  target?: string;
  optional?: boolean;
};

type SnapshotEntry =
  | { root: string; path: string; kind: 'directory' }
  | { root: string; path: string; kind: 'file'; bytes: Uint8Array };

type CommandOptions = Parameters<typeof runCommand>[0];
type CommandResult = Awaited<ReturnType<typeof runCommand>>;
```

Type `commandFor(file: string, args: string[])`, `installedBin(): Promise<string>`, `runCli(...): Promise<CommandResult>`, `createFixture(): Promise<Fixture>`, `writeRecipe(sourceRoot: string, recipe: string, steps: RecipeStepFixture[]): Promise<void>`, `runDoctor(...): Promise<{ result: CommandResult; envelope: DoctorEnvelope }>`, `snapshotTree(...roots: string[]): Promise<SnapshotEntry[]>`, and `runReadOnlyCommand(fixture: Fixture, command: CommandOptions): Promise<CommandResult>`.

Keep `installedRoot` and `installedBinPromise` explicitly optional, preserve the one-time installation promise, and preserve the fixture cleanup callback. Type `parseJsonOutput<DoctorEnvelope>(...)` at every response whose fields the tests inspect.

- [ ] **Step 5: Narrow caught errors and possibly-absent test values**

Treat all test catches as `unknown` and use a local `errorCode(error: unknown): string | undefined` guard for `EPERM`, `EACCES`, and `EEXIST`, preserving the existing skip/throw behavior. Where strict null checks reject `.find(...)`, `.at(-1)`, or indexed diagnostics, keep the same assertion and add an immediately preceding narrowing assertion:

```ts
const action = envelope.actions.find(({ recipe }) => recipe === 'fragment');
assert.ok(action);
assert.equal(action.state, 'satisfied');

const lastDiagnostic = envelope.diagnostics.at(-1);
assert.ok(lastDiagnostic);
assert.equal(lastDiagnostic.code, 'unsupported-step');
```

Type the `cases` table as `Array<[string, string]>`, retain the current child-process commands and streams, and do not alter test scenarios or expected output.

- [ ] **Step 6: Run the complete typecheck and runtime suite**

Run:

```powershell
npm run typecheck
npm run check
npm test
git diff --check
```

Expected: all commands pass. `npm run typecheck` checks only the four existing TypeScript runtime/test files plus imported declarations, reports no implicit `any` or strict-null errors, and emits nothing.

- [ ] **Step 7: Commit the CLI and test boundary types**

```powershell
git add src/cli.ts test/doctor.e2e.test.ts
if (Test-Path 'prototypes/issue-12/harness.d.mts') { git add prototypes/issue-12/harness.d.mts }
git commit -m "refactor: type CLI and E2E boundaries"
```

### Task 5: Clean-install and scope verification

**Files:**
- No new production files; verify the files changed by Tasks 1–4.

**Interfaces:** Verifies the public `typecheck` command, clean dependency lock, no-emit guarantee, runtime regression suite, and Issue #31 scope.

- [ ] **Step 1: Reinstall from the lockfile**

Run:

```powershell
npm ci
```

Expected: installation succeeds using only `package-lock.json`, with no manual/global TypeScript dependency required.

- [ ] **Step 2: Run the acceptance commands**

Run:

```powershell
npm run typecheck
npm run check
npm test
git diff --check
```

Expected: all four commands pass.

- [ ] **Step 3: Verify the non-zero compiler behavior without editing the repository**

Create a unique directory under `$env:TEMP` outside the repository, write a one-line TypeScript probe with an implicit `any` parameter, and invoke the local compiler directly against that probe:

```powershell
$probeRoot = Join-Path $env:TEMP ('tbboot-typecheck-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $probeRoot | Out-Null
Set-Content -Path (Join-Path $probeRoot 'probe.ts') -Value 'function probe(value) { return value; }'
npx tsc --ignoreConfig --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext (Join-Path $probeRoot 'probe.ts')
$probeExit = $LASTEXITCODE
Remove-Item -LiteralPath $probeRoot -Recurse -Force
if ($probeExit -eq 0) { throw 'Expected strict TypeScript probe to fail' }
```

Expected: TypeScript returns non-zero for the implicit-`any` probe; only the unique temporary directory is removed. This validates the compiler’s failure semantics without introducing a broken file into `src/` or `test/`.

- [ ] **Step 4: Verify no emit and no scope expansion**

Run:

```powershell
git status --short --untracked-files=all
git diff --name-only HEAD~4..HEAD
Get-ChildItem -Path src,test -Recurse -File -Include *.js,*.js.map,*.tsbuildinfo
```

Expected: no emitted JavaScript, source maps, or build-info files; changed files are limited to `package.json`, `package-lock.json`, `tsconfig.json`, the three `src` modules, the E2E test, and the conditional harness declaration. No schema, prototype runtime, parser, or `test/support.ts` change appears.

- [ ] **Step 5: Review observable behavior and finish the branch**

Compare the final diff against Issue #31 and confirm:

- the JSON envelope, diagnostic codes/messages/context, exit codes, and action ordering are unchanged;
- the E2E test still launches the installed CLI as a child process;
- `tsconfig.json` excludes prototypes, docs, schemas, and JavaScript files;
- the conditional declaration contains types only and can be removed by Issue #32;
- no global TypeScript installation or runtime compiler is required.

Do not push or approve a pull request. Leave the existing issue-derived branch ready for review.

## Self-Review

- **Spec coverage:** Tasks 1–5 cover dependencies/lockfile, exact `tsconfig.json`, `npm run typecheck`, strict typing of `contract.ts`, `doctor.ts`, `cli.ts`, and the E2E test, conditional harness declarations, clean `npm ci`, no emit, and all four acceptance commands.
- **Scope:** The plan does not change #27’s parser work, #32’s harness migration, schemas, prototypes, runtime compilation, testing dependencies, contracts, diagnostics, exit codes, or behavior.
- **Placeholder scan:** Every implementation step names its files, type boundaries, commands, expected result, or exact code shape; there are no `TBD`, `TODO`, or deferred implementation placeholders.
- **Type consistency:** `validateDocument` returns `ValidationResult<DocumentByKind[K]>`; `runDoctor` returns `DoctorResult`; `DoctorEnvelope` is consumed consistently by the CLI and E2E parser; harness declarations match the current `runCommand` and `parseJsonOutput` runtime signatures.
- **Ponytail check:** No new runtime abstraction, generated type pipeline, test framework, or prototype migration is added; the compiler is the single new check for the type-only change.
