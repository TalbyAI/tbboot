# Issue 9 YAML Schemas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated prototype that validates all seven MVP YAML document kinds and returns stable parse, version, structural, and reserved-feature diagnostics without writing files.

**Architecture:** Keep one closed JSON Schema contract and seven addressable document schemas in `prototypes/issue-9/`. A single synchronous ESM function parses exactly one YAML 1.2 document, checks `schemaVersion` before selecting the caller-supplied schema, runs Ajv in strict/all-errors mode, then applies the two reserved-feature rules and normalizes every failure into the shared diagnostic envelope. Direct `provider` and `type` unions use Ajv discriminators; lock, trust, and effect rules that depend on nested `source.provider` use draft-07 conditionals.

**Tech Stack:** Node.js `>=24.12 <25` ESM, `node:test`, `yaml` 2.x, Ajv 8.x, JSON Schema draft 7.

## Global Constraints

- All prototype files live under `prototypes/issue-9/`; do not import from or modify `prototypes/issue-5/`.
- The prototype-local `.gitignore` contains only `node_modules/`; do not change the root `.gitignore`.
- Every supported document declares `schemaVersion: 1`; missing and unsupported versions are rejected before document-schema validation.
- Parse exactly one non-empty YAML 1.2 document and reject syntax errors, duplicate keys, empty input, and multiple documents.
- The caller explicitly supplies one of `manifest`, `source`, `recipe`, `catalog`, `lockfile`, `state`, or `trust`; never infer it from a filename or document content.
- Compile the single schema contract with Ajv `strict: true`, `allErrors: true`, and `discriminator: true`; every object, including nested provider locators, selectors, Steps, operations, effects, and requirements, is closed to unknown fields.
- `recipes` and `requires` are structurally recognized only in their specified containing documents; unsupported well-formed values are semantic errors after structural validation.
- Validation is read-only. Do not resolve Git refs, calculate plans or fingerprints, execute Custom operations, detect drift, uninstall, control processes, or mutate lock/state/trust files.
- Enforce path rules that are decidable from one document: Git locator paths and Step targets are relative, contain no `..` segment, and Git locator paths contain no glob metacharacters; Step inputs and Custom scripts reject absolute and home-relative paths. Filesystem containment after normalization and link resolution belongs to the later preflight slice.
- ADR-0001 still makes duplicate normalized Catalog Source identities invalid. This prototype does not implement that rule because provider-specific identity normalization and its stable diagnostic are not part of Issue #9; the Catalog loading/preflight slice must add both before catalogs are used.
- Stable codes are exactly `yaml-parse-error`, `schema-version-missing`, `schema-version-unsupported`, `schema-validation-failed`, `recipes-empty`, `recipes-not-supported`, and `requires-not-supported`.
- Diagnostics always contain `code`, `severity: "error"`, and `message`; omit unknown context rather than emitting `null`.
- Do not add a test framework, CLI, schema generator, custom error class, or dependency beyond `ajv` and `yaml`.
- Never push. The task commits below are local commits on the current non-`main` branch.

---

## File Map

- `prototypes/issue-9/contract.schema.json`: the only JSON Schema contract; `$defs` exposes all shared shapes and the seven document schemas.
- `prototypes/issue-9/validate.mjs`: schema compilation, ordered YAML/version/schema/semantic validation, and diagnostic normalization.
- `prototypes/issue-9/test/prototype.test.mjs`: the single public-seam matrix, including in-memory invalid variants and filesystem immutability checks.
- `prototypes/issue-9/fixture/valid/*.yaml`: one readable canonical example for each supported document kind.
- `prototypes/issue-9/package.json` and `package-lock.json`: isolated ESM package, scripts, and pinned dependency graph.
- `prototypes/issue-9/.gitignore`: ignores only this prototype's `node_modules/`.
- `prototypes/issue-9/README.md`: scope, public API, diagnostic contract, and runnable commands.

### Task 1: Scaffold the isolated package and prove all canonical documents valid

**Files:**

- Create: `prototypes/issue-9/.gitignore`
- Create: `prototypes/issue-9/package.json`
- Create: `prototypes/issue-9/package-lock.json`
- Create: `prototypes/issue-9/contract.schema.json`
- Create: `prototypes/issue-9/validate.mjs`
- Create: `prototypes/issue-9/fixture/valid/manifest.yaml`
- Create: `prototypes/issue-9/fixture/valid/source.yaml`
- Create: `prototypes/issue-9/fixture/valid/recipe.yaml`
- Create: `prototypes/issue-9/fixture/valid/catalog.yaml`
- Create: `prototypes/issue-9/fixture/valid/tbboot.lock.yaml`
- Create: `prototypes/issue-9/fixture/valid/state.yaml`
- Create: `prototypes/issue-9/fixture/valid/trust.yaml`
- Create: `prototypes/issue-9/test/prototype.test.mjs`

**Interfaces:**

- Consumes: YAML text plus caller-supplied document kind and display name.
- Produces: `validateDocument({ kind, text, document, source?, recipe? }) -> { value, diagnostics }`, where `value` is the parsed JavaScript value on success and `undefined` on failure.
- Produces: addressable schema URIs `https://tbboot.dev/schemas/contract-v1#/$defs/{manifest,source,recipe,catalog,lockfile,state,trust}`.

- [ ] **Step 1: Add the failing valid-document matrix.**

Create `test/prototype.test.mjs` with the public seam and exact fixture mapping:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateDocument } from '../validate.mjs';

const validDocuments = {
  manifest: 'manifest.yaml',
  source: 'source.yaml',
  recipe: 'recipe.yaml',
  catalog: 'catalog.yaml',
  lockfile: 'tbboot.lock.yaml',
  state: 'state.yaml',
  trust: 'trust.yaml',
};

const fixtureUrl = (name) => new URL(`../fixture/valid/${name}`, import.meta.url);
const fixtureText = (name) => readFile(fixtureUrl(name), 'utf8');

test('accepts all seven canonical documents', async () => {
  for (const [kind, document] of Object.entries(validDocuments)) {
    const result = validateDocument({
      kind,
      document,
      text: await fixtureText(document),
    });
    assert.deepEqual(result.diagnostics, [], `${document}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.value.schemaVersion, 1);
  }
});
```

- [ ] **Step 2: Run the focused test and confirm red.**

Run from `prototypes/issue-9/`:

```powershell
node --test --test-name-pattern="canonical documents" test/prototype.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `validate.mjs`.

- [ ] **Step 3: Add the isolated package and install its two dependencies.**

Create `.gitignore`:

```gitignore
node_modules/
```

Create `package.json`:

```json
{
  "name": "tbboot-issue-9-prototype",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.12 <25"
  },
  "scripts": {
    "check": "node --check validate.mjs && node --check test/prototype.test.mjs",
    "test": "node --test"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "yaml": "^2.8.1"
  }
}
```

Run `npm install` in `prototypes/issue-9/` so npm creates `package-lock.json`. Do not copy the issue 5 lockfile or its installed modules.

- [ ] **Step 4: Add the seven canonical YAML fixtures.**

Use these exact fixture contents; they collectively exercise both providers, both Git selector forms, every Step/effect variant, every Custom lifecycle operation, and authored/generated/local documents:

```yaml
# fixture/valid/manifest.yaml
schemaVersion: 1
sources:
  - provider: local
    locator:
      path: ../shared-source
  - provider: git
    locator:
      repository: https://example.com/team/recipes.git
      path: sources/windows
    selector:
      ref: main
```

```yaml
# fixture/valid/source.yaml
schemaVersion: 1
dependencies:
  - name: shared
    provider: local
    locator:
      path: ../shared-source
  - name: tools
    provider: git
    locator:
      repository: https://example.com/team/tools.git
    selector:
      from: v1.0.0
      to: v2.0.0
```

```yaml
# fixture/valid/recipe.yaml
schemaVersion: 1
steps:
  - type: file
    input: files/editorconfig
    target: .editorconfig
  - type: file-fragment
    input: files/agents.md
    target: AGENTS.md
    optional: true
  - type: custom
    check:
      runtime: node
      content: return { status: 'ok', changed: false };
      timeoutSeconds: 60
    install:
      runtime: pwsh
      script: scripts/install.ps1
    uninstall:
      runtime: node
      script: scripts/uninstall.mjs
```

```yaml
# fixture/valid/catalog.yaml
schemaVersion: 1
entries:
  - title: Team defaults
    description: Shared repository setup recipes
    keywords: [team, defaults]
    source:
      provider: git
      locator:
        repository: https://example.com/team/recipes.git
      selector:
        ref: main
```

```yaml
# fixture/valid/tbboot.lock.yaml
schemaVersion: 1
sources:
  - source:
      provider: local
      locator:
        path: ../shared-source
    fingerprint: sha256:local-content
  - source:
      provider: git
      locator:
        repository: https://example.com/team/recipes.git
        path: sources/windows
      selector:
        ref: main
    revision: 8c17f4
    fingerprint: sha256:git-content
```

```yaml
# fixture/valid/state.yaml
schemaVersion: 1
effects:
  - type: file
    source:
      provider: local
      locator:
        path: ../shared-source
    sourceFingerprint: sha256:local-content
    recipe: baseline
    step: 1
    target: .editorconfig
    artifactFingerprint: sha256:file-content
    created: true
  - type: file-fragment
    source:
      provider: git
      locator:
        repository: https://example.com/team/recipes.git
      selector:
        ref: main
    revision: 8c17f4
    sourceFingerprint: sha256:git-content
    recipe: baseline
    step: 2
    target: AGENTS.md
    marker: team-recipes/baseline
    artifactFingerprint: sha256:fragment-content
  - type: custom
    source:
      provider: git
      locator:
        repository: https://example.com/team/recipes.git
      selector:
        ref: main
    revision: 8c17f4
    sourceFingerprint: sha256:git-content
    recipe: baseline
    step: 3
    uninstallSupported: true
```

```yaml
# fixture/valid/trust.yaml
schemaVersion: 1
sources:
  - source:
      provider: local
      locator:
        path: ../shared-source
    fingerprint: sha256:local-content
  - source:
      provider: git
      locator:
        repository: https://example.com/team/recipes.git
    revision: 8c17f4
```

- [ ] **Step 5: Write the one closed schema contract.**

Create `contract.schema.json` with this complete contract:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://tbboot.dev/schemas/contract-v1",
  "$defs": {
    "nonEmptyString": { "type": "string", "minLength": 1 },
    "positiveInteger": { "type": "integer", "minimum": 1 },
    "sourceRelativePath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?![A-Za-z]:)(?![\\\\/]|~(?:[\\\\/]|$)).+"
    },
    "repositoryRelativePath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?![A-Za-z]:)(?![\\\\/]|~(?:[\\\\/]|$))(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+"
    },
    "gitPath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?![A-Za-z]:)(?![\\\\/]|~(?:[\\\\/]|$))(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$))(?!.*[?*\\[\\]{}]).+"
    },
    "localLocator": {
      "type": "object",
      "required": ["path"],
      "properties": { "path": { "$ref": "#/$defs/nonEmptyString" } },
      "additionalProperties": false
    },
    "gitLocator": {
      "type": "object",
      "required": ["repository"],
      "properties": {
        "repository": { "$ref": "#/$defs/nonEmptyString" },
        "path": { "$ref": "#/$defs/gitPath" }
      },
      "additionalProperties": false
    },
    "localSelector": { "type": "object", "maxProperties": 0, "additionalProperties": false },
    "gitSelector": {
      "oneOf": [
        {
          "type": "object",
          "required": ["ref"],
          "properties": { "ref": { "$ref": "#/$defs/nonEmptyString" } },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["from", "to"],
          "properties": {
            "from": { "$ref": "#/$defs/nonEmptyString" },
            "to": { "$ref": "#/$defs/nonEmptyString" }
          },
          "additionalProperties": false
        }
      ]
    },
    "sourceReference": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "required": ["provider", "locator"],
          "properties": {
            "provider": { "const": "local" },
            "locator": { "$ref": "#/$defs/localLocator" },
            "selector": { "$ref": "#/$defs/localSelector" }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["provider", "locator"],
          "properties": {
            "provider": { "const": "git" },
            "locator": { "$ref": "#/$defs/gitLocator" },
            "selector": { "$ref": "#/$defs/gitSelector" }
          },
          "additionalProperties": false
        }
      ],
      "discriminator": { "propertyName": "provider" }
    },
    "selectableSourceReference": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "required": ["provider", "locator"],
          "properties": {
            "provider": { "const": "local" },
            "locator": { "$ref": "#/$defs/localLocator" },
            "selector": { "$ref": "#/$defs/localSelector" },
            "recipes": { "type": "array", "uniqueItems": true, "items": { "$ref": "#/$defs/nonEmptyString" } }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["provider", "locator"],
          "properties": {
            "provider": { "const": "git" },
            "locator": { "$ref": "#/$defs/gitLocator" },
            "selector": { "$ref": "#/$defs/gitSelector" },
            "recipes": { "type": "array", "uniqueItems": true, "items": { "$ref": "#/$defs/nonEmptyString" } }
          },
          "additionalProperties": false
        }
      ],
      "discriminator": { "propertyName": "provider" }
    },
    "sourceDependency": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "required": ["name", "provider", "locator"],
          "properties": {
            "name": { "$ref": "#/$defs/nonEmptyString" },
            "provider": { "const": "local" },
            "locator": { "$ref": "#/$defs/localLocator" },
            "selector": { "$ref": "#/$defs/localSelector" },
            "recipes": { "type": "array", "uniqueItems": true, "items": { "$ref": "#/$defs/nonEmptyString" } }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["name", "provider", "locator"],
          "properties": {
            "name": { "$ref": "#/$defs/nonEmptyString" },
            "provider": { "const": "git" },
            "locator": { "$ref": "#/$defs/gitLocator" },
            "selector": { "$ref": "#/$defs/gitSelector" },
            "recipes": { "type": "array", "uniqueItems": true, "items": { "$ref": "#/$defs/nonEmptyString" } }
          },
          "additionalProperties": false
        }
      ],
      "discriminator": { "propertyName": "provider" }
    },
    "customOperation": {
      "type": "object",
      "required": ["runtime"],
      "properties": {
        "runtime": { "enum": ["node", "pwsh"] },
        "selector": { "$ref": "#/$defs/nonEmptyString" },
        "timeoutSeconds": { "$ref": "#/$defs/positiveInteger" },
        "script": { "$ref": "#/$defs/sourceRelativePath" },
        "content": { "$ref": "#/$defs/nonEmptyString" }
      },
      "oneOf": [
        { "required": ["script"], "properties": { "script": true, "content": false } },
        { "required": ["content"], "properties": { "script": false, "content": true } }
      ],
      "additionalProperties": false
    },
    "step": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "required": ["type", "input", "target"],
          "properties": {
            "type": { "const": "file" },
            "input": { "$ref": "#/$defs/sourceRelativePath" },
            "target": { "$ref": "#/$defs/repositoryRelativePath" },
            "optional": { "type": "boolean" }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["type", "input", "target"],
          "properties": {
            "type": { "const": "file-fragment" },
            "input": { "$ref": "#/$defs/sourceRelativePath" },
            "target": { "$ref": "#/$defs/repositoryRelativePath" },
            "optional": { "type": "boolean" }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["type", "check"],
          "properties": {
            "type": { "const": "custom" },
            "optional": { "type": "boolean" },
            "check": { "$ref": "#/$defs/customOperation" },
            "install": { "$ref": "#/$defs/customOperation" },
            "uninstall": { "$ref": "#/$defs/customOperation" }
          },
          "dependencies": { "uninstall": ["install"] },
          "additionalProperties": false
        }
      ],
      "discriminator": { "propertyName": "type" }
    },
    "requirement": {
      "type": "object",
      "required": ["source", "recipe"],
      "properties": {
        "source": { "$ref": "#/$defs/nonEmptyString" },
        "recipe": { "$ref": "#/$defs/repositoryRelativePath" }
      },
      "additionalProperties": false
    },
    "manifest": {
      "type": "object",
      "required": ["schemaVersion", "sources"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "sources": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/selectableSourceReference" } }
      },
      "additionalProperties": false
    },
    "source": {
      "type": "object",
      "required": ["schemaVersion"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "dependencies": { "type": "array", "items": { "$ref": "#/$defs/sourceDependency" } }
      },
      "additionalProperties": false
    },
    "recipe": {
      "type": "object",
      "required": ["schemaVersion", "steps"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "steps": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/step" } },
        "requires": { "type": "array", "items": { "$ref": "#/$defs/requirement" } }
      },
      "additionalProperties": false
    },
    "catalog": {
      "type": "object",
      "required": ["schemaVersion", "entries"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["title", "description", "keywords", "source"],
            "properties": {
              "title": { "$ref": "#/$defs/nonEmptyString" },
              "description": { "$ref": "#/$defs/nonEmptyString" },
              "keywords": { "type": "array", "uniqueItems": true, "items": { "$ref": "#/$defs/nonEmptyString" } },
              "source": { "$ref": "#/$defs/sourceReference" }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    },
    "lockEntry": {
      "type": "object",
      "required": ["source", "fingerprint"],
      "properties": {
        "source": { "$ref": "#/$defs/sourceReference" },
        "revision": { "$ref": "#/$defs/nonEmptyString" },
        "fingerprint": { "$ref": "#/$defs/nonEmptyString" }
      },
      "if": {
        "properties": { "source": { "type": "object", "properties": { "provider": { "const": "git" } }, "required": ["provider"] } },
        "required": ["source"]
      },
      "then": { "required": ["revision"], "properties": { "revision": true } },
      "else": { "properties": { "revision": false } },
      "additionalProperties": false
    },
    "lockfile": {
      "type": "object",
      "required": ["schemaVersion", "sources"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "sources": { "type": "array", "items": { "$ref": "#/$defs/lockEntry" } }
      },
      "additionalProperties": false
    },
    "effect": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "required": ["source", "sourceFingerprint", "recipe", "step", "type", "target", "artifactFingerprint", "created"],
          "properties": {
            "source": { "$ref": "#/$defs/sourceReference" },
            "revision": { "$ref": "#/$defs/nonEmptyString" },
            "sourceFingerprint": { "$ref": "#/$defs/nonEmptyString" },
            "recipe": { "$ref": "#/$defs/repositoryRelativePath" },
            "step": { "$ref": "#/$defs/positiveInteger" },
            "type": { "const": "file" },
            "target": { "$ref": "#/$defs/repositoryRelativePath" },
            "artifactFingerprint": { "$ref": "#/$defs/nonEmptyString" },
            "created": { "type": "boolean" }
          },
          "if": { "properties": { "source": { "type": "object", "properties": { "provider": { "const": "git" } }, "required": ["provider"] } }, "required": ["source"] },
          "then": { "required": ["revision"], "properties": { "revision": true } },
          "else": { "properties": { "revision": false } },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["source", "sourceFingerprint", "recipe", "step", "type", "target", "marker", "artifactFingerprint"],
          "properties": {
            "source": { "$ref": "#/$defs/sourceReference" },
            "revision": { "$ref": "#/$defs/nonEmptyString" },
            "sourceFingerprint": { "$ref": "#/$defs/nonEmptyString" },
            "recipe": { "$ref": "#/$defs/repositoryRelativePath" },
            "step": { "$ref": "#/$defs/positiveInteger" },
            "type": { "const": "file-fragment" },
            "target": { "$ref": "#/$defs/repositoryRelativePath" },
            "marker": { "$ref": "#/$defs/nonEmptyString" },
            "artifactFingerprint": { "$ref": "#/$defs/nonEmptyString" }
          },
          "if": { "properties": { "source": { "type": "object", "properties": { "provider": { "const": "git" } }, "required": ["provider"] } }, "required": ["source"] },
          "then": { "required": ["revision"], "properties": { "revision": true } },
          "else": { "properties": { "revision": false } },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["source", "sourceFingerprint", "recipe", "step", "type", "uninstallSupported"],
          "properties": {
            "source": { "$ref": "#/$defs/sourceReference" },
            "revision": { "$ref": "#/$defs/nonEmptyString" },
            "sourceFingerprint": { "$ref": "#/$defs/nonEmptyString" },
            "recipe": { "$ref": "#/$defs/repositoryRelativePath" },
            "step": { "$ref": "#/$defs/positiveInteger" },
            "type": { "const": "custom" },
            "uninstallSupported": { "type": "boolean" }
          },
          "if": { "properties": { "source": { "type": "object", "properties": { "provider": { "const": "git" } }, "required": ["provider"] } }, "required": ["source"] },
          "then": { "required": ["revision"], "properties": { "revision": true } },
          "else": { "properties": { "revision": false } },
          "additionalProperties": false
        }
      ],
      "discriminator": { "propertyName": "type" }
    },
    "state": {
      "type": "object",
      "required": ["schemaVersion", "effects"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "effects": { "type": "array", "items": { "$ref": "#/$defs/effect" } }
      },
      "additionalProperties": false
    },
    "trustEntry": {
      "type": "object",
      "required": ["source"],
      "properties": {
        "source": { "$ref": "#/$defs/sourceReference" },
        "revision": { "$ref": "#/$defs/nonEmptyString" },
        "fingerprint": { "$ref": "#/$defs/nonEmptyString" }
      },
      "if": {
        "properties": { "source": { "type": "object", "properties": { "provider": { "const": "git" } }, "required": ["provider"] } },
        "required": ["source"]
      },
      "then": { "required": ["revision"], "properties": { "revision": true, "fingerprint": false } },
      "else": { "required": ["fingerprint"], "properties": { "revision": false, "fingerprint": true } },
      "additionalProperties": false
    },
    "trust": {
      "type": "object",
      "required": ["schemaVersion", "sources"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "sources": { "type": "array", "items": { "$ref": "#/$defs/trustEntry" } }
      },
      "additionalProperties": false
    }
  }
}
```

The three path definitions deliberately stop at lexical rules. Do not add URI,
hash-prefix, Git SHA, filesystem existence, canonical-containment, or symlink
checks. Do not treat the absence of duplicate Catalog identity validation as
permission to accept duplicates in production; ADR-0001 assigns that semantic
check to the later Catalog loading/preflight slice after provider-specific
normalization is available.

- [ ] **Step 6: Add the minimal validator that compiles and selects every schema.**

Create `validate.mjs` with this initial implementation:

```js
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { parseAllDocuments } from 'yaml';

const schemaId = 'https://tbboot.dev/schemas/contract-v1';
const contract = JSON.parse(readFileSync(new URL('./contract.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(contract);

const validators = Object.fromEntries(
  ['manifest', 'source', 'recipe', 'catalog', 'lockfile', 'state', 'trust']
    .map((kind) => [kind, ajv.getSchema(`${schemaId}#/$defs/${kind}`)]),
);

if (Object.values(validators).some((validator) => validator === undefined)) {
  throw new Error('The contract does not expose all document schemas');
}

export function validateDocument({ kind, text, document, source, recipe }) {
  const yamlDocuments = parseAllDocuments(text, { schema: 'core', uniqueKeys: true });
  const value = yamlDocuments[0]?.toJS();
  const validator = validators[kind];
  if (!validator) throw new TypeError(`Unsupported document kind: ${kind}`);
  const valid = validator(value);
  return {
    value: valid ? value : undefined,
    diagnostics: valid ? [] : validator.errors.map((error) => ({
      code: 'schema-validation-failed',
      severity: 'error',
      message: error.message,
      ...(document === undefined ? {} : { document }),
      path: error.instancePath,
      ...(source === undefined ? {} : { source }),
      ...(recipe === undefined ? {} : { recipe }),
    })),
  };
}
```

This deliberately only makes the canonical matrix green. Tasks 2–4 replace its incomplete error handling through focused failing tests.

- [ ] **Step 7: Run the valid matrix and commit the vertical slice.**

Run:

```powershell
npm run check
node --test --test-name-pattern="canonical documents" test/prototype.test.mjs
```

Expected: syntax checks PASS, Ajv compiles the complete contract in strict mode at module load, and all seven fixtures PASS.

Commit:

```powershell
git add prototypes/issue-9
git commit -m "feat: define issue 9 YAML contract"
```

### Task 2: Enforce YAML parsing and schema-version precedence

**Files:**

- Modify: `prototypes/issue-9/validate.mjs`
- Modify: `prototypes/issue-9/test/prototype.test.mjs`

**Interfaces:**

- Consumes: the Task 1 `validateDocument` signature and compiled validator map.
- Produces: exactly one diagnostic for a parse-stage or schema-version-stage failure; later stages are not run.
- Produces: `yaml-parse-error`, `schema-version-missing`, and `schema-version-unsupported` with `document` when supplied; version diagnostics also carry `path: "/schemaVersion"` because that logical path is known.

- [ ] **Step 1: Add the failing ordered-gate matrix.**

Add this test table and assertion:

```js
test('rejects YAML and version failures at the earliest gate', () => {
  const cases = [
    ['empty input', '', 'yaml-parse-error', undefined, undefined],
    ['whitespace input', '  \n', 'yaml-parse-error', undefined, undefined],
    ['syntax error', 'schemaVersion: [1\n', 'yaml-parse-error', undefined, undefined],
    ['duplicate key', 'schemaVersion: 1\nschemaVersion: 1\n', 'yaml-parse-error', undefined, undefined],
    ['multiple documents', 'schemaVersion: 1\nsources: []\n---\nschemaVersion: 1\nsources: []\n', 'yaml-parse-error', undefined, undefined],
    ['missing version', 'sources: []\n', 'schema-version-missing', '/schemaVersion',
      'Missing required schemaVersion'],
    ['unsupported numeric version', 'schemaVersion: 2\nsources: []\n', 'schema-version-unsupported',
      '/schemaVersion', 'Unsupported schemaVersion: 2'],
    ['unsupported scalar version', 'schemaVersion: one\nsources: []\n', 'schema-version-unsupported',
      '/schemaVersion', 'Unsupported schemaVersion: "one"'],
  ];

  for (const [name, text, code, path, message] of cases) {
    const result = validateDocument({ kind: 'manifest', text, document: 'tbboot.yaml' });
    assert.equal(result.value, undefined, name);
    assert.equal(result.diagnostics.length, 1, name);
    assert.equal(result.diagnostics[0].code, code, name);
    assert.equal(result.diagnostics[0].document, 'tbboot.yaml', name);
    if (path === undefined) {
      assert.equal('path' in result.diagnostics[0], false, name);
    } else {
      assert.equal(result.diagnostics[0].path, path, name);
    }
    if (message !== undefined) assert.equal(result.diagnostics[0].message, message, name);
  }
});
```

- [ ] **Step 2: Run the focused test and confirm red.**

Run:

```powershell
node --test --test-name-pattern="earliest gate" test/prototype.test.mjs
```

Expected: FAIL because empty input throws or reaches Ajv, parser errors are ignored, and version failures use the generic schema code.

- [ ] **Step 3: Implement the ordered parse and version gates.**

Add one diagnostic helper and replace the start of `validateDocument`:

```js
function diagnostic(code, message, { document, path, source, recipe, step } = {}) {
  return {
    code,
    severity: 'error',
    message,
    ...(document === undefined ? {} : { document }),
    ...(path === undefined ? {} : { path }),
    ...(source === undefined ? {} : { source }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(step === undefined ? {} : { step }),
  };
}

export function validateDocument({ kind, text, document, source, recipe }) {
  const validator = validators[kind];
  if (!validator) throw new TypeError(`Unsupported document kind: ${kind}`);

  const yamlDocuments = parseAllDocuments(text, { schema: 'core', uniqueKeys: true });
  if (yamlDocuments.length !== 1 || yamlDocuments[0].errors.length > 0 || yamlDocuments[0].contents === null) {
    const message = yamlDocuments.length === 0
      ? 'Expected one non-empty YAML document'
      : yamlDocuments.length > 1
        ? 'Expected exactly one YAML document'
        : yamlDocuments[0].errors[0]?.message ?? 'Expected a non-empty YAML document';
    return { value: undefined, diagnostics: [diagnostic('yaml-parse-error', message, { document })] };
  }

  const value = yamlDocuments[0].toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Object.hasOwn(value, 'schemaVersion')) {
    return { value: undefined, diagnostics: [diagnostic(
      'schema-version-missing',
      'Missing required schemaVersion',
      { document, path: '/schemaVersion' },
    )] };
  }
  if (value.schemaVersion !== 1) {
    return { value: undefined, diagnostics: [diagnostic(
      'schema-version-unsupported',
      `Unsupported schemaVersion: ${JSON.stringify(value.schemaVersion)}`,
      { document, path: '/schemaVersion' },
    )] };
  }

  // Keep Task 1's structural validation below this point.
}
```

Use `Object.hasOwn`; do not add a compatibility helper for the supported Node runtime.

- [ ] **Step 4: Run the ordered-gate and valid tests.**

Run:

```powershell
node --test --test-name-pattern="earliest gate|canonical documents" test/prototype.test.mjs
```

Expected: both tests PASS; no parser/version case leaks a generic schema diagnostic.

- [ ] **Step 5: Commit the parse/version gate.**

```powershell
git add prototypes/issue-9/validate.mjs prototypes/issue-9/test/prototype.test.mjs
git commit -m "feat: reject invalid YAML and schema versions"
```

### Task 3: Prove the closed contract and normalize schema diagnostics with context

**Files:**

- Verify: `prototypes/issue-9/contract.schema.json`
- Modify: `prototypes/issue-9/validate.mjs`
- Modify: `prototypes/issue-9/test/prototype.test.mjs`

**Interfaces:**

- Consumes: Task 1's complete closed contract and Task 2's ordered validation gates.
- Produces: one `schema-validation-failed` diagnostic per actionable Ajv error, with JSON Pointer-like `path` and clearer unknown-field/discriminator messages; summary errors from `oneOf` and `if` are omitted when their child errors identify the failure.
- Produces: caller-supplied string `source` and `recipe` context on every diagnostic, plus one-based `step` when an Ajv path is inside `/steps/<zero-based-index>`.
- Proves: discriminated Source-reference and Step/effect unions, nested `source.provider` conditions for lock/state/trust pins, and the lexical path rules owned by this prototype.

- [ ] **Step 1: Add helpers that build invalid YAML only in memory.**

Extend the test imports and helpers:

```js
import { parse, stringify } from 'yaml';

async function invalidVariant(document, mutate) {
  const value = parse(await fixtureText(document));
  mutate(value);
  return stringify(value);
}

function assertSchemaFailure(result, path) {
  assert.equal(result.value, undefined);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every(({ code, severity }) =>
    code === 'schema-validation-failed' && severity === 'error'));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === path),
    JSON.stringify(result.diagnostics));
}
```

- [ ] **Step 2: Add the failing Source-reference and authored-document matrix.**

Use subtests that mutate copies returned by `invalidVariant` and call the public seam. Cover these exact cases and expected paths:

```text
manifest /sources/0/provider: unsupported provider
manifest /sources/0/locator/repository: local locator with Git field
manifest /sources/1/locator/pathTypo: unknown nested locator field
manifest /sources/1/locator/path: absolute Git path `C:/sources/windows`
manifest /sources/1/locator/path: Git path `sources/../windows`
manifest /sources/1/locator/path: Git glob `sources/*`
manifest /sources/1/selector: Git selector containing ref plus from/to
manifest /sources/0/selector/ref: non-empty local selector
manifest /sources/0/recipes/0: malformed empty recipe selection
source /id: forbidden Source id
source /selector: forbidden document-level selector
source /dependencies/0/name: missing dependency alias
source /dependencies/0/extra: unknown dependency field
recipe /id: forbidden Recipe id
recipe /steps: empty ordered Step list
recipe /steps/0/target: missing File target
recipe /steps/0/input: absolute Source input path `C:/outside/input.txt`
recipe /steps/0/target: absolute target path `C:/outside/target.txt`
recipe /steps/0/target: escaping target `../outside/target.txt`
recipe /steps/0/marker: configurable File Fragment marker
recipe /steps/2/type: unsupported Step discriminator
recipe /steps/2/check/runtime: unsupported Custom runtime
recipe /steps/2/check/content: operation containing both script and content
recipe /steps/2/check: operation containing neither script nor content
recipe /steps/2/check/script: absolute Custom script path `C:/outside/check.mjs`
recipe /steps/2/check/timeoutSeconds: zero timeout
recipe /steps/2/uninstall: uninstall present after deleting install
recipe /requires/0/recipe: malformed empty requirement path
catalog /entries/0/title: empty title
catalog /entries/0/keywords/1: duplicate keyword
catalog /entries/0/id: forbidden catalog entry ID
catalog /entries/0/source/recipes: forbidden selection in catalog Source reference
```

For unknown fields, assert both the exact appended path and message. Example:

```js
test('reports unknown fields at their actual nested path', async () => {
  const text = await invalidVariant('manifest.yaml', (value) => {
    value.sources[0].locator.soruces = 'typo';
  });
  const result = validateDocument({ kind: 'manifest', text, document: 'tbboot.yaml' });

  assertSchemaFailure(result, '/sources/0/locator/soruces');
  assert.ok(result.diagnostics.some(({ message }) => message === 'Unknown field: soruces'));
});
```

Also prove that the root object of every document schema is closed:

```js
test('closes the root of every document schema', async () => {
  for (const [kind, document] of Object.entries(validDocuments)) {
    const text = await invalidVariant(document, (value) => {
      value.unexpected = true;
    });
    const result = validateDocument({ kind, text, document });

    assertSchemaFailure(result, '/unexpected');
    assert.ok(result.diagnostics.some(({ message }) => message === 'Unknown field: unexpected'));
  }
});
```

Add a focused diagnostic-quality test that rejects an unsupported Source
provider and Step type with exactly the selected discriminator failure:

```js
test('does not leak errors from incompatible union branches', async () => {
  const cases = [
    ['manifest', 'manifest.yaml', (value) => { value.sources[0].provider = 'ftp'; },
      '/sources/0/provider', 'Unsupported provider: ftp'],
    ['recipe', 'recipe.yaml', (value) => { value.steps[0].type = 'unknown'; },
      '/steps/0/type', 'Unsupported type: unknown'],
  ];

  for (const [kind, document, mutate, path, message] of cases) {
    const result = validateDocument({
      kind,
      document,
      text: await invalidVariant(document, mutate),
    });
    assert.deepEqual(
      result.diagnostics.map(({ code, path: actualPath, message: actualMessage }) =>
        ({ code, path: actualPath, message: actualMessage })),
      [{ code: 'schema-validation-failed', path, message }],
    );
  }
});
```

For the existing local-locator-with-Git-field case, additionally assert that
no diagnostic points at `/sources/0/provider`; the selected local branch may
report its missing/unknown locator fields, but the Git branch must stay silent.

- [ ] **Step 3: Add the failing generated/local-document matrix.**

Cover these exact mutations and paths:

```text
lockfile /sources/0/fingerprint: missing local fingerprint
lockfile /sources/0/revision: revision on local entry
lockfile /sources/1/revision: missing Git revision
lockfile /sources/1/fingerprint: missing Git fingerprint
lockfile /sources/1/source/recipes: reserved selection forbidden in lock source
state /effects/0/revision: revision on local effect
state /effects/1/revision: missing Git effect revision
state /effects/0/created: missing File ownership flag
state /effects/1/marker: missing File Fragment marker
state /effects/2/uninstallSupported: missing Custom ownership flag
state /effects/0/content: unknown effect field
state /effects/0/step: zero step index
state /effects/0/target: absolute recorded target path `C:/outside/.editorconfig`
trust /sources/0/revision: revision on local trust entry
trust /sources/0/fingerprint: missing local trust fingerprint
trust /sources/1/fingerprint: fingerprint on Git trust entry
trust /sources/1/revision: missing Git trust revision
```

Also add positive subtests for a local Source with `selector: {}`, Git `{ ref }`, Git `{ from, to }`, each individual Step variant, Custom operations using `script` and `content`, and empty `entries`, `sources`, `effects`, and `dependencies` arrays where the spec permits them.

Prove all six Installation-record effect combinations with one compact table:

```js
test('accepts every provider and effect-type combination', () => {
  const sources = {
    local: { provider: 'local', locator: { path: '../shared-source' } },
    git: { provider: 'git', locator: { repository: 'https://example.com/team/recipes.git' } },
  };
  const fields = {
    file: { target: '.editorconfig', artifactFingerprint: 'sha256:file', created: true },
    'file-fragment': { target: 'AGENTS.md', marker: 'source/recipe', artifactFingerprint: 'sha256:fragment' },
    custom: { uninstallSupported: true },
  };

  for (const provider of ['local', 'git']) {
    for (const type of ['file', 'file-fragment', 'custom']) {
      const effect = {
        type,
        source: sources[provider],
        sourceFingerprint: 'sha256:source',
        recipe: 'baseline',
        step: 1,
        ...(provider === 'git' ? { revision: '8c17f4' } : {}),
        ...fields[type],
      };
      const result = validateDocument({
        kind: 'state',
        document: 'state.yaml',
        text: stringify({ schemaVersion: 1, effects: [effect] }),
      });

      assert.deepEqual(result.diagnostics, [], `${provider}/${type}`);
    }
  }
});
```

- [ ] **Step 4: Run the structural matrix and confirm red.**

Run:

```powershell
node --test --test-name-pattern="Source-reference|authored-document|generated|unknown fields|root of every|union branches|effect-type" test/prototype.test.mjs
```

Expected: FAIL because Task 1's raw Ajv mapping still reports required and
unknown-field paths at their containing objects and exposes generic Ajv
messages instead of the external diagnostic contract.

- [ ] **Step 5: Normalize Ajv errors.**

Task 1 already contains the complete portable `oneOf` rules, the Ajv
`discriminator` annotations, and the nested provider conditions. Keep that
contract unchanged and replace only Task 1's inline Ajv error mapping with the
helpers below:

Replace Task 1's inline Ajv error mapping with:

```js
function escapePointerToken(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function errorPath(error) {
  if (error.keyword === 'additionalProperties') {
    return `${error.instancePath}/${escapePointerToken(error.params.additionalProperty)}`;
  }
  if (error.keyword === 'required') {
    return `${error.instancePath}/${escapePointerToken(error.params.missingProperty)}`;
  }
  if (error.keyword === 'dependencies') {
    return `${error.instancePath}/${escapePointerToken(error.params.property)}`;
  }
  if (error.keyword === 'discriminator') {
    return `${error.instancePath}/${escapePointerToken(error.params.tag)}`;
  }
  return error.instancePath;
}

function schemaMessage(error) {
  if (error.keyword === 'additionalProperties') {
    return `Unknown field: ${error.params.additionalProperty}`;
  }
  if (error.keyword === 'discriminator') {
    return `Unsupported ${error.params.tag}: ${error.params.tagValue}`;
  }
  return error.message ?? 'Schema validation failed';
}

function actionableErrors(errors) {
  const actionable = errors.filter(({ keyword }) => keyword !== 'oneOf' && keyword !== 'if');
  return actionable.length > 0 ? actionable : errors;
}

function stepFromPath(path) {
  const match = /^\/steps\/(\d+)(?:\/|$)/.exec(path);
  return match ? Number(match[1]) + 1 : undefined;
}
```

Map errors after the version gate as follows:

```js
const valid = validator(value);
if (!valid) {
  const diagnostics = actionableErrors(validator.errors).map((error) => {
    const path = errorPath(error);
    return diagnostic('schema-validation-failed', schemaMessage(error), {
      document,
      path,
      source,
      recipe,
      step: stepFromPath(path),
    });
  });
  return { value: undefined, diagnostics };
}
```

Keep `allErrors: true` so independent failures in the selected branch are all
returned. Discard only `oneOf` and `if` summary errors when their actionable
child errors exist; the fallback in `actionableErrors` guarantees that an
invalid document never returns an empty diagnostic list. Do not deduplicate
field-level failures. Tests may ignore array order, except for the focused
discriminator cases that intentionally prove one exact external diagnostic.

- [ ] **Step 6: Prove Source/Recipe/Step context.**

Add this focused test:

```js
test('adds available Source Recipe and one-based Step context', async () => {
  const text = await invalidVariant('recipe.yaml', (value) => {
    value.steps[1].target = 42;
  });
  const result = validateDocument({
    kind: 'recipe',
    text,
    document: 'recipe.yaml',
    source: 'team-recipes',
    recipe: 'baseline',
  });
  const diagnostic = result.diagnostics.find(({ path }) => path === '/steps/1/target');

  assert.deepEqual(
    { document: diagnostic.document, source: diagnostic.source, recipe: diagnostic.recipe, step: diagnostic.step },
    { document: 'recipe.yaml', source: 'team-recipes', recipe: 'baseline', step: 2 },
  );
});
```

Add one parse-error assertion without caller context and verify `source`, `recipe`, `step`, and `path` are absent, not `null`.

- [ ] **Step 7: Run the complete structural suite and commit.**

Run:

```powershell
npm run check
npm test
```

Expected: all valid and invalid structural cases PASS, and schema compilation remains strict.

Commit:

```powershell
git add prototypes/issue-9/contract.schema.json prototypes/issue-9/validate.mjs prototypes/issue-9/test/prototype.test.mjs
git commit -m "test: close YAML document variants"
```

### Task 4: Add reserved-feature semantics and prove rejected validation is read-only

**Files:**

- Modify: `prototypes/issue-9/validate.mjs`
- Modify: `prototypes/issue-9/test/prototype.test.mjs`

**Interfaces:**

- Consumes: a structurally valid parsed value from Task 3.
- Produces: `recipes-empty` for `recipes: []`, `recipes-not-supported` for a non-empty selection, and `requires-not-supported` for a non-empty Recipe requirement list.
- Produces: semantic diagnostic paths at the reserved field itself and preserves the optional caller context.

- [ ] **Step 1: Add the failing reserved-feature matrix.**

Add tests for Manifest entries and Source dependencies separately:

```js
test('distinguishes reserved shapes from unsupported behavior', async () => {
  const cases = [
    ['manifest', 'manifest.yaml', (value) => { value.sources[0].recipes = []; }, 'recipes-empty', '/sources/0/recipes'],
    ['manifest', 'manifest.yaml', (value) => { value.sources[0].recipes = ['baseline']; }, 'recipes-not-supported', '/sources/0/recipes'],
    ['source', 'source.yaml', (value) => { value.dependencies[0].recipes = []; }, 'recipes-empty', '/dependencies/0/recipes'],
    ['source', 'source.yaml', (value) => { value.dependencies[0].recipes = ['baseline']; }, 'recipes-not-supported', '/dependencies/0/recipes'],
    ['recipe', 'recipe.yaml', (value) => { value.requires = [{ source: 'shared', recipe: 'baseline' }]; }, 'requires-not-supported', '/requires'],
  ];

  for (const [kind, document, mutate, code, path] of cases) {
    const result = validateDocument({
      kind,
      document,
      text: await invalidVariant(document, mutate),
    });
    assert.deepEqual(result.diagnostics.map(({ code: actual }) => actual), [code]);
    assert.equal(result.diagnostics[0].path, path);
  }
});
```

Add structural precedence cases where `recipes` is a string, contains an empty string, or `requires` contains a malformed item. Assert they return only `schema-validation-failed`, never a reserved semantic code. Add positive cases where the fields are omitted and `requires: []` is accepted.

- [ ] **Step 2: Run the focused test and confirm red.**

Run:

```powershell
node --test --test-name-pattern="reserved shapes|structural precedence" test/prototype.test.mjs
```

Expected: FAIL because structurally valid reserved values currently pass.

- [ ] **Step 3: Add the minimal post-schema semantic scan.**

Add and call this function only after Ajv succeeds:

```js
function reservedDiagnostics(kind, value, context) {
  const diagnostics = [];
  const selections = kind === 'manifest'
    ? value.sources.map((entry, index) => [entry, `/sources/${index}/recipes`])
    : kind === 'source'
      ? (value.dependencies ?? []).map((entry, index) => [entry, `/dependencies/${index}/recipes`])
      : [];

  for (const [entry, path] of selections) {
    if (!Object.hasOwn(entry, 'recipes')) continue;
    diagnostics.push(diagnostic(
      entry.recipes.length === 0 ? 'recipes-empty' : 'recipes-not-supported',
      entry.recipes.length === 0
        ? 'recipes must be omitted when no selection is requested'
        : 'Recipe selection is not supported in the MVP',
      { ...context, path },
    ));
  }

  if (kind === 'recipe' && value.requires?.length > 0) {
    diagnostics.push(diagnostic(
      'requires-not-supported',
      'Recipe requirements are not supported in the MVP',
      { ...context, path: '/requires' },
    ));
  }
  return diagnostics;
}
```

Finish `validateDocument` with:

```js
const diagnostics = reservedDiagnostics(kind, value, { document, source, recipe });
return { value: diagnostics.length === 0 ? value : undefined, diagnostics };
```

- [ ] **Step 4: Prove the complete envelope for all seven stable codes.**

Add one compact public-seam table. It checks every required field and uses an
exact key set so unknown `path`, `source`, `recipe`, or `step` context cannot
leak into a diagnostic:

```js
test('uses the complete diagnostic envelope for every stable code', async () => {
  const cases = [
    ['yaml-parse-error', 'manifest', 'tbboot.yaml', async () => 'schemaVersion: [', undefined],
    ['schema-version-missing', 'manifest', 'tbboot.yaml', async () => 'sources: []', '/schemaVersion'],
    ['schema-version-unsupported', 'manifest', 'tbboot.yaml', async () => 'schemaVersion: 2', '/schemaVersion'],
    ['schema-validation-failed', 'manifest', 'tbboot.yaml', () => invalidVariant('manifest.yaml', (value) => { value.unexpected = true; }), '/unexpected'],
    ['recipes-empty', 'manifest', 'tbboot.yaml', () => invalidVariant('manifest.yaml', (value) => { value.sources[0].recipes = []; }), '/sources/0/recipes'],
    ['recipes-not-supported', 'manifest', 'tbboot.yaml', () => invalidVariant('manifest.yaml', (value) => { value.sources[0].recipes = ['baseline']; }), '/sources/0/recipes'],
    ['requires-not-supported', 'recipe', 'recipe.yaml', () => invalidVariant('recipe.yaml', (value) => { value.requires = [{ source: 'shared', recipe: 'baseline' }]; }), '/requires'],
  ];

  for (const [code, kind, document, makeText, path] of cases) {
    const result = validateDocument({ kind, document, text: await makeText() });
    assert.equal(result.diagnostics.length, 1, code);
    const diagnostic = result.diagnostics[0];
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.severity, 'error');
    assert.equal(typeof diagnostic.message, 'string');
    assert.ok(diagnostic.message.length > 0);
    assert.equal(diagnostic.document, document);
    if (path !== undefined) assert.equal(diagnostic.path, path);
    assert.deepEqual(
      Object.keys(diagnostic).sort(),
      ['code', 'severity', 'message', 'document', ...(path === undefined ? [] : ['path'])].sort(),
      code,
    );
  }
});
```

- [ ] **Step 5: Wrap every rejected validation with a filesystem immutability assertion.**

Use Node stdlib only:

```js
import { readdir } from 'node:fs/promises';

async function fixtureSnapshot() {
  const names = (await readdir(new URL('../fixture/valid/', import.meta.url))).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await readFile(fixtureUrl(name)),
  ])));
}

async function rejectWithoutFixtureWrites(input) {
  const before = await fixtureSnapshot();
  const result = validateDocument(input);
  const after = await fixtureSnapshot();
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name], name);
  assert.ok(result.diagnostics.length > 0);
  return result;
}
```

Replace every rejected-input call in the parse/version, structural, context, and
reserved-feature tests with `await rejectWithoutFixtureWrites(input)`. Each
individual rejection therefore compares fixture paths and bytes immediately
before and after its own validator call. This proves the public seam has no
write side effect; do not add a mocked filesystem or a write abstraction. Mark
any affected `test(..., () => ...)` callback `async`, including the ordered-gate
test introduced in Task 2.

- [ ] **Step 6: Run all behavior tests and commit.**

Run:

```powershell
npm run check
npm test
```

Expected: the reserved semantic matrix and complete suite PASS; fixture names and bytes remain identical.

Commit:

```powershell
git add prototypes/issue-9/validate.mjs prototypes/issue-9/test/prototype.test.mjs
git commit -m "feat: validate reserved YAML semantics"
```

### Task 5: Document and verify the complete prototype

**Files:**

- Create: `prototypes/issue-9/README.md`
- Verify: `prototypes/issue-9/package-lock.json`
- Verify: all files under `prototypes/issue-9/`

**Interfaces:**

- Consumes: the complete public validator and package scripts from Tasks 1–4.
- Produces: reproducible `npm install`, `npm run check`, focused `node --test`, and complete `npm test` commands.

- [ ] **Step 1: Write the README with the public contract and boundaries.**

Create `README.md` with these sections and executable example:

````md
# Issue 9 YAML schema prototype

This isolated prototype validates the seven MVP tbboot YAML document kinds.
It parses and validates strings only; it never writes files or performs Git,
Custom execution, drift, uninstall, or process-control work.

Use Node.js `>=24.12 <25`; the package declares the same `engines.node` range.
The schema rejects lexical path violations visible in one YAML document.
Canonical containment through links remains a preflight responsibility.
ADR-0001 also requires rejection of duplicate normalized Catalog Source
identities; the Catalog loading/preflight slice owns that normalization and
its stable diagnostic because Issue #9 does not define either.

## Run

```powershell
Set-Location prototypes/issue-9
npm install
npm run check
npm test
```

## Public seam

```js
import { validateDocument } from './validate.mjs';

const result = validateDocument({
  kind: 'recipe',
  text: yamlText,
  document: 'recipe.yaml',
  source: 'team-recipes',
  recipe: 'baseline',
});
```

`kind` is one of `manifest`, `source`, `recipe`, `catalog`, `lockfile`,
`state`, or `trust`. Success returns `{ value, diagnostics: [] }`; rejection
returns `{ value: undefined, diagnostics }`. The caller supplies the kind and
available context explicitly.

`source` and `recipe` diagnostic context are caller-supplied strings. During
Recipe validation, `step` is derived as the one-based index represented by a
`/steps/<zero-based-index>` validation path. This prototype does not invent a
display name from a structured Source reference in lock, state, or trust data.

## Stable diagnostics

The prototype owns `yaml-parse-error`, `schema-version-missing`,
`schema-version-unsupported`, `schema-validation-failed`, `recipes-empty`,
`recipes-not-supported`, and `requires-not-supported`. Every diagnostic has
`code`, `severity`, and `message`; known document, path, Source, Recipe, and
one-based Step context is included without null placeholders.
````

Keep the fenced PowerShell and JavaScript blocks correctly nested in the actual file. Add a short note that invalid variants live in `test/prototype.test.mjs`, while `fixture/valid/` contains only canonical examples.

- [ ] **Step 2: Run the focused development check.**

Run from `prototypes/issue-9/`:

```powershell
node --test test/prototype.test.mjs
```

Expected: PASS for all valid, parse/version, structural, context, reserved, and immutability tests.

- [ ] **Step 3: Run final package and repository verification.**

Run from the repository root:

```powershell
npm run check --prefix prototypes/issue-9
npm test --prefix prototypes/issue-9
git diff --check
git status --short
```

Expected: both npm commands exit 0; `git diff --check` reports no whitespace errors; `git status --short` lists only the intended plan and `prototypes/issue-9/` work for this issue.

- [ ] **Step 4: Inspect scope and dependency isolation.**

Run:

```powershell
git diff --stat
git diff -- prototypes/issue-5 .gitignore
npm ls --prefix prototypes/issue-9 --depth=0
```

Expected: no diff for `prototypes/issue-5/` or the root `.gitignore`; direct dependencies are only `ajv` and `yaml`.

- [ ] **Step 5: Commit the documentation and final verification state.**

```powershell
git add prototypes/issue-9/README.md prototypes/issue-9/package-lock.json
git commit -m "docs: explain issue 9 schema prototype"
```

Do not push the branch.

## Coverage Self-Review

- Seven valid document schemas and fixtures: Task 1.
- One shared structured Source reference with provider-specific locators/selectors and controlled `recipes`: Tasks 1 and 3.
- Manifest, Source, Recipe, Catalog, lockfile, Installation record, and trust field/variant rules: Tasks 1 and 3.
- Exact Node `>=24.12 <25` package engine: Task 1.
- Lexical Git locator, Step input/target, and Custom script path rules: Tasks 1 and 3; canonical filesystem containment remains assigned to preflight.
- Duplicate normalized Catalog identities remain invalid under ADR-0001 and are explicitly assigned to the Catalog loading/preflight slice, which must define the normalization and stable diagnostic.
- YAML syntax, duplicate keys, empty/multiple documents, and version precedence: Task 2.
- Closed roots and nested objects, discriminated Source/Step/effect unions, all six provider/effect combinations, both invalid Custom script/content combinations, and actionable all-errors validation: Task 3.
- Stable diagnostic envelope, paths, unknown-field messages, optional Source/Recipe/Step context, and exact key coverage for all seven codes: Tasks 2–4.
- Reserved `recipes`/`requires` structural-versus-semantic behavior: Task 4.
- No-write evidence using unchanged fixture names and bytes after rejection: Task 4.
- Strict Ajv compilation, syntax checks, focused test, complete suite, package lock, and run instructions: Tasks 1 and 5.
- Git resolution, real fingerprints/plans, Custom execution, drift, uninstall, and process control remain excluded: Global Constraints and Task 5 README.
