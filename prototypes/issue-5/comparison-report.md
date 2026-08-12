# Issue 5 comparison report

Generated on 2026-08-12 12:28:53 +02:00.

## Run status

- Proposed path: exercised through the full scenario matrix.
- Composition path: chezmoi missing; composition scenarios were not exercised.
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

## Scenario matrix

| Scenario | Composition | Proposed semantics | Writes | Diagnostics | Checks | Notes |
|---|---|---|---|---|---|---|
| source/recipe discovery | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Fresh install checks local source and first-level recipe discovery. |
| complete-file creation | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Checks .editorconfig creation. |
| recipe-local input | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Checks the recipe-local project guide. |
| two managed fragments | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: changed | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Checks both markers and preserved unmanaged text. |
| doctor | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Read-only plan. |
| dry-run | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Read-only install plan. |
| preflight failure | not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: source-input-escape | composition: not exercised; proposed: passed | Proposed path rejects a source-input escape before writing. |
| identical no-op | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: changed; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Second install must preserve bytes. |
| drift | not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: changed; command: unchanged | composition: prerequisite missing; proposed: file-drift | composition: not exercised; proposed: passed | Modified complete target must not be overwritten. |
| conflict | not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: file-target-collision | composition: not exercised; proposed: passed | Target collision versus chezmoi changed-target conflict. |
| duplicate source reference | not run (chezmoi missing; exit 2) | exit 1 | composition: not measured; proposed: preparation: unchanged; command: unchanged | composition: prerequisite missing; proposed: duplicate-source | composition: not exercised; proposed: passed | Composition has no manifest/source-reference equivalent. |
| second install | not run (chezmoi missing; exit 2) | exit 0 | composition: not measured; proposed: preparation: changed; command: unchanged | composition: prerequisite missing; proposed: none | composition: not exercised; proposed: passed | Idempotence check. |

## Measured setup and custom code

| Measure | Proposed semantics | Composition |
|---|---:|---:|
| Setup instructions | 3 (`npm install`, `npm test`, CLI/runner) | 2 (install chezmoi, invoke PowerShell; mise optional) |
| Path implementation files | 2 | 2 |
| Path implementation lines | 419 | 92 |

## Verdict

Prototype closed. Proposed checks: 12/12; composition coverage: not exercised (chezmoi missing); setup 3 versus 2 instructions; and 2/419 versus 2/92 non-fixture code files/lines. The fixture covers files, fragments, preflight, drift, conflicts, and idempotence, but not command checks, interactive source selection, catalogs, or dependencies. Product decision: build the differentiated tool in TypeScript on Node.js. Missing chezmoi limits the technical comparison coverage but does not block this product decision based on the final scope.

This report is generated by `run-comparison.ps1` from the documented commands.
When `chezmoi` is unavailable, the composition column remains explicitly
unexercised instead of substituting another implementation.