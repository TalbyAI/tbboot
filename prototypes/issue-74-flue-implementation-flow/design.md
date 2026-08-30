# Issue 74 Flue implementation flow prototype

> Derived from GitHub Issue #74, which remains the authoritative requirements
> record. This document records the approved local design only.

## Goal

Run one explicitly selected GitHub Issue through preflight, an isolated
implementation worktree, repository checks, independent verifier/reviewer
worktrees, human approval gates, and local PR preparation without publishing
by default.

## Design

The host script owns deterministic orchestration: it reads the Issue through
`gh`, checks the current checkout, creates Git worktrees, runs checks, waits at
HITL gates, writes reports, and owns all publication decisions. Flue supplies
the three model-driven roles through one local `start()` runtime and separate
`init()` handles. Verifier and Reviewer are different Flue agent functions
with different `local({ cwd })` sandboxes and are dispatched with `Promise.all`.

The model provider is Flue's built-in OpenRouter provider. Live agents use
`openrouter/openai/gpt-5.6-luna` with `thinkingLevel: 'xhigh'` and read
`OPENROUTER_API_KEY` through the provider environment. No API key is stored in
the prototype. `local({ cwd })` scopes the default working directory only; it
is host execution and is not a security boundary. A remote sandbox is deferred.

Fixture mode uses a temporary local Git repository, a checked-in Issue #65
fixture, and deterministic agent/check runners. It exercises the same host
transitions and worktree/concurrency checks without a model, GitHub, push, or
PR creation.

## Boundaries

- Production `src/`, `test/`, scripts, package manifests, and documentation are
  untouched.
- Runtime worktrees are temporary and outside the repository checkout; final
  reports are written under the prototype's ignored `runs/` directory.
- The host, never an agent, selects refs and paths, approves gates, commits,
  and decides whether publication is allowed.
- `useSubagent()` is deliberately not used for Verifier or Reviewer because it
  shares the parent's sandbox.
- No router, plugin registry, durable state/resume, remote sandbox, or general
  workflow registry is included.

## Observable result

Each completed local run writes `report.json`, `diff.patch`, `checks.json`,
`verifier.md`, `reviewer.md`, and `pr-body.md`. The report records the base ref,
branches, worktree paths, commit SHA when present, gate decisions, check
commands/results, agent results, and publication status.

## Error and HITL behavior

Preflight returns all applicable reasons for a closed/unlabelled/blocked Issue
or dirty checkout. A denied gate returns a stopped result and does not execute
later side effects. The default path never calls a publisher. `--publish`
requires the final gate and only permits `git push` plus `gh pr create --draft`;
approval, merge, and close operations are not implemented.

## Cost note

Fixture tests and dry-runs make no LLM requests. OpenRouter currently lists
Luna at $0.20/M input and $1.20/M output; reasoning tokens are output tokens.
The first live #65 run is expected to cost cents to low single-digit USD,
depending on context, reasoning, and retries. A small external credit limit is
recommended before live execution.
