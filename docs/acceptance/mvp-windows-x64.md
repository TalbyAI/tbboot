# MVP Windows x64 acceptance matrix

This is a derived evidence index for Issues #8 and #21. GitHub Issue #8
remains the authoritative contract; the matrix points to executable tests and
does not add requirements.

## Environment gate

| Dimension | Contract | Evidence |
| --- | --- | --- |
| Platform | Windows x64 only | `test/mvp-acceptance.e2e.test.ts`: the runtime boundary test skips outside `win32`/`x64`; the detailed suite also uses Windows-specific Git, process-tree, and path assertions. |
| Node | `>=24.12 <25` | `test/mvp-acceptance.e2e.test.ts`: supported boundary and incompatible selector; `test/custom.test.ts`: runtime detection. |
| PowerShell | `pwsh >=7.6 <8` | `test/mvp-acceptance.e2e.test.ts`: installed runtime boundary and incompatible selector; `test/custom.test.ts`: inline and external PowerShell handlers. |
| Windows PowerShell | Not an MVP runtime | `test/mvp-acceptance.e2e.test.ts`: `windows-powershell` is rejected during schema validation. |

## Scenario matrix

| Contract area | End-to-end evidence |
| --- | --- |
| Schema versioning and reserved selection fields | `test/doctor.e2e.test.ts`: `contract gates fail before discovery and omitted root uses cwd`; `invalid YAML returns one JSON diagnostic and no stderr`. |
| Local Source and File step | `test/doctor.e2e.test.ts`: `install creates a File and records ownership`; `File states are satisfied, missing, or drift with required severity`. |
| Git Source at root and internal Source locator path | `test/doctor.e2e.test.ts`: `doctor resolves Git Sources at the repository root and internal paths`; `Git Source materialization supports repository roots and internal paths`. |
| Git refs, ranges, intersections, and ambiguity | `test/doctor.e2e.test.ts`: `Git selector provider resolves refs, ranges, and intersections`; `same-level duplicate and incompatible Source dependencies fail preflight`. |
| Authoritative lockfile, update, and frozen modes | `test/doctor.e2e.test.ts`: `install creates and reuses an authoritative Git lockfile`; `stale Git lockfiles require update and frozen mode blocks missing entries`; `update-lock removes Git entries no longer declared`. |
| Transitive Source dependencies | `test/doctor.e2e.test.ts`: `Source dependencies resolve transitively, in order, and only once`; `Source dependency cycles fail preflight without writing artifacts`; `compatible transitive Git selectors converge independent of discovery order`. |
| File Fragment ownership and structural safety | `test/doctor.e2e.test.ts`: `File Fragment normalizes line endings and detects missing, drift, and satisfied blocks`; `File Fragment structural failures conflict and distinct markers may share a target`; `force rejects nested Managed blocks and preserves non-UTF8 unrelated bytes`. |
| Custom Node and PowerShell protocol | `test/mvp-acceptance.e2e.test.ts`: `MVP CLI runs external Node and PowerShell Custom handlers`; `test/custom.test.ts`: invalid output, stderr/stdout separation, and descendant termination. |
| Custom authorization and revision-scoped trust | `test/custom.test.ts`: `temporary interactive authorization does not persist trust`; `persistent trust is scoped to the Git Source revision`; `test/doctor.e2e.test.ts`: required and optional unauthorized Custom preflight. |
| Optional and required Steps | `test/doctor.e2e.test.ts`: `missing input is a conflict and optional missing input is a warning`; `optional Custom preparation failures remain warnings`. |
| Timeout, cancellation, and process-tree cleanup | `test/mvp-acceptance.e2e.test.ts`: `MVP CLI reports a Custom timeout through the JSON contract`; `MVP CLI cancels Custom install at the process boundary and reconciles`; `test/custom.test.ts`: `terminates descendants of timed-out handlers`. |
| Read-only doctor and dry-run | `test/mvp-acceptance.e2e.test.ts`: `MVP CLI lifecycle preserves read-only boundaries and ownership`; `test/doctor.e2e.test.ts`: `install dry-run reports the complete plan and is read-only`. |
| Install, idempotence, drift, and force | `test/mvp-acceptance.e2e.test.ts`: lifecycle smoke matrix; `test/doctor.e2e.test.ts`: `install blocks drift and force reconciles only the File`; `install creates distinct Managed blocks and force preserves unrelated content`. |
| Uninstall order, ownership, unsupported Custom uninstall, and reconciliation | `test/mvp-acceptance.e2e.test.ts`: lifecycle smoke matrix; `test/doctor.e2e.test.ts`: `uninstall blocks drift, force removes owned drift, and never bypasses structure conflicts`; `uninstall preserves Custom effects without an uninstall handler`; `uninstall reconciles historical File effects without the current Source`. |
| Partial failure and later reconciliation | `test/mvp-acceptance.e2e.test.ts`: cancellation and later install reconciliation; `test/doctor.e2e.test.ts`: `install records effective sequence and uninstall uses updated order`; `legacy effects assign new sequences above index fallbacks`; `uninstall reconciles built-in effects from the Installation record`. |
| Human output, JSON envelope, stderr, and exit codes | `test/mvp-acceptance.e2e.test.ts`: lifecycle smoke matrix; `test/doctor.e2e.test.ts`: `usage errors return 2 and print usage only on stderr`; `test/support.test.ts`: process stream and single-document JSON checks. |
| Optional Catalog discovery and direct installation | `test/catalog.e2e.test.ts`: registration, deterministic search, duplicate identity rejection, and `direct doctor and install ignore the Catalog registry`. |

The acceptance commands are:

```powershell
npm run typecheck
npm test
npm run check
npm run build
```

The matrix intentionally reuses the existing detailed end-to-end cases for
individual Git, Custom, File, and uninstall edge conditions. The Issue 21
tests add the process-boundary smoke path that combines those contracts and
checks the read-only, output, idempotence, drift, force, and ownership
guarantees together.
