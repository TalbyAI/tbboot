# Static Step Type Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the host resolve registered Step types through one static registry while preserving the current File, File Fragment, and Custom lifecycle behavior.

**Architecture:** Add a small host-owned Step type registry with explicit definitions, per-instance executor creation, JSON Schema/semantic validation hooks, and common lifecycle result types. Register the three built-ins statically; adapt the existing doctor/install paths through the registry while keeping filesystem mutation, optionality, diagnostics, cancellation, and state persistence in the host. Keep the runtime and Source provider registries for later issues.

**Tech Stack:** TypeScript executed directly by Node 24, generated JavaScript under `src/`, AJV, Node test runner, existing YAML contract and filesystem helpers.

## Global Constraints

- Static registration only: no module scanning, package loading, extension installation, or runtime/provider implementation.
- Duplicate Step type IDs fail explicitly and never replace an existing definition.
- Built-in File, File Fragment, and Custom behavior remains observable-compatible with the existing MVP.
- The host owns status normalization, `changed`, optionality, diagnostics, cancellation, lifecycle sequencing, and Installation record persistence.
- New Step fields remain at the Step object's first level; no required `config` wrapper.
- Documents continue using `schemaVersion: 1`.
- Keep `.ts` sources authoritative and regenerate paired `.js` files with `npm run build:runtime`.
- Test only public seams: registry registration/resolution and the host's real local plan/lifecycle flow.

### Task 1: Add the static Step type registry contract

**Files:**

- Create: `src/steps.ts`
- Create: `test/steps.test.ts`

**Interfaces:**

- `JsonValue): JSON-compatible state/details value.
- `StepResult):`status`,`changed`, optional`message`,`details`, and`state`.
- `StepExecutionContext): parsed Recipe, concrete Step, execution mode, explicit host services/capabilities, and cancellation signal.
- `StepExecutor): optional`check`,`install`, and`uninstall` functions receiving the context and previous state.
- `StepTypeDefinition):`id`,`apiVersion`, extension identity, JSON Schema, optional semantic validator, behavior, capabilities, execution descriptors, and`createExecutor(step, context)`.
- `StepTypeRegistry.register(definition)` and `get(typeId)`.
- `createBuiltinStepTypeRegistry()` returns a registry containing the built-in IDs through the same registration path; its executor adapters remain supplied by the host integration.

- [x] **Step 1: Write the failing tests**

Add tests that call only the public registry API:

```ts
test("resolves a statically registered Step type", () => {
  const registry = new StepTypeRegistry();
  const definition = makeDefinition("team.example");
  registry.register(definition);
  assert.equal(registry.get("team.example"), definition);
});

test("rejects duplicate Step type IDs without replacing the first definition", () => {
  const registry = new StepTypeRegistry();
  const first = makeDefinition("team.example");
  registry.register(first);
  assert.throws(() => registry.register(makeDefinition("team.example")), /already registered/);
  assert.equal(registry.get("team.example"), first);
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/steps.test.ts`
Expected: FAIL because `src/steps.ts` and `StepTypeRegistry` do not exist.

- [x] **Step 3: Implement the minimum registry**

Use a private `Map<string, StepTypeDefinition>`; reject empty IDs and duplicate IDs with a typed `StepTypeRegistryError`; return `undefined` for an unknown ID. Keep registration synchronous and static.

- [x] **Step 4: Run the focused test and typecheck**

Run: `node --test test/steps.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit code 0.

### Task 2: Make recipe validation extensible without weakening common validation

**Files:**

- Modify: `schemas/contract-v1.json` (`$defs.step`)
- Modify: `src/contract.ts`
- Create: `test/step-contract.test.ts`

**Interfaces:**

- Preserve `validateDocument({ kind: "recipe" })` for YAML parsing, schemaVersion, Recipe shape, and common Step object validation.
- Add a host-level `validateStep(step, definition, context)` function that validates the complete Step against the registered definition schema and appends semantic diagnostics without allowing a semantic validator to remove structural errors.

- [x] **Step 1: Write the failing contract tests**

Cover a first-level extension field and an unknown Step type:

```ts
test("parses a registered-style Step with first-level fields", () => {
  const result = validateDocument({
    kind: "recipe",
    text: "schemaVersion: 1\nsteps:\n  - type: team.template\n    target: README.md\n    template: README.template\n",
    document: "recipe.yaml",
  });
  assert.equal(result.diagnostics.length, 0);
  assert.equal((result.value?.steps[0] as Record<string, unknown>).template, "README.template");
});
```

Add direct tests for structural rejection and semantic errors through `validateStep`.

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `node --test test/step-contract.test.ts`
Expected: FAIL because the current recipe schema rejects unknown types/fields and no type-specific validator exists.

- [x] **Step 3: Implement common-plus-registered validation**

Change the generic recipe Step schema to require a non-empty string `type`, preserve `optional` as a boolean, and permit type-specific first-level fields for parsing. In `src/contract.ts`, validate the definition's JSON Schema with the existing AJV instance, report `schema-validation-failed` paths under the Step, and run `semanticValidate` only after structural validation; semantic errors can add diagnostics but cannot turn invalid structure into a valid Step.

- [x] **Step 4: Run focused tests and existing contract tests**

Run: `node --test test/step-contract.test.ts test/catalog-contract.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit code 0.

### Task 3: Register built-ins and route the host's real Step discovery through it

**Files:**

- Modify: `src/steps.ts`
- Modify: `src/doctor.ts`
- Modify: `src/install.ts`
- Create: `test/step-lifecycle.e2e.test.ts`

**Interfaces:**

- `createBuiltinStepTypeRegistry()` supplies definitions for `file`, `file-fragment`, and `custom`; the host uses the process-local `stepTypeRegistry`.
- Registration remains synchronous and static; tests register representative team types in that registry.
- Each resolved descriptor stores its `StepTypeDefinition` and creates exactly one executor for its instance with an explicit `StepExecutionContext`.
- Built-in File, File Fragment, and Custom definitions preserve the existing host-owned inspection/apply paths. Registered extension executors receive the explicit context and lifecycle calls; the host continues to decide diagnostics, optionality, cancellation and state writes.

- [x] **Step 1: Write the failing real-flow test**

Register a representative maintained type in the process-local static registry with a first-level field and an executor that records its context and returns `ok/changed`. Run the host's local install flow and assert the action/effect uses the registered type, the executor is created once per Step per host invocation, and `context.step` is the concrete Step object. Add duplicate registration coverage through the public registry test.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/step-lifecycle.e2e.test.ts`
Expected: FAIL because `planLocalInstall` has no registry seam and the host branches directly on Step type.

- [x] **Step 3: Implement the minimum host integration**

Resolve every parsed Step through the registry before planning. For unknown required types, add an error diagnostic and stop that Step; for unknown optional types, add a warning diagnostic and omit it. For known types, validate the complete Step, retain its definition in the descriptor, construct an explicit context, and call `createExecutor` per descriptor. Preserve existing File/File Fragment path checks and Custom preparation by moving them behind built-in definitions/adapters rather than changing their result semantics. Do not add runtime/provider registries in this issue.

- [x] **Step 4: Run the focused regression tests**

Run: `node --test test/steps.test.ts test/step-contract.test.ts test/step-lifecycle.e2e.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit code 0.

### Task 4: Regenerate runtime JavaScript, run the complete verification suite, review, and commit

**Files:**

- Modify: generated `src/*.js` corresponding to changed TypeScript files.
- Modify: `docs/superpowers/plans/2026-08-28-issue-64-static-step-types.md` if task checkboxes are tracked.

- [x] **Step 1: Regenerate paired JavaScript**

Run: `npm run build:runtime`
Expected: exit code 0 and generated JavaScript matches the TypeScript implementation.

- [x] **Step 2: Run project checks**

Run: `npm run typecheck`
Expected: exit code 0.
Run: `npm run check`
Expected: exit code 0.
Run: `npm test`
Expected: exit code 0 with no failed tests.

- [x] **Step 3: Review the diff against main**

Run: `git diff main...HEAD --stat` and `git diff main...HEAD`. Confirm no runtime/provider loading, dynamic installation, unrelated refactor, or behavior regression was introduced; confirm every Issue #64 acceptance criterion is covered or explicitly out of scope.

- [x] **Step 4: Commit the implementation**

```powershell
git add src schemas test docs/superpowers/plans/2026-08-28-issue-64-static-step-types.md
git commit -m "feat: add static Step type registry"
```
