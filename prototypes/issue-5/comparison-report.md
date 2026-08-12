# Issue 5 comparison report

Generated on 2026-08-12 13:45:06 +02:00.

## Run status

- Proposed path: exercised through the full scenario matrix.
- Composition path: chezmoi missing; adapter-emulated scenarios were not exercised; 5 scenarios are unsupported by the fixed adapter.
- Fixture: copied to separate temporary consumer roots; no temporary files are retained.

## Commands

```powershell
Set-Location prototypes/issue-5
npm install
npm test
npm run compare
```

The proposed path uses `node proposed/cli.mjs`. The composition path uses
`composition.ps1` with `chezmoi --source ... --destination ... apply` and the
PowerShell fragment adapter.

Composition rows marked `adapter-emulated` use fixed composition inputs,
including `compositionSource`, `fixtureRoot`, and `fragmentFiles`. Rows marked
`unsupported` have no equivalent in this adapter; it does not discover
`source.yaml` or `recipe.yaml`, so no native composition coverage is claimed.

## Scenario matrix

| Scenario | Composition | Proposed semantics | Writes | Diagnostics | Checks | Notes |
|---|---|---|---|---|---|---|
| source/recipe discovery | unsupported: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Proposed path discovers source.yaml and recipe.yaml; the composition adapter has no equivalent. |
| complete-file creation | adapter-emulated: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Composition uses its fixed chezmoi-source; this is adapter-emulated. |
| recipe-local input | unsupported: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | The composition adapter does not read recipe-local input from recipe.yaml. |
| two managed fragments | adapter-emulated: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Composition uses fixed fixtureRoot and fragmentFiles through its fragment adapter. |
| doctor | adapter-emulated: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Read-only plan over the adapter inputs. |
| dry-run | adapter-emulated: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Read-only install plan over the adapter inputs. |
| preflight failure | unsupported: not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: source-input-escape | composition: not exercised; proposed: passed | The proposed path rejects a source-input escape; the composition adapter has no source-input preflight. |
| identical no-op | adapter-emulated: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: changed; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Second install preserves bytes through the fixed adapter inputs. |
| drift | adapter-emulated: not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: changed; command: unchanged | composition: prerequisite missing; proposed: file-drift | composition: not exercised; proposed: passed | Complete-file drift is checked through the fixed composition adapter. |
| conflict | unsupported: not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: file-target-collision | composition: not exercised; proposed: passed | The proposed path changes recipe.yaml; the composition adapter ignores that input. |
| duplicate source reference | unsupported: not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: duplicate-source | composition: not exercised; proposed: passed | Composition has no manifest/source-reference equivalent. |
| second install | adapter-emulated: not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: changed; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Idempotence check through the fixed adapter inputs. |

## Measured setup and custom code

| Measure | Proposed semantics | Composition |
|---|---:|---:|
| Setup instructions | 3 (`npm install`, `npm test`, CLI/runner) | 2 (install chezmoi, invoke PowerShell; mise optional) |
| Path implementation files | 2 | 2 |
| Path implementation lines | 419 | 92 |

## Verdict

Prototype closed. Proposed checks: 12/12; composition coverage: not exercised (chezmoi missing); 5 unsupported; setup 3 versus 2 instructions; and 2/419 versus 2/92 non-fixture code files/lines. Composition coverage is adapter-emulated from fixed compositionSource, fixtureRoot, and fragmentFiles inputs; no native source.yaml or recipe.yaml discovery is claimed. The fixture covers files, fragments, preflight, drift, conflicts, and idempotence, but not command checks, interactive source selection, catalogs, or dependencies. Product decision: build the differentiated tool in TypeScript on Node.js. Missing chezmoi limits the technical comparison coverage but does not block this product decision based on the final scope.

This report is generated by `run-comparison.ps1` from the documented commands.
When `chezmoi` is unavailable, the composition column remains explicitly
unexercised instead of substituting another implementation.