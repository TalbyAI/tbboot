# Quality Script Normalization Design

## Context

The current branch exposes separate `lint`, `lint:fix`, `format:check`, and
`format:md` npm scripts. The `check` script only runs explicit Node syntax
checks. This makes the local commands inconsistent and makes the Node file list
the place where code coverage is decided.

## Decision

Use the following six canonical commands in `package.json`:

```json
{
  "check:md": "markdownlint-cli2",
  "check:code": "biome check src test",
  "check": "npm run check:md && npm run check:code",
  "fix:md": "markdownlint-cli2 --fix",
  "fix:code": "biome check --write src test",
  "fix": "npm run fix:md && npm run fix:code"
}
```

`biome check` is the code gate because the existing `biome.json` includes
`src/**` and `test/**`; newly added supported source files in those directories
are therefore included automatically. The TypeScript configuration covers the
same directories. The existing `build` script remains the entrypoint-specific
Node syntax check for `src/cli.ts`.

The old `lint`, `lint:fix`, `format:check`, and `format:md` names are removed.
Existing `test`, `doctor`, `typecheck`, and `build` commands remain unchanged.

## CI impact

The workflow must stop invoking removed script names. Its separate Markdown and
code quality steps will use `npm run check:md` and `npm run check:code`; the
existing build, typecheck, and test steps remain. The old aggregate syntax step
is removed because the aggregate `check` command is now the local convenience
for Markdown and code quality, while `build` and `typecheck` provide the
remaining production checks in CI.

## Verification

Verification will assert the exact six script values, run both check commands,
run both fix commands, rerun the checks, and execute the existing typecheck,
build, and test commands. The final diff will be checked for unintended files
and the workflow will be inspected for references to removed script names.

## Scope

No new dependency, formatter configuration, source abstraction, test
framework, runtime behavior, or prototype pipeline is added. Mechanical
formatting changes made by `fix:code` or `fix:md` are limited to files already
covered by the existing quality configurations.
