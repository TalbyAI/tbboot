# Issue 12: CLI acceptance fixture design

## Goal

Create an isolated end-to-end harness for future tbboot CLI slices. The
harness creates deterministic temporary Consumer repositories and Sources,
runs a CLI as a real child process, captures its three observable process
outputs, and compares filesystem snapshots without importing production
internals.

## Context

The repository does not yet contain the production CLI. Issue 12 therefore
owns the reusable fixture and process boundary; later CLI issues will supply
the executable and use the same harness. The Issue 5 prototype remains an
independent experiment and is not copied into this fixture.

## Architecture

Everything lives under `prototypes/issue-12/`:

- `fixture/consumer/` contains the checked-in Consumer repository template.
- `fixture/source/` contains the checked-in Source template and its minimal
  Recipe input.
- `harness.mjs` copies the templates into a unique temporary directory,
  launches a configurable command with the Consumer repository as working
  directory, captures `exitCode`, `stdout`, and `stderr`, snapshots file
  paths and bytes, and parses one JSON document from stdout.
- `test/fixtures/cli.mjs` is only a child-process probe for testing the
  harness while the production CLI is absent; it is not a tbboot
  implementation.
- `test/prototype.test.mjs` verifies fixture isolation and cleanup, process
  stream separation, single-document JSON parsing, byte-for-byte snapshots,
  and read-only comparisons.
- `README.md` documents the commands and the extension pattern for adding
  acceptance scenarios without mixing prototype code into production.

The harness exposes small public helpers:

```js
createFixture() -> Promise<{ root, consumerRoot, sourceRoot, cleanup }>
runCommand({ file, args, cwd, env }) -> Promise<{ exitCode, stdout, stderr }>
snapshotFiles(root) -> Promise<Array<{ path, bytes }>>
parseJsonOutput(stdout) -> unknown
```

`createFixture` uses a unique temporary directory and `cleanup` removes only
that directory. `snapshotFiles` records relative file paths and raw `Buffer`
contents, so an unchanged read-only operation can be proven byte-for-byte.
`parseJsonOutput` accepts surrounding whitespace but rejects empty or multiple
JSON documents. `runCommand` does not merge stdout and stderr.

## Testing

Tests use only Node's built-in `node:test` and `node:assert/strict`. The probe
CLI is launched through `runCommand`, proving the harness's real process
boundary rather than calling the probe as an imported function. Tests always
snapshot before and after read-only behavior and assert equality of both file
names and bytes.

## Scope

Included: deterministic fixture creation and cleanup, command execution,
stream and exit-code capture, JSON output validation, filesystem snapshots,
and extension documentation.

Excluded: a production CLI, YAML parsing, installation behavior, external
dependencies, and reuse of Issue 5 implementation code. Those belong to the
dependent issues that consume this harness.
