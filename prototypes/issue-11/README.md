# Issue 11 runtime and process prototype

This isolated prototype demonstrates runtime detection, Custom handler
execution, and complete process-tree termination. It is not production
integration.

## Prerequisites

Windows x64 and Node.js `>=24.12 <25`. PowerShell 7 `>=7.6 <8` is required
only for the `pwsh` tests. Windows PowerShell 5.1 (`powershell.exe`) is
detected but never accepted as a supported runtime.

Non-Windows and Windows non-x64 test runs skip Windows-specific behavior
instead of emulating it.

## Run

```powershell
Set-Location prototypes/issue-11
npm run check
npm test
```

## Manual Ctrl+C demonstration

```powershell
node driver.mjs --runtime node --script test/fixtures/cancellable-handler.js --request '{"completedFile":"C:\\temp\\tbboot-issue-11-completed.txt"}' --timeout-ms 30000
```

Press Ctrl+C. The process exits with code `130`, and the completed file
remains. For deterministic tests, `--cancel-when-file <path>` cancels after a
handler-written marker appears. `--cancel-after-ms <positive integer>` is the
simple timed cancellation hook.

## Handler protocol

The runner sends one JSON request on stdin, reads one JSON result from stdout,
and preserves stderr for logs. A result is an object with `status` equal to
`ok`, `missing`, `drift`, or `error`, plus a boolean `changed` field; `message`
and `details` are optional.

Node imports `.js` and erasable `.ts` handlers directly with native type
stripping and no transform flags. PowerShell handlers run through `pwsh`.
External PowerShell scripts read and deserialize stdin themselves; inline
PowerShell content is wrapped by the adapter.

Timeout and cancellation use `taskkill.exe /T /F` to terminate the complete
Windows process tree, then wait for the child to close. No rollback or cleanup
action is performed.

The prototype intentionally excludes catalogs, YAML, authorization,
installation, rollback, package dependencies, cross-platform process
abstraction, and production integration.
