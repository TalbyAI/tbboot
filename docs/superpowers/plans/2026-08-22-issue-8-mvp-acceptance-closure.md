# MVP acceptance closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the missing acceptance evidence for Issue #8 and children #9–#21 while publishing native Node test coverage in CI.

**Architecture:** Keep the existing CLI, Custom runner, state persistence, and Windows matrix unchanged unless a new acceptance test exposes a production defect. Extend the existing end-to-end fixture with the two missing lifecycle scenarios and a TypeScript-erasable external handler. Use Node 24's built-in test coverage output and PowerShell/GitHub Actions to stream, summarize, and upload the same ASCII report.

**Tech Stack:** Node.js 24.12+, native `node:test` coverage, TypeScript erasable syntax, PowerShell 7.6, GitHub Actions, existing `npm` dependencies only.

## Global Constraints

- Issue #8 is the authoritative product contract; this plan adds evidence and tests only.
- Keep Issues #42, #44, and #45 out of scope.
- Do not add `c8`, `nyc`, Istanbul, an HTML coverage generator, or a new runtime dependency.
- Keep the supported engine range `>=24.12 <25` and the Windows x64 acceptance gate.
- Preserve the existing `process.emit("SIGINT")` test as deterministic in-process cancellation evidence.
- Never label `process.emit("SIGINT")` or `child.kill("SIGINT")` as a real Windows Ctrl+C event.
- Do not implement rollback, runner redesign, sandboxing, or parallel execution.
- Use the existing fixture and helpers before creating new abstractions.
- Every test change must be runnable before the production suite is considered complete.

---

## File map

| File | Responsibility in this plan |
| --- | --- |
| `package.json` | Expose the canonical native coverage command. |
| `.github/workflows/ci.yml` | Run coverage once in the Windows matrix, preserve its exit code, write the job summary, and upload the report. |
| `test/mvp-acceptance.e2e.test.ts` | Exercise production CLI TypeScript Custom handling and required failure/reconciliation; add a real console-control test only if the bounded Windows probe is reliable. |
| `docs/acceptance/mvp-windows-x64.md` | Record the coverage command/publication and accurately distinguish deterministic cancellation from OS-level Ctrl+C evidence. |
| `docs/superpowers/specs/2026-08-22-issue-8-mvp-acceptance-closure-design.md` | Approved source design; do not alter unless implementation reveals a scope-level decision. |

## Task 1: Add native coverage output and CI publication

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Produces the `npm run test:coverage` command.
- Produces `coverage/summary.txt` on the canonical Node 24.12.x + pinned PowerShell 7.6.0 matrix combination.
- Publishes the same report to `GITHUB_STEP_SUMMARY` and as an artifact named `tbboot-coverage`.
- Keeps non-canonical matrix combinations on `npm test`.

- [ ] **Step 1: Add the package script**

Add this entry next to the existing `test` script in `package.json`:

```json
"test": "node --test \"test/**/*.test.ts\"",
"test:coverage": "node --experimental-test-coverage --test \"test/**/*.test.ts\"",
"typecheck": "tsc --project tsconfig.json --noEmit"
```

- [ ] **Step 2: Verify the new command before changing CI**

Run:

```powershell
npm run test:coverage
```

Expected: the existing production suite completes with 0 failures, the documented filesystem skip remains the only skip, and Node prints an ASCII table containing lines, branches, functions, and uncovered line ranges.

- [ ] **Step 3: Make the matrix select one canonical coverage leg**

Replace the current `Run tests` step in `.github/workflows/ci.yml` with two mutually exclusive steps:

```yaml
      - name: Run tests
        if: matrix.node-version != '24.12.x' || matrix.pwsh-version != '7.6.0'
        env:
          TBBOOT_PWSH_MATRIX: ${{ matrix.pwsh-version }}
        run: npm test

      - name: Run tests with coverage
        if: matrix.node-version == '24.12.x' && matrix.pwsh-version == '7.6.0'
        shell: pwsh
        env:
          TBBOOT_PWSH_MATRIX: ${{ matrix.pwsh-version }}
        run: |
          New-Item -ItemType Directory -Path coverage -Force | Out-Null
          & npm run test:coverage 2>&1 | Tee-Object -FilePath coverage/summary.txt
          $testExitCode = $LASTEXITCODE
          if ($testExitCode -ne 0) {
            exit $testExitCode
          }

      - name: Add coverage to job summary
        if: always() && matrix.node-version == '24.12.x' && matrix.pwsh-version == '7.6.0'
        shell: pwsh
        run: |
          if (Test-Path coverage/summary.txt) {
            Get-Content coverage/summary.txt | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8
          } else {
            "Coverage report was not produced." | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8
          }

      - name: Upload coverage report
        if: always() && matrix.node-version == '24.12.x' && matrix.pwsh-version == '7.6.0'
        uses: actions/upload-artifact@v4
        with:
          name: tbboot-coverage
          path: coverage/summary.txt
          if-no-files-found: warn
```

The coverage step must remain a native PowerShell pipeline so the table is visible in the live log. The explicit `$LASTEXITCODE` check must remain after `Tee-Object` so a failing test job cannot become green because output capture succeeded.

- [ ] **Step 4: Verify CI syntax and local behavior**

Run:

```powershell
npm run check:md
npm run check:code
npm run typecheck
npm run build
```

Expected: all four commands exit 0; the workflow contains exactly one `test:coverage` execution and the summary/artifact steps use `if: always()`.

- [ ] **Step 5: Commit the coverage slice**

```powershell
git add package.json .github/workflows/ci.yml
git commit -m "ci: publish native test coverage"
```

## Task 2: Add the production TypeScript-erasable Custom cycle

**Files:**

- Modify: `test/mvp-acceptance.e2e.test.ts`

**Interfaces:**

- Reuse `createFixture()`, `runCli()`, `jsonEnvelope()`, and the existing Node runtime.
- Produces one production CLI test covering `check`, `install`, and `uninstall` for an external `scripts/node.ts` handler.

- [ ] **Step 1: Write the failing acceptance test**

Add this test after `MVP CLI runs external Node and PowerShell Custom handlers`:

```typescript
test("MVP CLI runs an erasable TypeScript Custom handler", async () => {
  const fixture = await createFixture();
  const allowCustom = ["--allow-custom", fixture.sourceRoot];
  try {
    const recipeRoot = join(fixture.sourceRoot, "baseline");
    await mkdir(join(recipeRoot, "scripts"));
    await writeFile(
      join(recipeRoot, "scripts", "node.ts"),
      [
        'import { rm, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "type Request = {",
        '  operation: "check" | "install" | "uninstall";',
        "  consumerRoot: string;",
        "};",
        'type Result = { status: "ok"; changed: boolean };',
        "export default async function handler(request: Request): Promise<Result> {",
        '  const target = join(request.consumerRoot, "external-ts.txt");',
        '  if (request.operation === "install") await writeFile(target, "typescript\n");',
        '  if (request.operation === "uninstall") await rm(target, { force: true });',
        '  console.error("external-ts-" + request.operation + "-log");',
        '  return { status: "ok", changed: request.operation !== "check" };',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(recipeRoot, "recipe.yaml"),
      [
        "schemaVersion: 1",
        "steps:",
        "  - type: custom",
        "    check:",
        "      runtime: node",
        "      script: scripts/node.ts",
        "    install:",
        "      runtime: node",
        "      script: scripts/node.ts",
        "    uninstall:",
        "      runtime: node",
        "      script: scripts/node.ts",
        "",
      ].join("\n"),
      "utf8",
    );

    const installed = await runCli(fixture, [
      "install",
      "--root",
      fixture.consumerRoot,
      ...allowCustom,
      "--json",
    ]);
    assert.equal(installed.exitCode, 0, installed.stdout);
    assert.equal(jsonEnvelope(installed, "install").changed, true);
    assert.match(installed.stderr, /external-ts-check-log/);
    assert.match(installed.stderr, /external-ts-install-log/);
    assert.equal(
      await readFile(join(fixture.consumerRoot, "external-ts.txt"), "utf8"),
      "typescript\n",
    );

    const uninstalled = await runCli(fixture, [
      "uninstall",
      "--root",
      fixture.consumerRoot,
      ...allowCustom,
      "--json",
    ]);
    assert.equal(uninstalled.exitCode, 0, uninstalled.stdout);
    assert.equal(jsonEnvelope(uninstalled, "uninstall").changed, true);
    assert.match(uninstalled.stderr, /external-ts-uninstall-log/);
    assert.equal(
      await readFile(
        join(fixture.consumerRoot, "external-ts.txt"),
        "utf8",
      ).catch(() => undefined),
      undefined,
    );
  } finally {
    await fixture.cleanup();
  }
});
```

The new file uses only type aliases, parameter annotations, and a return annotation; it must not use enums, namespaces, parameter properties, decorators, or runtime imports that require transpilation.

- [ ] **Step 2: Run only the new test to confirm the current gap**

Run:

```powershell
node --test --test-name-pattern "erasable TypeScript" test/mvp-acceptance.e2e.test.ts
```

Expected before the implementation change: the test fails if production Custom preparation rejects `.ts`, or passes if the already-integrated native Node path covers it. If it passes, keep the test as the missing production evidence and do not change `src/custom.ts`.

- [ ] **Step 3: Make the minimum production correction only if the test fails**

If the failure is a production `.ts` preparation or execution defect, trace the existing Node external-script path in `src/custom.ts` and patch that shared path. Do not add a TypeScript compiler or a second handler implementation. The required behavior is that the existing Node command executes the erasable file under Node 24's native type stripping.

- [ ] **Step 4: Re-run the test and type checks**

Run:

```powershell
node --test --test-name-pattern "erasable TypeScript" test/mvp-acceptance.e2e.test.ts
npm run typecheck
```

Expected: the targeted test passes and typecheck exits 0.

- [ ] **Step 5: Commit the TypeScript acceptance slice**

```powershell
git add test/mvp-acceptance.e2e.test.ts src/custom.ts
git commit -m "test: cover erasable TypeScript Custom handlers"
```

## Task 3: Add required failure, persisted partial state, and reconciliation

**Files:**

- Modify: `test/mvp-acceptance.e2e.test.ts`
- Modify: `src/install.ts` only if the new regression exposes a defect

**Interfaces:**

- Reuse `createFixture()`, `runCli()`, `jsonEnvelope()`, `readFile()`, `stat()`, and `parse()` from `yaml`.
- The recipe uses step 0 as a File effect, step 1 as a required Custom, and step 2 as a File that must not run after the failure.
- Produces a state file after the first run containing only the completed step 0 effect, and after the second run containing each effect exactly once.

- [ ] **Step 1: Write the failing acceptance test**

Add this test next to the existing cancellation/reconciliation test:

```typescript
test("MVP CLI persists required failure state and reconciles it later", async () => {
  const fixture = await createFixture();
  const allowCustom = ["--allow-custom", fixture.sourceRoot];
  try {
    await writeFile(
      join(fixture.sourceRoot, "baseline", "recipe.yaml"),
      [
        "schemaVersion: 1",
        "steps:",
        "  - type: file",
        "    input: files/hello.txt",
        "    target: generated/before-failure.txt",
        "  - type: custom",
        "    check:",
        "      runtime: node",
        "      content: 'return { status: \"ok\", changed: false };'",
        "    install:",
        "      runtime: node",
        "      content: |",
        "        if (request.operation === \"install\") {",
        "          console.error(\"required-install-failure\");",
        "          return { status: \"error\", changed: false, message: \"required failure\" };",
        "        }",
        "        return { status: \"ok\", changed: false };",
        "  - type: file",
        "    input: files/hello.txt",
        "    target: generated/after-failure.txt",
        "",
      ].join("\n"),
      "utf8",
    );

    const failed = await runCli(fixture, [
      "install",
      "--root",
      fixture.consumerRoot,
      ...allowCustom,
      "--json",
    ]);
    assert.equal(failed.exitCode, 1, failed.stdout);
    assert.match(failed.stderr, /required-install-failure/);
    const failedEnvelope = jsonEnvelope(failed, "install");
    assert.equal(failedEnvelope.status, "error");
    assert.equal(
      await readFile(
        join(fixture.consumerRoot, "generated", "before-failure.txt"),
        "utf8",
      ),
      "hello\n",
    );
    const beforeFailurePath = join(
      fixture.consumerRoot,
      "generated",
      "before-failure.txt",
    );
    const beforeFailureMtime = (await stat(beforeFailurePath)).mtimeMs;
    assert.equal(
      await readFile(
        join(fixture.consumerRoot, "generated", "after-failure.txt"),
        "utf8",
      ).catch(() => undefined),
      undefined,
    );
    const partialState = await readFile(
      join(fixture.consumerRoot, ".tbboot", "state.yaml"),
      "utf8",
    );
    assert.deepEqual(
      parse(partialState).effects.map(({ step }) => step),
      [0],
    );

    await writeFile(
      join(fixture.sourceRoot, "baseline", "recipe.yaml"),
      [
        "schemaVersion: 1",
        "steps:",
        "  - type: file",
        "    input: files/hello.txt",
        "    target: generated/before-failure.txt",
        "  - type: custom",
        "    check:",
        "      runtime: node",
        "      content: 'return { status: \"ok\", changed: false };'",
        "    install:",
        "      runtime: node",
        "      content: 'return { status: \"ok\", changed: false };'",
        "  - type: file",
        "    input: files/hello.txt",
        "    target: generated/after-failure.txt",
        "",
      ].join("\n"),
      "utf8",
    );
    const reconciled = await runCli(fixture, [
      "install",
      "--root",
      fixture.consumerRoot,
      ...allowCustom,
      "--json",
    ]);
    assert.equal(reconciled.exitCode, 0, reconciled.stdout);
    assert.equal(jsonEnvelope(reconciled, "install").status, "ok");
    assert.equal(
      await readFile(
        join(fixture.consumerRoot, "generated", "after-failure.txt"),
        "utf8",
      ),
      "hello\n",
    );
    assert.equal((await stat(beforeFailurePath)).mtimeMs, beforeFailureMtime);
    const finalState = await readFile(
      join(fixture.consumerRoot, ".tbboot", "state.yaml"),
      "utf8",
    );
    assert.deepEqual(
      parse(finalState).effects.map(({ step }) => step),
      [0, 1, 2],
    );
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run only the new regression**

Run:

```powershell
node --test --test-name-pattern "required failure state" test/mvp-acceptance.e2e.test.ts
```

Expected before a production correction: the test either passes against the existing checkpointing behavior or identifies the exact state/reconciliation defect. A failure caused by a stale assertion or invalid fixture is corrected in the test, not in production.

- [ ] **Step 3: Correct only a shared persistence defect**

If the targeted test exposes a real defect, update the common install loop in `src/install.ts` so each completed File/Custom effect is persisted before the next action and the existing effect key/sequence is reused on a later run. Preserve `exitCode: 130` for cancellation and do not add rollback.

- [ ] **Step 4: Re-run the regression and inspect state**

Run:

```powershell
node --test --test-name-pattern "required failure state" test/mvp-acceptance.e2e.test.ts
```

Expected: PASS; first run has only step 0, second run has steps 0, 1, and 2 once each, and the later File is absent after the first run and present after the second.

- [ ] **Step 5: Commit the failure/reconciliation slice**

```powershell
git add test/mvp-acceptance.e2e.test.ts src/install.ts
git commit -m "test: cover required failure reconciliation"
```

## Task 4: Bound the Windows console-cancellation gap and update evidence

**Files:**

- Modify: `test/mvp-acceptance.e2e.test.ts` only if a reliable OS-level path is available
- Modify: `docs/acceptance/mvp-windows-x64.md`

**Interfaces:**

- Existing `runCliUntilFile()` remains the deterministic in-process cancellation helper.
- A real-console probe, if accepted, must produce exit 130, terminate the active Custom process, and suppress the later File step.
- The documentation must identify exactly which cancellation path was exercised.

- [ ] **Step 1: Run a bounded Windows console-control probe**

Use a temporary PowerShell probe outside the repository to test whether the current Windows runner can attach to the spawned CLI console and call `GenerateConsoleCtrlEvent` for the child process group. The probe must be bounded to 15 seconds and must report success only when the child exits because of the control event, not because it was force-killed.

The probe command is:

```powershell
$source = @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleControl {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
}
'@
Add-Type -TypeDefinition $source
```

Use a temporary launcher with the same `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`
flags as the committed test to start a child that runs the cancellable CLI and
exposes its process id, wait method, exit code, and handle cleanup. After the
`Add-Type` check, the probe must execute this bounded sequence:

```powershell
$child = [ProbeProcess]::Launch($cliCommand, $consumerRoot)
try {
  [ConsoleControl]::FreeConsole() | Out-Null
  if (-not [ConsoleControl]::AttachConsole([uint32]$child.Id)) {
    throw "Unable to attach to the child console"
  }
  try {
    if (-not [ConsoleControl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) {
      throw "Unable to ignore Ctrl+C in the probe"
    }
    if (-not [ConsoleControl]::GenerateConsoleCtrlEvent(0, 0)) {
      throw "Unable to generate CTRL_C_EVENT"
    }
  } finally {
    [ConsoleControl]::FreeConsole() | Out-Null
  }
  if (-not $child.WaitForExit(15000)) {
    throw "The child did not exit within 15 seconds"
  }
  if ($child.ExitCode -ne 130) {
    throw "The child did not exit through cancellation: $($child.ExitCode)"
  }
} finally {
  if (-not $child.HasExited) {
    taskkill.exe /PID $child.Id /T /F | Out-Null
  }
  $child.Dispose()
}
```

Use the result only as an implementation decision. Do not commit the probe or a native helper.

- [ ] **Step 2: Add the real-process test only when the probe is repeatable**

If the probe succeeds twice on the same Windows environment, extend `test/mvp-acceptance.e2e.test.ts` with a separate test that spawns the CLI with a detached process group, waits for `cancel-ready`, attaches the helper to that console, sends `GenerateConsoleCtrlEvent(0, 0)`, waits for the child to exit, and asserts:

```typescript
assert.equal(cancelled.exitCode, 130);
assert.match(cancelled.stderr, /cancel|SIGINT/i);
assert.equal(
  await readFile(join(fixture.consumerRoot, "after-cancel.txt"), "utf8")
    .catch(() => undefined),
  undefined,
);
```

The test must clean up the child process in a `finally` block and must never fall back to an unconditional force kill while reporting success.

- [ ] **Step 3: Document the actual result when the probe is unavailable**

If the probe cannot produce a repeatable control event, do not add a flaky test. Update the final cancellation paragraph in `docs/acceptance/mvp-windows-x64.md` to say that:

1. `MVP CLI cancels Custom install at the process boundary and reconciles` validates deterministic in-process abort wiring through `process.emit("SIGINT")`;
2. `test/custom.test.ts` validates descendant termination at the adapter boundary;
3. no committed test currently generates a Windows console Ctrl+C event;
4. a native console-control helper is a separate technical follow-up.

- [ ] **Step 4: Add coverage publication to the acceptance commands**

Change the command block in `docs/acceptance/mvp-windows-x64.md` to:

```powershell
npm run typecheck
npm test
npm run test:coverage
npm run check
npm run build
```

Add one sentence immediately after it: the canonical CI leg streams the native Node table to the log, writes `coverage/summary.txt` to the job summary, and uploads it as `tbboot-coverage`.

- [ ] **Step 5: Validate the evidence document**

Run:

```powershell
npm run check:md
git diff --check
```

Expected: both commands exit 0 and the document does not describe `process.emit` as an OS-level Ctrl+C.

- [ ] **Step 6: Commit the evidence slice**

```powershell
git add test/mvp-acceptance.e2e.test.ts docs/acceptance/mvp-windows-x64.md
git commit -m "docs: clarify Windows cancellation evidence"
```

## Task 5: Run the complete verification gate

**Files:**

- No new files; inspect the committed changes from Tasks 1–4.

- [ ] **Step 1: Run the targeted acceptance tests**

```powershell
node --test test/mvp-acceptance.e2e.test.ts
```

Expected: all applicable tests pass; the existing Windows-only skip remains documented.

- [ ] **Step 2: Run the full production suite with coverage**

```powershell
npm run test:coverage
```

Expected: 0 failures, the documented skip only, and an ASCII table with uncovered line ranges.

- [ ] **Step 3: Run all repository quality checks**

```powershell
npm run typecheck
npm run check
npm run build
npm pack --dry-run --json
```

Expected: all commands exit 0.

- [ ] **Step 4: Review the final diff**

```powershell
git diff main...HEAD --check
git diff --stat main...HEAD
git status --short --branch
```

Expected: only the approved design, plan, coverage wiring, acceptance tests, and evidence documentation are changed; the working tree is clean.

- [ ] **Step 5: Commit verification-only documentation if needed**

If the verification changes no files, make no empty commit. If it only updates the evidence document with measured coverage values, commit:

```powershell
git add docs/acceptance/mvp-windows-x64.md
git commit -m "docs: record MVP coverage evidence"
```

## Self-review against the approved design

- Native coverage, ASCII uncovered-line details, one canonical CI leg, job summary, and downloadable artifact are covered by Task 1.
- TypeScript erasable production CLI coverage is covered by Task 2.
- Required failure, persisted partial state, and later idempotent reconciliation are covered by Task 3.
- Deterministic cancellation is preserved; real Windows Ctrl+C is either separately proven or explicitly documented as unavailable by Task 4.
- Acceptance documentation is updated by Task 4.
- Issues #42, #44, and #45, HTML coverage, thresholds, rollback, and architecture changes remain outside the plan.
- No placeholders or unowned scope changes remain.
