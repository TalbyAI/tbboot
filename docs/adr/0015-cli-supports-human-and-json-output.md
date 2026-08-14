# CLI supports human and JSON output

The MVP provides human-readable output by default for `doctor`, `install`, `install --dry-run`, and `uninstall`. With `--json`, stdout contains exactly one JSON document and stderr is reserved for logs. Output mode does not change the command exit-code semantics.

The common JSON envelope is `{ schemaVersion, command, status, changed, actions, diagnostics }`. `status` is `ok`, `warning`, or `error`; actions describe performed or planned work, and every diagnostic contains at least `code`, `severity`, and `message`, plus Source, Recipe, and Step context when available.

Custom results map into the command envelope rather than adding envelope statuses:

| Custom result | Envelope result | Exit code |
| --- | --- | --- |
| `ok` | Preserve `changed`; record performed or planned work in `actions`; `status: ok` unless another warning or error exists. | `0` unless another required failure exists. |
| `missing`, `drift`, or `error` on a required Step | `status: error`, `changed` reflects work already completed, and an error diagnostic uses `custom-missing`, `custom-drift`, or `custom-error`. | Non-zero. |
| `missing`, `drift`, or `error` on an optional Step | `status: warning`, `changed` reflects work already completed, and a warning diagnostic uses the corresponding code. Remaining Steps continue. | `0` unless another required failure exists. |

`install --force` changes only the documented File and File Fragment drift rules; a Custom operation must still return `ok` after installation, so Custom `drift` maps as above with or without `--force`. In `install --dry-run`, Custom processes are not run: their planned actions are included with a `custom-check-deferred` warning, `changed` remains `false`, and that warning alone keeps exit code `0`. During `uninstall`, a missing Custom `uninstall` handler produces the warning diagnostic `uninstall-unsupported`, preserves the Installation record entry, and is not a Custom result status or a command failure. Envelope `status` is the highest severity aggregated across all Steps.
