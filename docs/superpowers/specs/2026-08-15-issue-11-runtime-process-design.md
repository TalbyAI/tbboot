# Issue 11: runtime and process control prototype

## Goal

Build an isolated Windows x64 prototype showing how tbboot detects supported
runtimes, executes Custom handlers, and terminates a complete process tree.
The prototype is evidence for the MVP contract; it is not production code.

## Scope

- Detect `node` with the supported range `>=24.12 <25`.
- Detect `pwsh` (PowerShell 7) with the supported range `>=7.6 <8`.
- Detect `powershell.exe` (Windows PowerShell 5.1) and report it as explicitly
  unsupported, even when it is installed.
- Execute JavaScript and erasable TypeScript through Node's native type
  stripping, without a TypeScript runner or transform flags.
- Execute PowerShell handlers through PowerShell 7.
- Use one JSON request on stdin, one JSON result on stdout, and stderr for
  logs.
- Terminate the complete process tree on timeout or cancellation.
- Map manual cancellation to exit code `130`; completed work is not rolled
  back.

The prototype runs against real executables on Windows x64. On other systems,
Windows-specific tests report that they are skipped or unavailable; they do
not emulate Windows behavior.

## Design

All files live under `prototypes/issue-11/` and use only Node built-ins.

- `runtime.mjs` detects executable availability and parses the small fixed
  version ranges needed by this prototype.
- `runner.mjs` starts a runtime without a shell, sends the JSON request, reads
  the JSON result, and reports malformed output or non-zero child exits.
- Runtime adapters expose the common handler shape. Node loads `.js` and `.ts`
  handlers directly; PowerShell 7 invokes a `.ps1` handler. Inline content is
  wrapped by the adapter.
- `process-tree.mjs` handles timeout and cancellation with Windows
  `taskkill /PID <pid> /T /F`. Both paths wait for the child to close.
- A small driver handles `SIGINT`, calls the same cancellation path, and exits
  with `130`.

No shell command strings, package dependencies, catalog behavior, YAML
handling, authorization, installation, rollback, or cross-platform process
abstraction are part of this prototype.

## Verification

The Node test runner covers:

1. compatible, incompatible, missing, and explicitly unsupported runtime
   classifications;
2. JavaScript, erasable TypeScript, and PowerShell handler execution;
3. the stdin/stdout/stderr protocol and invalid-result failures;
4. timeout termination of a root process plus child and grandchild;
5. deterministic cancellation with exit code `130` and no rollback action.

The README documents a manual Ctrl+C run against the driver so the real console
signal path is demonstrated separately from the deterministic test hook.
