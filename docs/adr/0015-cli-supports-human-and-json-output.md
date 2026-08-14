# CLI supports human and JSON output

The MVP provides human-readable output by default for `doctor`, `install`, `install --dry-run`, and `uninstall`. With `--json`, stdout contains exactly one JSON document and stderr is reserved for logs. Output mode does not change the command exit-code semantics.

The common JSON envelope is `{ schemaVersion, command, status, changed, actions, diagnostics }`. `status` is `ok`, `warning`, or `error`; actions describe performed or planned work, and every diagnostic contains at least `code`, `severity`, and `message`, plus Source, Recipe, and Step context when available.
