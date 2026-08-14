# Preflight all steps before installation writes

Before `install` writes anything, the tool validates every source, recipe, step, path, and known conflict across the complete manifest and calculates the complete plan. Repeated source references that resolve to the same normalized location are errors, and the diagnostic must identify the duplicate entries and recommend explicit deduplication. In the prototype, a fragment marker identifies a local source by its root folder name and the Recipe relative path; collisions from different sources are conflicts. A `File` target cannot be shared with another writing step; multiple `File Fragment` steps may target one file when their managed markers are distinct. Drift blocks writes by default. `install --force` may overwrite a drifted complete file or replace only a drifted managed fragment, but it does not resolve structural conflicts. If preflight fails, the operation stops without writing. This does not imply rollback after an unexpected process or filesystem failure during the write phase.

**Consequences**: predictable validation errors cannot leave a partial installation, while crash recovery remains a later concern and is not simulated by the prototype.

After writes begin, the MVP does not roll back completed Steps. It records completed effects in `.tbboot/state.yaml`; a required failure or cancellation stops the remaining plan, while an optional failure records a warning and continues. A later invocation rechecks and reconciles the surviving state.

`install` and `install --dry-run` use the same success boundary: code `0` means the required plan is executable or completed, while conflicts, preflight errors, required failures, or unforced drift return a non-zero code. Optional failures remain warnings with code `0`. Dry-run reports the plan but never executes write operations.

The MVP does not prompt to resolve drift: overwriting requires the explicit `--force` flag.

`uninstall` removes managed effects in reverse install order but is not rollback. A File created by tbboot may be removed when unchanged; a pre-existing File that tbboot overwrote is not reconstructed automatically. File Fragment removes only its managed block and preserves unrelated content.

Drift blocks uninstall by default. With `uninstall --force`, a drifted File may be removed only when the Installation record proves tbboot created it, and a drifted managed fragment may be removed without touching unrelated content. A pre-existing overwritten File is never deleted automatically, and structural conflicts remain errors.
