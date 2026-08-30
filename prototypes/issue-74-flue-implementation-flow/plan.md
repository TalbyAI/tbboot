# Issue 74 Flue implementation flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated local Flue prototype that takes a ready GitHub Issue to a reviewed, locally prepared result without publishing by default.

**Architecture:** A small Node/TypeScript host owns GitHub/Git/HITL/check/report/publication decisions. Flue supplies Implementer, Verifier, and Reviewer agents through `start()`/`init()`; fixture mode injects deterministic runners while preserving the host flow. Review agents receive separate Git worktrees and run concurrently.

**Tech Stack:** Node.js 24, TypeScript native stripping, `@flue/runtime` 2.x, Node built-in test runner, Git CLI, GitHub CLI, OpenRouter.

## Global Constraints

- Keep every checked-in file under `prototypes/issue-74-flue-implementation-flow/`.
- Do not modify production tbboot code or production scripts.
- Use `openrouter/openai/gpt-5.6-luna` with `thinkingLevel: 'xhigh'` for live agents.
- Use `start()`/`init()` for local Flue orchestration.
- Use `local({ cwd })` only as a development sandbox and document that it is not a security boundary.
- Use separate agents and worktrees for Verifier and Reviewer; do not use `useSubagent()` to simulate worktrees.
- Default execution must not push or create a PR.
- Fixture/dry-run must not call a model or GitHub.

---

### Task 1: Prototype package, fixture, and local skill

**Files:**
- Create: `prototypes/issue-74-flue-implementation-flow/package.json`
- Create: `prototypes/issue-74-flue-implementation-flow/.gitignore`
- Create: `prototypes/issue-74-flue-implementation-flow/fixture/issue-65.json`
- Create: `prototypes/issue-74-flue-implementation-flow/src/skills/issue-flow/SKILL.md`
- Create: `prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts`

**Interfaces:**
- Produces a runnable package with `npm test`, `npm run check`, and `npm run implement -- --fixture --dry-run`.
- The fixture Issue object has `number`, `state`, `title`, `body`, `labels`, `blockedBy`, and `url`.

- [ ] **Step 1: Write the failing package/fixture test**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the checked-in fixture describes the ready Issue 65 scenario", async () => {
  const issue = JSON.parse(await readFile(new URL("../fixture/issue-65.json", import.meta.url), "utf8"));
  assert.equal(issue.number, 65);
  assert.equal(issue.state, "OPEN");
  assert.ok(issue.labels.includes("ready-for-agent"));
  assert.deepEqual(issue.blockedBy, []);
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/prototype.test.ts`

Expected: FAIL because the fixture and package files do not exist.

- [ ] **Step 3: Add the minimal package and fixture**

```json
{
  "name": "tbboot-issue-74-flue-implementation-flow",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/**/*.test.ts",
    "check": "node --check src/cli.ts && node --check src/workflow.ts"
  },
  "dependencies": {
    "@flue/runtime": "^2.0.3"
  }
}
```

```json
{
  "number": 65,
  "state": "OPEN",
  "title": "Built-ins mediante el registro sin regresión del MVP",
  "body": "Los built-ins File, File Fragment y Custom se registran como definiciones estáticas.",
  "labels": ["ready-for-agent"],
  "blockedBy": [],
  "url": "https://github.com/TalbyAI/tbboot/issues/65"
}
```

Add `.gitignore` containing `runs/` and a local skill with valid frontmatter
and instructions that tell an agent to read `AGENTS.md`, obey the Issue, keep
changes in its assigned worktree, and run the requested checks.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- --test-name-pattern "checked-in fixture"`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add prototypes/issue-74-flue-implementation-flow
git commit -m "feat: scaffold issue 74 flue prototype"
```

### Task 2: Deterministic preflight and worktree lifecycle

**Files:**
- Create: `prototypes/issue-74-flue-implementation-flow/src/types.ts`
- Create: `prototypes/issue-74-flue-implementation-flow/src/git.ts`
- Create: `prototypes/issue-74-flue-implementation-flow/src/preflight.ts`
- Modify: `prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts`

**Interfaces:**
- `preflight(input: { issue: Issue; status: string; baseRef: string }): PreflightResult` returns `{ ok: true }` or `{ ok: false, reasons: string[] }`.
- `GitHost` exposes `worktreeAdd`, `status`, `currentRef`, `commit`, `diff`, and `worktreeRemove` using argument arrays.
- `createWorktree(git, { baseRef, branch, path }): Promise<Worktree>` creates a branch from the exact base ref without changing the current checkout.

- [ ] **Step 1: Write failing preflight and worktree tests**

```ts
test("preflight reports every blocking reason", () => {
  const result = preflight({
    issue: { number: 1, state: "CLOSED", labels: [], blockedBy: [{ number: 2, state: "OPEN" }] },
    status: " M src/file.ts",
    baseRef: "abc123",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [
    "Issue is CLOSED",
    "Issue lacks ready-for-agent",
    "Issue has 1 open blocker",
    "base checkout is dirty",
  ]);
});

test("worktree creation uses the known base ref and leaves the current ref unchanged", async () => {
  const calls: string[][] = [];
  const git = { run: async (args: string[]) => { calls.push(args); return { stdout: "", exitCode: 0 }; } };
  const worktree = await createWorktree(git, { baseRef: "abc123", branch: "issue/65-run", path: "C:/temp/run" });
  assert.equal(worktree.branch, "issue/65-run");
  assert.deepEqual(calls[0], ["worktree", "add", "-b", "issue/65-run", "C:/temp/run", "abc123"]);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `npm test -- --test-name-pattern "preflight|worktree creation"`

Expected: FAIL because the public functions are not defined.

- [ ] **Step 3: Implement only the validation and Git argument calls**

```ts
export function preflight(input: PreflightInput): PreflightResult {
  const reasons: string[] = [];
  if (input.issue.state !== "OPEN") reasons.push(`Issue is ${input.issue.state}`);
  if (!input.issue.labels.includes("ready-for-agent")) reasons.push("Issue lacks ready-for-agent");
  const openBlockers = input.issue.blockedBy.filter((item) => item.state === "OPEN");
  if (openBlockers.length) reasons.push(`Issue has ${openBlockers.length} open blocker${openBlockers.length === 1 ? "" : "s"}`);
  if (input.status.trim()) reasons.push("base checkout is dirty");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
```

- [ ] **Step 4: Run the focused tests to verify pass**

Run: `npm test -- --test-name-pattern "preflight|worktree creation"`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add prototypes/issue-74-flue-implementation-flow/src prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts
git commit -m "feat: add issue 74 preflight and worktrees"
```

### Task 3: Host workflow, gates, checks, reports, and publication policy

**Files:**
- Create: `prototypes/issue-74-flue-implementation-flow/src/workflow.ts`
- Create: `prototypes/issue-74-flue-implementation-flow/src/report.ts`
- Modify: `prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts`

**Interfaces:**
- `runWorkflow(options: WorkflowOptions): Promise<WorkflowResult>` performs preflight through local report generation.
- `WorkflowOptions` accepts an Issue, Git host, agent runner, check runner, approval callback, output directory, and `publish` flag.
- `approve(gate: "worktree" | "commit" | "publish", details): Promise<boolean>` is the only HITL seam.
- `WorkflowResult` includes `status`, `stoppedAt`, `branch`, `commitSha`, `worktrees`, `checks`, `reviews`, and `publication`.

- [ ] **Step 1: Write failing gate, concurrency, and publication tests**

Use this test-only helper so every scenario exercises the same ready Issue and
fake Git/check boundaries:

```ts
function fixtureOptions(overrides: Partial<WorkflowOptions> = {}): WorkflowOptions {
  return {
    issue: readyIssue65,
    baseRef: "base-sha",
    baseStatus: "",
    git: fixtureGit,
    agent: async ({ role, cwd }) => ({ role, cwd, text: "ok", changedPaths: [] }),
    checks: async () => [{ command: "node check.mjs", exitCode: 0, stdout: "ok", stderr: "" }],
    approve: async () => true,
    outputDir: temporaryOutputDirectory,
    publish: false,
    ...overrides,
  };
}
```

`readyIssue65`, `fixtureGit`, and `temporaryOutputDirectory` are test values
declared at the top of `prototype.test.ts`; they are not production APIs.

```ts
test("denying the commit gate prevents commit and publication", async () => {
  const events: string[] = [];
  const result = await runWorkflow(fixtureOptions({
    approve: async (gate) => { events.push(`gate:${gate}`); return gate !== "commit"; },
    commit: async () => { events.push("commit"); return "sha"; },
    publish: async () => { events.push("publish"); },
  }));
  assert.equal(result.status, "stopped");
  assert.equal(result.stoppedAt, "commit");
  assert.deepEqual(events, ["gate:worktree", "gate:commit"]);
});

test("verifier and reviewer run concurrently in distinct worktrees", async () => {
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await runWorkflow(fixtureOptions({
    agent: async ({ role, cwd }) => {
      started.push(`${role}:${cwd}`); active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1;
      return { role, text: "ok", changedPaths: [] };
    },
  }));
  assert.equal(result.status, "ready-for-review");
  assert.equal(peak, 2);
  assert.notEqual(started.find((value) => value.startsWith("verifier:")), started.find((value) => value.startsWith("reviewer:")));
});

test("default execution never calls the publisher", async () => {
  let published = false;
  const result = await runWorkflow(fixtureOptions({ publish: async () => { published = true; } }));
  assert.equal(result.publication.status, "disabled");
  assert.equal(published, false);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `npm test -- --test-name-pattern "commit gate|concurrently|publisher"`

Expected: FAIL because `runWorkflow` is not defined.

- [ ] **Step 3: Implement the linear host flow with one `Promise.all` fan-out**

The implementation must call the worktree gate before creating the
Implementer worktree, the commit gate before `git commit`, and the publish gate
only when `publish === true`. It must snapshot review worktrees before/after
the agent calls and mark a review failed if the agent changed files. It must
write report artifacts through the report module and make the no-publish path
explicit in the result.

- [ ] **Step 4: Run the focused tests to verify pass**

Run: `npm test -- --test-name-pattern "commit gate|concurrently|publisher"`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add prototypes/issue-74-flue-implementation-flow/src/workflow.ts prototypes/issue-74-flue-implementation-flow/src/report.ts prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts
git commit -m "feat: orchestrate issue 74 host workflow"
```

### Task 4: Flue agents and CLI modes

**Files:**
- Create: `prototypes/issue-74-flue-implementation-flow/src/agents.ts`
- Create: `prototypes/issue-74-flue-implementation-flow/src/cli.ts`
- Modify: `prototypes/issue-74-flue-implementation-flow/src/workflow.ts`
- Modify: `prototypes/issue-74-flue-implementation-flow/package.json`
- Modify: `prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts`

**Interfaces:**
- `runLiveAgents(context): Promise<AgentRun[]>` starts one Flue runtime with three independent agent functions and dispatches them with `init()`.
- `createRoleAgent(role, cwd): Agent` calls `useModel("openrouter/openai/gpt-5.6-luna", { thinkingLevel: "xhigh" })`, `useSandbox(local({ cwd }))`, and the local `useSkill` reference.
- CLI supports `--issue <number>`, `--fixture`, `--dry-run`, and `--publish`.

- [ ] **Step 1: Write failing source-contract and CLI tests**

```ts
test("live agent source uses OpenRouter Luna xhigh and local cwd", async () => {
  const source = await readFile(new URL("../src/agents.ts", import.meta.url), "utf8");
  assert.match(source, /openrouter\/openai\/gpt-5\.6-luna/);
  assert.match(source, /thinkingLevel:\s*["']xhigh["']/);
  assert.match(source, /local\(\{ cwd \}\)/);
  assert.doesNotMatch(source, /useSubagent\(/);
});

test("fixture dry-run does not require provider credentials", async () => {
  const result = await runCli(["--fixture", "--dry-run"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ready-for-review/);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `npm test -- --test-name-pattern "OpenRouter|fixture dry-run"`

Expected: FAIL because the live agents and CLI are not defined.

- [ ] **Step 3: Implement the Flue bridge and CLI**

```ts
function createRoleAgent(role: Role, cwd: string) {
  function RoleAgent() {
    useModel("openrouter/openai/gpt-5.6-luna", { thinkingLevel: "xhigh" });
    useSandbox(local({ cwd }));
    useSkill(issueFlowSkill);
    return roleInstructions(role);
  }
  return RoleAgent;
}
```

Use `await using flue = await start({ agents: [...] })`, then `init(agent,
{ id })`, `dispatch(prompt)`, and `read(receipt)`. Fixture mode uses the
deterministic runner and never imports a provider credential or dispatches a
model request. Live mode reads the Issue and dependency state with `gh` and
uses interactive readline approval gates.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `npm test -- --test-name-pattern "OpenRouter|fixture dry-run"`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add prototypes/issue-74-flue-implementation-flow
git commit -m "feat: add flue agents and fixture cli"
```

### Task 5: README, full checks, and manual run instructions

**Files:**
- Create: `prototypes/issue-74-flue-implementation-flow/README.md`
- Modify: `prototypes/issue-74-flue-implementation-flow/package.json`
- Modify: `prototypes/issue-74-flue-implementation-flow/test/prototype.test.ts`

**Interfaces:**
- README documents install, fixture/dry-run, live #65, `OPENROUTER_API_KEY`,
  `local()` security boundary, deferred remote sandbox, artifact paths, cost
  expectations, and the no-publish default.

- [ ] **Step 1: Write failing documentation/acceptance test**

```ts
test("README documents the required safety and execution boundaries", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const term of ["OPENROUTER_API_KEY", "xhigh", "local()", "not a security", "--fixture", "--dry-run", "--issue 65", "--publish"]) {
    assert.match(readme, new RegExp(term.replace(/[()]/g, "\\$&")));
  }
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run: `npm test -- --test-name-pattern "README"`

Expected: FAIL because README.md is not present.

- [ ] **Step 3: Add the concise README and package check scripts**

Document these commands:

```powershell
Set-Location prototypes/issue-74-flue-implementation-flow
npm install
npm test
npm run check
npm run implement -- --fixture --dry-run
$env:OPENROUTER_API_KEY = "..."
npm run implement -- --issue 65
```

State that live execution creates temporary worktrees and may modify only
those worktrees, that `local({ cwd })` is not a security sandbox, and that the
default keeps all publication disabled. State that OpenRouter credits are
separate from a ChatGPT/Codex subscription.

- [ ] **Step 4: Run all prototype checks**

Run: `npm test`, `npm run check`, and `npm run implement -- --fixture --dry-run`.

Expected: all commands exit 0; fixture run reports `ready-for-review` and
creates no GitHub or publication call.

- [ ] **Step 5: Commit**

```powershell
git add prototypes/issue-74-flue-implementation-flow
git commit -m "docs: explain issue 74 flue prototype"
```

### Task 6: Final verification and optional manual Issue #65

**Files:**
- Modify only files under `prototypes/issue-74-flue-implementation-flow/` if a check exposes a defect.

- [ ] **Step 1: Re-read Issue #74 and make an acceptance checklist**
- [ ] **Step 2: Run the complete prototype test/check commands freshly**
- [ ] **Step 3: Run the live #65 command only if `OPENROUTER_API_KEY` is explicitly available and the user has approved spending API credits**
- [ ] **Step 4: Verify the root production tree has no changed files and the prototype worktree is clean except committed changes**
- [ ] **Step 5: Record pass/fail status, decisions, limitations, and deferred work in the final handoff**
