# Issue 5 Prototype Design

## Goal

Create an isolated Windows comparison fixture that tests whether the proposed
declarative environment model provides enough value over composing `mise`,
`chezmoi`, and small integration scripts.

## Scope

The experiment lives under `prototypes/issue-5/` and is not production
architecture. It compares two runnable paths against the same fixture:

1. `composition/`: existing tools, where available, plus the smallest
   PowerShell integration needed for the scenarios they do not cover.
2. `proposed/`: a local consumer manifest, local source discovery, complete
   source installation, recipes discovered by `recipe.yaml`, ordered `file`
   and `file-fragment` steps, `doctor`, `install --dry-run`, and `install`.

The fixture uses Windows paths and only local sources. It excludes catalogs,
Git providers, recipe selection, versions, parameters, command checks,
interactive mode, packages, arbitrary scripts, and rollback.

## Architecture

The proposed path is a small Node.js program using the platform's built-in
test runner and one YAML parser dependency. Its public seam is a CLI invoked
from the prototype directory. The command reads the consumer manifest, resolves
relative local source references, discovers first-level recipe folders, builds
the complete plan, and either reports diagnostics or applies writes.

The source model is:

```text
source/
├── source.yaml
├── shared/
└── recipe-id/
    ├── recipe.yaml
    └── files/
```

Recipe input paths are relative to the recipe by default. `..` may reach
shared source files but never escape the source root. Every target is relative
to the consumer repository root.

The composition path uses `chezmoi` for complete-file application and `mise`
where it can represent the environment setup. A small PowerShell adapter owns
the comparison-only cases such as managed Markdown fragments and diagnostics.
The runner reports missing external tools as setup prerequisites instead of
silently replacing them with a fake implementation.

## Data flow and safety

`doctor` is read-only. `install --dry-run` performs the same validation and
prints the complete plan without writes. `install` performs all validation for
all sources, recipes, steps, paths, duplicate source references, target
collisions, and known conflicts before writing anything.

The fragment marker is deterministic from the source root folder name and
recipe ID. Different markers may share a target file; identical markers are a
conflict. A complete `file` target cannot be shared by another writing step.
Existing identical files and blocks are no-ops. Modified files or blocks are
reported as drift/conflicts and are not overwritten. A failed preflight makes
zero writes. Unexpected filesystem failure during the write phase is outside
the experiment's rollback scope.

## Scenarios

The fixture and runner cover:

- local `source.yaml` and recipe discovery through `recipe.yaml`;
- shared source files and recipe-local files;
- complete-file creation;
- managed Markdown fragments in `AGENTS.md`;
- read-only `doctor`;
- no-write dry-run;
- preflight before writes;
- identical existing files/blocks as no-ops;
- drift and conflicts;
- multiple distinct fragments targeting one file;
- duplicate normalized source references as errors;
- idempotent second installation.

The comparison report records setup, custom code, diagnostics, conflict and
drift behavior, and idempotence for both paths, followed by a verdict on
product differentiation versus an integration repository.

## Testing

Tests use `node:test`, `assert`, and temporary directories. They invoke the
public proposed CLI seam and inspect filesystem state and command output. The
smallest end-to-end scenario is extended one behavior at a time so failures
identify the missing user-visible rule. The comparison runner is also executed
against the checked-in fixture before the prototype is considered complete.

## Repository instruction

`AGENTS.md` will state that prototypes are isolated under
`prototypes/<prototype-name>/`, with each prototype owning its fixture,
implementation, checks, and notes in that directory.
