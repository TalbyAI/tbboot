# tbboot

tbboot is a declarative environment bootstrap CLI for Windows repositories.
It checks, installs, and removes the files and managed blocks declared by a
Consumer repository.

## Installation

Global installation:

```powershell
npm install -g @talby/tbboot
tbboot doctor
```

Local installation as a development dependency:

```powershell
npm install --save-dev @talby/tbboot
npx tbboot doctor
```

Run it from a Consumer repository without installing that repository as an npm
project:

```powershell
npx --yes @talby/tbboot doctor
```

## Prerequisites and compatibility

- Node.js `>=24.12 <25` is required.
- npm is required for npm or `npx` installation and execution.
- Windows x64 is the only guaranteed platform for version `0.1.0`.
- macOS, Linux, WSL, and ARM64 are outside the supported guarantee.
- PowerShell `>=7.6 <8` is required only when a Consumer repository uses a
  Custom step with the `pwsh` runtime.
- Windows PowerShell 5.1 is not supported as a Custom runtime.

## Consumer repository

A Consumer repository declares its Sources in `tbboot.yaml` and keeps the
declaration under version control. For example:

```yaml
schemaVersion: 1
sources:
  - provider: local
    locator:
      path: ../tbboot-source
```

Run tbboot from the repository root, or pass another root explicitly with
`--root`:

```powershell
tbboot doctor
tbboot install --dry-run
tbboot install
tbboot uninstall
```

The optional Catalog commands manage local discovery indexes and do not change
direct Source installation:

```powershell
tbboot catalog add .\catalog.yaml
tbboot catalog list
tbboot catalog search bootstrap
```

Use `--json` for one machine-readable result on stdout. Use
`--allow-custom <source>` only after reviewing and authorizing the referenced
Source.

## Custom steps

Custom steps are explicit executable code supplied by a Source. They use the
`node` or `pwsh` runtime and can inspect or change the Consumer repository.
Every Custom step requires authorization for the Source revision before it can
run. Review the Source and its scripts before granting temporary or persistent
trust, and use `--allow-custom` only when the operation is intended.

## MVP limits

Version `0.1.0` is an MVP for Windows x64. It supports local and Git Sources,
File steps, File Fragment steps, Custom steps, lockfiles, optional local
Catalogs, and the `doctor`, `install`, `uninstall`, and `catalog` commands.
It does not guarantee operation on macOS, Linux, WSL, or ARM64, and it does
not provide built-in package-manager or server infrastructure integrations.

## Feedback

Report bugs and feedback at
<https://github.com/TalbyAI/tbboot/issues>.
