# Custom steps are detected and gated per Source

The Manifest does not declare or authorize Custom steps. The tool discovers them while reading Recipes. Custom steps use the generic Step optionality rule: every Step is required by default, while `optional: true` makes failure or lack of authorization non-blocking. An unauthorized optional step is skipped, while an unauthorized required step prevents that Recipe from being installed. The decision must be made during preflight so skipped or blocked steps cannot leave partial writes. Authorization is external to the Manifest and is granted per Source and resolved revision.

In interactive mode the tool may ask for authorization once per Source. In non-interactive mode it never prompts; `--allow-custom <source>` grants temporary authorization for the invocation, while persistent trust belongs to the user's local profile.

Persistent trust is stored in `~/.tbboot/trust.yaml`, which maps to `%USERPROFILE%\.tbboot\trust.yaml` on Windows. The user-home location is chosen for developer visibility and future Unix compatibility. Entries are keyed by normalized Source identity and resolved revision, so a new revision requires new authorization.

Each Custom lifecycle operation may select its own supported runtime. The future schema should allow an operation to declare ordered runtime candidates, each carrying exactly one external `script` path or inline `content`, plus an optional provider-specific version constraint; the resolver selects the first available compatible candidate. When omitted, the provider's minimum supported runtime applies. An explicit selector may opt into an older runtime that the default policy excludes. The canonical runtime names are `node`, `pwsh` for PowerShell 7, and `windows-powershell` for Windows PowerShell 5.1. The MVP implements a single runtime candidate per operation and supports only `node` and `pwsh`; `windows-powershell` is not a separately supported target. The default supported ranges are Node `>=24.12 <25` and PowerShell `>=7.6 <8`. The `node` runtime invokes JavaScript and TypeScript directly, without auxiliary runners or TypeScript flags. TypeScript is limited to the erasable syntax handled by Node's default type stripping; syntax requiring transformation, including `enum` and parameter properties, is unsupported because Node 24 requires `--experimental-transform-types` for it. Both forms share the same authorization gate. URLs and other remote script sources are not part of this contract.

In the MVP, File and File Fragment are the only built-in step types. All other behavior, including command checks, is expressed as a Custom step. Repeated safe patterns may later be promoted to dedicated step types.

The MVP does not include a Package step or a built-in WinGet provider. Windows software installation, when explicitly offered by a Recipe, uses an authorized Custom `install` operation.

Custom operations use a process protocol in the MVP: stdin carries a JSON request, stdout must contain exactly one JSON result, and stderr is reserved for logs. Exit code `0` means that a valid result was produced; any non-zero code means that the runner or script failed to produce a valid result. The result object is the source of semantic state such as satisfied, drift, or error. Structured JSON results are therefore required, while exit codes do not duplicate semantic states.

Each runtime adapter exposes the same logical asynchronous handler from validated input to a result object. Inline `content` is the handler body wrapped by tbboot; an external `script` exposes the runtime's handler form. File and File Fragment use the same logical request/result contract internally even though they do not run as external processes.

The MVP result envelope is `{ status, changed, message?, details? }`. `status` may be `ok`, `missing`, `drift`, or `error`; `changed` reports whether the operation modified state; `message` and `details` provide optional diagnostics and Step-specific data.

Each Custom operation receives a JSON request through stdin containing its operation and canonical context such as the consumer root, Source root, Recipe path, and Step index. The process working directory is the consumer repository root. This request does not contain secrets, and the MVP does not require an additional environment-variable contract.

Every Custom step must define `check`. `install` is optional, allowing a check-only Step such as verifying that Node is already available. `uninstall` may be declared only when `install` is present; a Step cannot define an uninstall operation without an installation operation.

`doctor` always executes `check`. During `install`, a Custom step with `install` executes that operation and then executes `check` to verify the result. A check-only Custom step executes only `check` during `install`.

`install --dry-run` does not execute any Custom process because authorization is not a read-only boundary. It validates the Custom definition, authorization, runtime, and paths statically, reports `check` and lifecycle actions as deferred, and never writes artifacts.

A check-only Custom step never installs or updates an external runtime implicitly. Node is installed or updated only when the Recipe explicitly declares a Custom `install` operation for it.

During `uninstall`, Custom operations run in reverse effective install order when declared. Their purpose is removal of managed effects, not full rollback.

If an installed Custom step does not declare `uninstall`, the operation leaves its effects intact, reports `uninstall-unsupported` as a warning, preserves its Installation record entry, and exits successfully if no other required failure occurs. This declared lifecycle limitation is not a required-Step failure.

An external Custom `script` path is resolved relative to the Recipe directory. It may use parent segments to reach shared files elsewhere within the Source, but preflight canonicalizes both the Source root and existing script path through filesystem links, including symlinks and Windows junctions, before checking containment. Absolute paths, missing scripts, and canonical paths outside the canonical Source root are rejected. Inline `content` has no source-file path to validate.

Authorization is not a sandbox. An authorized Custom process runs with the normal permissions of tbboot's process; the MVP does not provide a filesystem or network allowlist and does not elevate privileges automatically.

Custom operations have finite timeouts. The defaults are 60 seconds for `check` and 30 minutes for `install` or `uninstall`; each runtime candidate may override its operation timeout. On expiration, the platform adapter requests graceful termination of the complete process tree, waits a bounded grace period, then force-terminates remaining descendants. Failure to confirm termination is reported as an error. The timeout result remains subject to the Step's optionality rule.

Manual cancellation terminates the active Custom process tree, stops subsequent Steps, preserves completed Installation record entries, performs no rollback, and makes the CLI exit with code `130`.
