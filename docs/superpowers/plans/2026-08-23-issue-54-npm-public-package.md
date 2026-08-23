# npm Public Package for Issue #54 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare `@talby/tbboot@0.1.0` for a manual public npm release with an exact tarball allowlist and CI packaging validation.

**Architecture:** Keep npm metadata in `package.json`, documentation in the root `README.md` and `LICENSE`, and package inspection in one dependency-free Node script. The CI job runs that script once on the canonical Windows/Node matrix combination and never publishes.

**Tech Stack:** npm package metadata, Node.js 24 native ESM, PowerShell GitHub Actions, existing TypeScript CLI and npm lockfile.

## Global Constraints

- Public package name: `@talby/tbboot`.
- Initial version: `0.1.0`.
- Node.js: `>=24.12 <25`.
- Guaranteed platform: Windows x64 only.
- Package contents: `package.json`, `src/**`, `schemas/contract-v1.json`, `README.md`, `LICENSE`.
- No `preinstall`, `install`, `postinstall`, publish workflow, token, trusted publishing, or staged publishing.
- Publish access: `public`; publication remains interactive and manual.
- Do not change the functional MVP contract from Issue #8.

---

### Task 1: Make the root package publicly distributable

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `README.md`
- Create: `LICENSE`

**Interfaces:**
- npm consumes the metadata and `files` allowlist from `package.json`.
- Consumers use the documented `tbboot` binary and the existing CLI commands.

- [ ] **Step 1: Write the failing packaging expectation**

Use the package metadata required by the issue as the expectation:

```json
{
  "name": "@talby/tbboot",
  "version": "0.1.0",
  "license": "MIT",
  "files": ["src", "schemas/contract-v1.json", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

Before the edit, `package.json` fails this expectation because it is private,
has the unscoped name, and lacks the public metadata and allowlist.

- [ ] **Step 2: Run the baseline check to verify it fails**

Run: `node -e "const p=require('./package.json'); if (p.name === '@talby/tbboot' && p.private !== true && p.files && p.publishConfig?.access === 'public') process.exit(0); process.exit(1)"`

Expected: exit code `1`.

- [ ] **Step 3: Update package metadata and public documentation**

Keep the existing scripts, dependencies, `bin`, and engine range. Change the
package metadata to include:

```json
{
  "name": "@talby/tbboot",
  "version": "0.1.0",
  "description": "Declarative environment bootstrap CLI for Windows repositories.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/TalbyAI/tbboot.git"
  },
  "homepage": "https://github.com/TalbyAI/tbboot#readme",
  "bugs": { "url": "https://github.com/TalbyAI/tbboot/issues" },
  "keywords": ["cli", "bootstrap", "repository", "repositories", "windows"],
  "files": ["src", "schemas/contract-v1.json", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

Remove `private` and add `"check:pack": "node scripts/check-pack.mjs"` to the
existing scripts. Create `README.md` with sections for global/local/`npx`
installation, Node/npm and Windows x64 prerequisites, Consumer repository
usage, `doctor`, `install --dry-run`, `install`, `uninstall`, and `catalog`.
Document that Custom steps execute explicitly authorized code in the selected
runtime and can change the Consumer repository; document the MVP platform and
runtime limits and link feedback to
`https://github.com/TalbyAI/tbboot/issues`. Create `LICENSE` with the standard
MIT license text for TalbyAI and 2026.

- [ ] **Step 4: Synchronize the lockfile**

Run: `npm install --package-lock-only --ignore-scripts`

Expected: `package-lock.json` records `@talby/tbboot`, version `0.1.0`, and
the new package metadata without changing dependency versions.

- [ ] **Step 5: Run the metadata check to verify it passes**

Run: `node -e "const p=require('./package.json'); if (p.name !== '@talby/tbboot' || p.private === true || p.license !== 'MIT' || p.publishConfig?.access !== 'public' || JSON.stringify(p.files) !== JSON.stringify(['src','schemas/contract-v1.json','README.md','LICENSE'])) process.exit(1)"`

Expected: exit code `0`.

- [ ] **Step 6: Commit the distributable package metadata**

```text
git add package.json package-lock.json README.md LICENSE
git commit -m "feat: prepare public npm package metadata"
```

### Task 2: Validate the exact tarball and wire it into CI

**Files:**
- Create: `scripts/check-pack.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `npm run check:pack` exits `0` only when `npm pack --dry-run --json` contains
  exactly the required package files.
- CI invokes `npm run check:pack` on Windows x64 with Node `24.12.x` and
  PowerShell `7.6.0`; it does not publish.

- [ ] **Step 1: Write the failing packaging check**

Create `scripts/check-pack.mjs` with this complete behavior:

```js
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else files.push(relative(root, join(root, path)).replaceAll("\\", "/"));
  }
  return files;
}

const expected = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "schemas/contract-v1.json",
  ...sourceFiles("src"),
]);
const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || `npm pack failed with ${result.status}\n`);
  process.exit(1);
}

let actual;
try {
  const report = JSON.parse(result.stdout);
  actual = new Set(report[0]?.files?.map(({ path }) => path) ?? []);
} catch (error) {
  process.stderr.write(`Could not parse npm pack output: ${error}\n`);
  process.exit(1);
}

const missing = [...expected].filter((path) => !actual.has(path)).sort();
const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
if (missing.length > 0 || unexpected.length > 0) {
  if (missing.length > 0) console.error(`Missing: ${missing.join(", ")}`);
  if (unexpected.length > 0)
    console.error(`Unexpected: ${unexpected.join(", ")}`);
  process.exit(1);
}

console.log(`Package contains ${actual.size} expected files.`);
```

Run: `npm run check:pack`

Expected before Task 1's allowlist/documentation is present: FAIL, because the
required public files and package metadata are not yet in the tarball.

- [ ] **Step 2: Run the check after Task 1 to verify it passes**

Run: `npm run check:pack`

Expected: PASS with `Package contains ... expected files.` and no unexpected
files.

- [ ] **Step 3: Add the CI packaging check**

Add this step after `Build CLI entrypoint` and before the test steps in
`.github/workflows/ci.yml`:

```yaml
      - name: Check npm package contents
        if: matrix.node-version == '24.12.x' && matrix.pwsh-version == '7.6.0'
        run: npm run check:pack
```

This reuses the canonical Windows x64/Node 24.12/PowerShell 7.6 job and does
not call `npm publish`.

- [ ] **Step 4: Commit the packaging check**

```text
git add scripts/check-pack.mjs .github/workflows/ci.yml
git commit -m "ci: verify npm package contents"
```

### Task 3: Run the complete verification and prepare handoff

**Files:**
- Verify: `package.json`, `package-lock.json`, `README.md`, `LICENSE`, `scripts/check-pack.mjs`, `.github/workflows/ci.yml`

- [ ] **Step 1: Run focused checks**

```text
npm run check:pack
npm run typecheck
npm run build
npm run check:md -- README.md
npm run check:code
```

Expected: each command exits `0`.

- [ ] **Step 2: Inspect the dry-run tarball contents**

Run: `npm pack --dry-run --json`

Expected: only `package.json`, every file under `src/`,
`schemas/contract-v1.json`, `README.md`, and `LICENSE` are listed; no test,
prototype, workflow, ADR, plan, context, or secret file is listed.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: the existing suite passes with zero failures.

- [ ] **Step 4: Review the diff against `main`**

Run: `git diff main...HEAD --check; git diff main...HEAD; git status --short`

Expected: only Issue #54's package metadata, public docs, package check, CI
step, and derived design/plan documents are changed; the worktree is clean
after commits.

- [ ] **Step 5: Commit any final correction and report manual release steps**

If verification finds a correction, run the focused check that failed, update
the affected file, and commit it with a message scoped to Issue #54. Do not
publish to npm, create `v0.1.0`, configure 2FA, or push without an explicit
request.
