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

`biome check` is the code gate because the `biome.json` introduced by this
change includes `src/**` and `test/**`; newly added supported source files in
those directories are therefore included automatically. The TypeScript
configuration covers the same directories. This change also adds `build` as
the entrypoint-specific Node syntax check for `src/cli.ts`.

The old `lint`, `lint:fix`, `format:check`, and `format:md` names are removed.
Existing `test`, `doctor`, and `typecheck` commands remain unchanged.

## CI impact

The workflow must stop invoking removed script names. Its separate Markdown and
code quality steps will use `npm run check:md` and `npm run check:code`;
typecheck and test remain, and the new build step validates the entrypoint. The
old aggregate syntax step is removed because the aggregate `check` command is
now the local convenience for Markdown and code quality, while `build` and
`typecheck` provide the remaining production checks in CI.

## Verification

Verification will assert the exact six script values, run both check commands,
run both fix commands, rerun the checks, and execute the existing typecheck,
build, and test commands. The final diff will be checked for unintended files
and the workflow will be inspected for references to removed script names.

## Scope

The enclosing change adds only `@biomejs/biome` and `markdownlint-cli2` as
development dependencies, updates the lockfile, and versions their two scoped
configuration files. No source abstraction, test framework, runtime behavior,
or prototype pipeline is added. Mechanical formatting changes made by
`fix:code` or `fix:md` stay within those configured scopes.
