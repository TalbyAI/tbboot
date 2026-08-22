# Issue #20: case-insensitive Git identities in Catalogs

## Source

GitHub Issue #20 and the approved design in that issue. The change is limited
to duplicate Source identity detection while reading a Catalog.

## Problem

`catalog add` accepts two Git entries that resolve to the same Windows path
with different casing, such as `./Repo` and `./repo`. `sourceIdentity` already
uses `pathKey` for local Sources, but the Git branch preserves the casing of
the normalized repository and path components.

The minimal repro on Windows currently returns `exitCode: 0`, marks the
Catalog as changed, and emits no diagnostic instead of
`catalog-entry-duplicate-source`.

## Design

Keep identity construction in `src/catalog.ts` and reuse the existing
`pathKey` helper. For Git identities:

- case-normalize a resolved repository only when it is a local filesystem
  path; preserve remote repository URLs;
- case-normalize the normalized Git path component;
- retain the existing provider/locator identity shape and selector exclusion;
- leave the original Catalog reference unchanged for `info` and search output.

On Windows, these keys compare case-insensitively. On other platforms,
`pathKey` preserves the existing case-sensitive behavior.

## Alternatives rejected

- Lowercase the complete Git identity, which would also change remote URL
  identity semantics.
- Change `normalizeGitPath` globally, which would affect installation and
  doctor flows outside Catalog duplicate detection.

## Verification

Add a Catalog end-to-end regression test that exercises the real `catalog add`
seam and asserts `catalog-entry-duplicate-source` for case variants. Cover
both a Git path within a remote repository and a relative local Git repository,
and assert that the registry is not written after rejection. Run the existing
typecheck, lint, build, and full test commands.

## Out of scope

No change to Catalog schemas, CLI commands, remote access, selector handling,
Source materialization, or automatic Issue #20 closure.
