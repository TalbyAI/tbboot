# Finish PR Review Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear una skill local que mantenga un Goal activo hasta resolver el pipeline y todos los comentarios de reviewers de un pull request sin aprobarlo, fusionarlo ni cerrarlo.

**Architecture:** Un único `SKILL.md` user-invoked en `.agents/skills/finish-pr-review/`. El documento define un bucle de estado sobre `gh`, el Goal de Codex y los comandos habituales del repositorio; no añade scripts ni automatización de polling.

**Tech Stack:** Markdown, YAML frontmatter, Codex Goal (`create_goal`, `get_goal`, `update_goal`), GitHub CLI (`gh`) y PowerShell/Git.

## Global Constraints

- La skill solo se inicia mediante invocación explícita del usuario.
- Se permiten commits y `push` solo sobre la rama head del pull request y para cambios creados dentro del Goal.
- El Goal solo se completa con pipeline verde, comentarios resueltos o rechazados con evidencia y confirmación de que no queda revisión pendiente.
- No aprobar, fusionar ni cerrar el pull request; no escribir en `main`.
- La skill es local al repositorio y vive en `.agents/skills/finish-pr-review/SKILL.md`.

---

### Task 1: Establish pressure scenarios before authoring

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-08-20-finish-pr-review-skill-design.md`
- No repository files created.

**Interfaces:**
- Consumes: the approved design and current repository guardrails.
- Produces: four fresh baseline observations from a subagent without the new skill.

- [ ] **Step 1: Run the baseline pressure scenarios**

Use one fresh subagent per scenario, with the repository instructions but without
`.agents/skills/finish-pr-review/SKILL.md` in the prompt. Ask each agent what it
would do next for one of these states:

1. failed pipeline plus a valid CodeRabbit comment;
2. technically incorrect reviewer comment plus pending CI;
3. pushed fix plus reviewer still pending;
4. apparently clean PR without final reviewer confirmation.

- [ ] **Step 2: Record only observed loopholes**

Capture whether the baseline agent would prematurely complete, push the wrong
branch, approve/merge/close the PR, or ignore a pending reviewer. Use those
observations to keep the final skill minimal; do not add hypothetical rules.

Completion criterion: all four scenarios have a recorded decision and any
observed premature-stop or unsafe-action pattern is named.

### Task 2: Write the local user-invoked skill

**Files:**
- Create: `.agents/skills/finish-pr-review/SKILL.md`

**Interfaces:**
- Consumes: the approved design and Task 1 observations.
- Produces: a self-contained skill with frontmatter, start gate, review loop,
  Goal lifecycle, completion predicate, and push guardrails.

- [ ] **Step 1: Add the frontmatter**

```yaml
---
name: finish-pr-review
description: Use when explicitly asked to finish the current pull request without approving, merging, or closing it, especially when CI failures or CodeRabbit/reviewer comments remain.
disable-model-invocation: true
---
```

- [ ] **Step 2: Add the operational contract**

The body must state, in this order:

1. the target: leave the current PR ready for closure/merge without performing
   approval, merge, or close;
2. the start gate: identify the open PR and its head branch, confirm the
   current branch is that head branch and is not `main`, and create one Goal
   using `create_goal`;
3. the loop: inspect PR comments/review threads and required checks with `gh`,
   fix pipeline failures and valid comments, answer rejected comments with
   evidence, run relevant checks, commit scoped changes, push only the PR head,
   then re-read CI and reviewer state;
4. the wait rule: pending checks or a review expected after a push keep the Goal
   active;
5. the completion predicate: all required checks green, every actionable
   comment corrected or rejected with a documented evidence-based response, and
   reviewers/CodeRabbit indicate no further review is pending;
6. the Goal close operation: call `update_goal({ status: "complete" })` only
   after the full predicate is true.

- [ ] **Step 3: Add the safety rules and one concise example**

State the positive target and the hard guards: use `gh` for PR state, preserve
unrelated work, never use `gh pr approve`, `gh pr merge`, or `gh pr close`, and
never push to `main` or another branch. Include one short example showing that a
green pipeline alone is insufficient while a reviewer is still pending.

Completion criterion: the file has only the one skill, no helper script, no
external dependency, and contains every design requirement exactly once.

### Task 3: Verify the skill contract

**Files:**
- Read: `.agents/skills/finish-pr-review/SKILL.md`
- No additional repository files.

**Interfaces:**
- Consumes: the skill from Task 2.
- Produces: command evidence for frontmatter, required safeguards, and document
  hygiene.

- [ ] **Step 1: Run a static contract check**

Run a PowerShell assertion script that reads the file and fails unless these
strings are present: `name: finish-pr-review`,
`disable-model-invocation: true`, `create_goal`, `get_goal`, `update_goal`,
`gh pr approve`, `gh pr merge`, `gh pr close`, `main`, `CodeRabbit`, `pending`,
and `status: "complete"`.

- [ ] **Step 2: Check format and scope**

Run `git diff --check`, inspect `git diff --stat`, and confirm only the new
skill path is uncommitted. Check that the frontmatter contains only the valid
skill name characters and that the description starts with `Use when...`.

Completion criterion: the static assertions pass and the diff contains no
unrelated file or formatting error.

### Task 4: Re-run pressure scenarios and commit

**Files:**
- Read: `.agents/skills/finish-pr-review/SKILL.md`
- Commit: `.agents/skills/finish-pr-review/SKILL.md`

**Interfaces:**
- Consumes: the verified skill and the same four scenarios from Task 1.
- Produces: compliance observations and one local commit; no remote push.

- [ ] **Step 1: Run the same four scenarios with the skill loaded**

Require the agent to decide the next action for the same four states. Confirm
that it keeps the Goal active for pending CI, missing post-push review, and
missing final reviewer confirmation; confirm that it reserves completion for
the full predicate.

- [ ] **Step 2: Review for new rationalizations**

If an agent treats silence as reviewer completion, treats a green pipeline as
sufficient, or proposes an unsafe PR action, edit the skill to state the
missing observable condition and repeat the static check plus the affected
scenario.

- [ ] **Step 3: Commit the skill**

```powershell
git add -- .agents/skills/finish-pr-review/SKILL.md
git commit -m "feat: add finish PR review skill"
```

Completion criterion: the four scenarios comply with the completion predicate
and guardrails, the static checks still pass, and the skill commit exists on
`task/finish-pr-review-skill` without a `push`.
