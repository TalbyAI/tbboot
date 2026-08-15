# Issue 10 Git Source Selector Prototype

## Goal

Demonstrate, in an isolated prototype, that the Git Source provider can resolve exact refs and inclusive ancestry ranges, intersect selectors, and report ambiguous or incompatible results as required by ADR-0008.

## Scope

The prototype lives entirely under `prototypes/issue-10/`. It operates on a local Git repository path and exposes two JavaScript functions:

```js
resolveSelector(repoPath, selector)
intersectSelectors(repoPath, selectors)
```

Both functions return a resolved commit revision when one result exists and throw a typed `GitSelectorError` with a stable diagnostic code when resolution is impossible.

The prototype supports:

- exact `selector.ref` values for tags and branches;
- fully qualified `refs/tags/...` and `refs/heads/...` names;
- short names when they identify exactly one tag or branch;
- ambiguity diagnostics when a short name identifies both a tag and a branch;
- bounded `{ from, to }` ranges, including equal bounds;
- ancestry-based range membership rather than commit timestamps;
- selector intersections with empty and multiple-incomparable-maxima outcomes.

The candidate set for a range is the set of unique commit revisions pointed to by local `refs/heads/*` and `refs/tags/*` refs that are descendants of `from` and ancestors of `to`, inclusive. This makes the prototype exercise real Git topology while keeping the candidate universe deterministic and observable. If several candidates remain, a candidate is maximal when no other candidate is its descendant. One maximal candidate resolves successfully; several incomparable maxima produce a conflict.

## Non-goals

- No remote fetch, network access, Git provider integration, lockfile, YAML parsing, or product CLI.
- No support for unbounded ranges, arbitrary ref namespaces, commit timestamps, or a common version language.
- No production code changes outside the isolated prototype directory.

## Resolution rules

1. An exact short name checks `refs/tags/<name>` and `refs/heads/<name>`. Zero matches is `git-ref-not-found`; two matches is `git-ref-ambiguous`; one match resolves its peeled commit.
2. A fully qualified tag or branch ref is checked in that namespace only. Missing refs produce `git-ref-not-found`.
3. A range resolves both bounds using the same ref rules. If `from` is not an ancestor of `to`, including neither bound nor any intervening commit, it produces `git-range-invalid`.
4. A valid range includes both bounds. Equal bounds therefore produce exactly one candidate when that revision is represented by a local tag or branch ref.
5. Intersections compare commit object IDs, not ref names. A selector intersection with no common candidates produces `git-selector-incompatible`.
6. The maximal-candidate calculation uses `git merge-base --is-ancestor`. Several maximal revisions that are not ancestors of one another produce `git-selector-ambiguous` and include the candidate revisions in the error details.

## Error contract

```js
class GitSelectorError extends Error {
  code;       // one of the stable codes above
  details;    // plain serializable data useful to the test and caller
}
```

The error message is human-readable, while `code` is the stable assertion seam. Git commands receive argument arrays through `execFileSync`; selector values are never interpolated into a shell command.

## Fixture and verification design

Tests create temporary local repositories with `git init`, configure a local identity, make deterministic commits, and add branches/tags. The fixture contains:

- a linear chain for inclusive lower/upper bounds and equal bounds;
- a tag/branch short-name collision;
- two divergent branch tips for incomparable maxima;
- a range whose candidate sets do not intersect.

The tests use Node's built-in `node:test` and `node:assert/strict`. `npm test` runs the complete suite; `npm run check` runs `node --check` on the implementation and tests. No third-party dependency is required.

## File responsibilities

- `prototypes/issue-10/proposed/git-source.mjs`: Git command wrapper, ref normalization, range candidate enumeration, intersection, and typed diagnostics.
- `prototypes/issue-10/test/fixture.mjs`: deterministic temporary Git repository builder used only by tests.
- `prototypes/issue-10/test/prototype.test.mjs`: focused acceptance tests for exact refs, ranges, and intersections.
- `prototypes/issue-10/package.json`: Node package metadata and check/test scripts.
- `prototypes/issue-10/README.md`: purpose, supported semantics, and reproducible commands.
