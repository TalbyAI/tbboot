# Issue 11: runtime and process control prototype — implementation notes

> Normative acceptance criteria live in [GitHub Issue #11](https://github.com/TalbyAI/tbboot/issues/11). This file is non-normative implementation and verification guidance.

## Goal

Build an isolated Windows x64 prototype showing how tbboot detects supported
runtimes, executes Custom handlers, and terminates a complete process tree.
The prototype is evidence for the MVP contract; it is not production code.

## Scope

- Detect `node` with the supported range `>=24.12 <25`.
- Detect `pwsh` (PowerShell 7) with the supported range `>=7.6 <8`.
- Detect `powershell.exe` (Windows PowerShell 5.1) and report it as explicitly
  unsupported, even when it is installed.
- Use the canonical runtime ids `node`, `pwsh`, and `windows-powershell`; only
  the first two are supported by this MVP prototype.
- Execute JavaScript and erasable TypeScript through Node's native type
  stripping, without a TypeScript runner or transform flags.
- Execute PowerShell handlers through PowerShell 7.
- Use one JSON request on stdin, one JSON result on stdout, and stderr for
  logs.
- Terminate the complete process tree on timeout or cancellation.
- Map manual cancellation to exit code `130`; completed work is not rolled
  back.

The prototype runs against real executables on Windows x64. On non-Windows
systems and Windows non-x64 hosts, Windows-specific tests report that they are
skipped or unavailable; they do not emulate Windows behavior.

## Design

All files live under `prototypes/issue-11/` and use only Node built-ins.

- `runtime.mjs` detects executable availability and parses the small fixed
  version ranges needed by this prototype. Detection reports the canonical
  runtime ids and the selected executable path; `powershell.exe` is the command
  for `windows-powershell`. Runtime definitions are deeply immutable, and a
  non-ENOENT probe failure is a `runtime-probe-failed` detection error with the
  captured stdout and stderr preserved.
- `runner.mjs` starts a runtime without a shell, sends the JSON request, reads
  the JSON result, and reports malformed output, spawn failures, or non-zero
  child exits. It receives a runtime id and executable path that the caller has
  already detected as compatible; it never probes PATH or resolves another
  executable.
- Runtime adapters expose the common handler shape. Node loads `.js` and `.ts`
  handlers directly; PowerShell 7 invokes an external `.ps1` handler with
  `-File`, and that script reads and deserializes stdin itself. Inline
  PowerShell content is wrapped by the adapter so the wrapper reads stdin and
  exposes `$Request` before evaluating the body.
- The runner's `timeoutMs` is optional: when omitted, no runner timer is
  started; otherwise it is a safe integer from 1 through `2_147_483_647`.
  The production operation layer owns the ADR defaults (60 seconds for `check`,
  30 minutes for `install`/`uninstall`) and passes the selected value to the
  runner.
- `process-tree.mjs` handles timeout and cancellation with Windows
  `taskkill /PID <pid> /T /F`, bounded to 5 seconds. After a successful kill,
  the runner waits up to 5 more seconds for child close. Termination-command
  failures remain `tree-termination-failed`; a close timeout preserves the
  original `timeout` or `cancelled` reason.
- A small driver handles `SIGINT`, calls the same cancellation path, and exits
  with `130`.

No OS shell command lines, `shell: true`, package dependencies, catalog
behavior, YAML handling, authorization, installation, rollback, or
cross-platform process abstraction are part of this prototype. For inline
PowerShell, the `-Command` value is PowerShell source passed as one argument to
`pwsh` with `shell: false`; it is not a command launched through `cmd.exe` or
another shell.

## Verification

The Node test runner covers:

1. compatible, incompatible, missing, and explicitly unsupported runtime
   classifications;
2. JavaScript, erasable TypeScript, and PowerShell handler execution;
3. the stdin/stdout/stderr protocol, invalid-result failures, and ENOENT
   spawn failures;
4. executable selection, bounded timeout validation, and already-aborted
   cancellation;
5. timeout termination of a root process plus child and grandchild, including
   termination failures while a handler is running;
6. deterministic cancellation with exit code `130` and no rollback action.

The README documents a manual Ctrl+C run against the driver so the real console
signal path is demonstrated separately from the deterministic test hook.
