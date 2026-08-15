# Issue 10 Git Source selector prototype

This throwaway prototype exercises the Git Source provider against temporary
local repositories. It resolves exact tags and branches, fully qualified
`refs/tags/...` and `refs/heads/...` names, bounded inclusive ancestry ranges,
and intersections of selectors.

Short names that match both a tag and a branch report `git-ref-ambiguous`.
Missing refs report `git-ref-not-found`. A lower range bound that is not an
ancestor of its upper bound reports `git-range-invalid`. Empty intersections
report `git-selector-incompatible`; multiple incomparable maximal revisions
report `git-selector-ambiguous`.

The tests create deterministic local Git fixture repositories with branches,
tags, divergent history, and merge commits. They do not access a remote.

## Run

```powershell
Set-Location prototypes/issue-10
npm run check
npm test
```

This prototype does not implement remote fetching, lockfiles, YAML parsing, or
the product CLI.
