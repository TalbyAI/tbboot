# Quality Script Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Normalize the repository's local quality scripts and update CI to call the canonical commands from the design.

**Architecture:** The enclosing change introduces Biome, Markdownlint, their scoped configurations, a lockfile update, and the `build` command. Normalize the npm script names and CI references without changing production code.

**Tech Stack:** Node.js 24, npm, Biome, markdownlint-cli2, GitHub Actions.

## Global Constraints

- `package.json` must expose the exact six canonical quality commands from the design.
- Remove `lint`, `lint:fix`, `format:check`, and `format:md`.
- Keep `test`, `doctor`, and `typecheck` unchanged; retain the new `build` command as `node --check src/cli.ts`.
- CI uses `check:md` and `check:code` as separate steps and removes the old aggregate syntax step.
- Add only `@biomejs/biome` and `markdownlint-cli2` as development dependencies and their scoped configurations; do not add runtime behavior, build artifacts, or prototype pipeline coverage.

---

### Task 1: Normalize local scripts and CI commands

**Files:**

- Modify: `package.json` — replace the old quality script block with the six canonical commands.
- Modify: `.github/workflows/ci.yml` — update the Markdown/code steps and remove the obsolete syntax step.
- Test: none; this is configuration-only. Verification uses exact-value assertions and the existing project commands.

**Interfaces:**

- Produces the npm commands consumed by the CI workflow and local developers.

- [ ] **Step 1: Capture the exact expected script values**

Expected `package.json` entries:

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

- [ ] **Step 2: Update `package.json`**

Replace the existing quality scripts with the six entries above. Leave `test`, `doctor`, and `typecheck` byte-for-byte unchanged, and retain `build` as `node --check src/cli.ts`.

- [ ] **Step 3: Update `.github/workflows/ci.yml`**

Use `npm run check:md` before `npm run check:code`, remove the separate `npm run check` syntax step, and retain the typecheck, new build, and test steps.

- [ ] **Step 4: Assert the script contract**

Run:

```powershell
node -e "const p=require('./package.json'); const expected={ 'check:md':'markdownlint-cli2', 'check:code':'biome check src test', check:'npm run check:md && npm run check:code', 'fix:md':'markdownlint-cli2 --fix', 'fix:code':'biome check --write src test', fix:'npm run fix:md && npm run fix:code' }; for (const [k,v] of Object.entries(expected)) if (p.scripts[k] !== v) throw new Error(k + ': ' + p.scripts[k]); for (const k of ['lint','lint:fix','format:check','format:md']) if (k in p.scripts) throw new Error('removed script remains: ' + k);"
```

Expected: exit code 0.

- [ ] **Step 5: Run all verification commands**

Run `npm run check:md`, `npm run check:code`, `npm run fix:md`, `npm run fix:code`, then rerun both check commands, followed by `npm run typecheck`, `npm run build`, and `npm test`. Inspect the final diff and confirm no removed script names remain in `.github/workflows/ci.yml`.

- [ ] **Step 6: Commit**

```powershell
git add package.json .github/workflows/ci.yml
git commit -m "ci: normalize quality scripts"
```
