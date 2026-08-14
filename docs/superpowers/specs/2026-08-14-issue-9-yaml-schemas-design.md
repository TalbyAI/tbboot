# Issue 9: closed YAML schemas and diagnostic contract

## Goal

Build an isolated prototype that closes and validates the YAML contract for the
MVP Manifest, Source, Recipe, Catalog, lockfile, Installation record, and trust
documents. Valid documents are accepted; malformed YAML, unsupported schema
versions, unknown fields, invalid shapes, and unsupported reserved behavior are
rejected before any write.

The prototype also fixes the shared external diagnostic envelope and the stable
codes produced by parsing, schema validation, and declarative semantic
validation. Codes for Git resolution, Custom execution, drift, uninstall, and
process control remain owned by their later spikes or implementation slices.

## Location and isolation

All prototype files live under `prototypes/issue-9/`. The directory contains
its own fixtures, implementation, runnable checks, notes, package manifest, and
lockfile. It also contains a local `.gitignore` with `node_modules/`; the root
`.gitignore` is not changed for a prototype-only concern.

The prototype follows the repository's existing JavaScript ESM and `node:test`
pattern but does not extend or import `prototypes/issue-5`, whose document
shapes predate the final MVP contract.

## Validation approach

One JSON Schema contract contains shared definitions and an addressable schema
for each document. Ajv compiles it in strict mode. The existing `yaml` package
parses YAML 1.2 documents and exposes syntax errors and source positions.

Validation proceeds in this order:

1. Parse exactly one YAML document and reject syntax errors, duplicate keys,
   empty input, or multiple documents.
2. Validate the required `schemaVersion` separately so missing and unsupported
   versions receive stable codes.
3. Validate the selected document schema with all errors enabled.
4. If structural validation succeeds, apply the reserved-feature rules for
   `recipes` and `requires`.
5. Return normalized diagnostics. Validation never writes files.

The caller chooses the document type explicitly. The validator does not infer a
type from filenames or document contents.

## Shared Source reference

Manifest entries, Source dependencies, Catalog entries, lock entries,
Installation record effects, and trust entries reuse one structured Source
reference rather than encoding provider and locator into a string.

A local Source reference contains:

```yaml
provider: local
locator:
  path: ../shared-source
```

A Git Source reference contains:

```yaml
provider: git
locator:
  repository: https://example.com/team/recipes.git
  path: sources/windows # optional
selector:               # optional
  ref: main
```

Git selectors accept exactly one of these shapes:

- `{ ref }`
- `{ from, to }`

Local selectors may be absent or an empty mapping. Provider, locator, selector,
and nested objects are closed to unknown fields. A Source reference may contain
the future `recipes` field only where the containing document permits it.

## Authored document schemas

### Manifest: `tbboot.yaml`

The Manifest contains `schemaVersion: 1` and a non-empty `sources` array of
Source references. `recipes` is optional and reserved on each entry.

### Source: `source.yaml`

The Source contains `schemaVersion: 1` and an optional `dependencies` array. A
dependency reuses the Source reference shape and adds a required, non-empty
`name` alias. The document has no `id`, selector, revision, or Recipe listing.

### Recipe: `recipe.yaml`

The Recipe contains `schemaVersion: 1`, a non-empty ordered `steps` array, and
an optional reserved `requires` array. It has no `id`; its identity comes from
its Source-relative directory.

A reserved requirement has this syntax:

```yaml
source: shared
recipe: baseline
```

`source` names a Source dependency alias and `recipe` is a non-empty
Source-relative Recipe path.

The supported Step variants are closed discriminated objects:

- File: `type: file`, `input`, `target`, and optional `optional`.
- File Fragment: `type: file-fragment`, `input`, `target`, and optional
  `optional`. Managed markers are derived and cannot be configured.
- Custom: `type: custom`, optional `optional`, required `check`, optional
  `install`, and optional `uninstall`.

Each Custom operation contains `runtime`, optional `selector`, optional positive
integer `timeoutSeconds`, and exactly one of `script` or `content`. Runtime is
`node` or `pwsh`. `check` is required, and `uninstall` is accepted only when
`install` is present.

### Catalog

The Catalog contains `schemaVersion: 1` and an `entries` array. Each entry has a
non-empty `title`, non-empty `description`, unique string `keywords`, and a
Source reference nested under `source`. Entries have no IDs.

## Generated and local document schemas

### Lockfile: `tbboot.lock.yaml`

The lockfile contains `schemaVersion: 1` and a `sources` array. Each entry has a
structured `source` and a required content `fingerprint`.

Both local and Git Sources are locked:

```yaml
schemaVersion: 1
sources:
  - source:
      provider: local
      locator:
        path: ../shared-source
    fingerprint: sha256:...
  - source:
      provider: git
      locator:
        repository: https://example.com/team/recipes.git
        path: sources/windows
      selector:
        ref: main
    revision: 8c17f4...
    fingerprint: sha256:...
```

`revision` is required for Git and forbidden for local Sources. A local locator
is normalized while remaining relative to the Consumer repository when authored
that way; the lockfile does not turn it into a machine-specific absolute path.
A changed local Source fingerprint makes the lock stale and requires
`--update-lock`; `--frozen-lockfile` rejects the mismatch.

### Installation record: `.tbboot/state.yaml`

The Installation record contains `schemaVersion: 1` and a flat `effects` array
in effective installation order. Uninstall can process the array in reverse
without reconstructing an additional graph.

Every effect contains a structured `source`, required `sourceFingerprint`,
non-empty `recipe`, one-based positive integer `step`, and a discriminating
`type`. A Git effect also requires `revision`; a local effect forbids it.
Type-specific fields hold only the ownership data needed for drift detection,
reconciliation, and safe uninstall:

- File: `target`, `artifactFingerprint`, and `created`.
- File Fragment: `target`, `marker`, and `artifactFingerprint`.
- Custom: `uninstallSupported`.

Resolved data such as `revision` and `sourceFingerprint` remains beside
`source`, not encoded inside it. All effect variants are closed to other fields.

### Trust: `~/.tbboot/trust.yaml`

The trust document contains `schemaVersion: 1` and a `sources` array. Each entry
contains a structured Source reference. A Git entry requires the exact
`revision` authorized for Custom execution; a local entry instead requires its
exact `fingerprint` and forbids `revision`. Changing Git revision or local
content therefore requires new authorization. Trust does not belong in the
Manifest.

## Reserved feature semantics

The schemas recognize the future `recipes` and `requires` shapes so future
documents do not need a breaking structural redesign. Their MVP behavior is:

- `recipes: []` produces `recipes-empty`.
- Any non-empty `recipes` selection produces `recipes-not-supported`.
- Any non-empty `requires` list produces `requires-not-supported`.
- Omitting either field means no reserved behavior is requested.

These are semantic diagnostics rather than generic schema failures, except that
values with the wrong type or malformed items remain schema failures.

## Diagnostic contract

Every diagnostic contains:

```json
{
  "code": "schema-validation-failed",
  "severity": "error",
  "message": "Unknown field: soruces",
  "document": "tbboot.yaml",
  "path": "/soruces"
}
```

`code`, `severity`, and `message` are always present. `document` and the JSON
Pointer-like `path` are included when known. `source`, `recipe`, and one-based
`step` are added when validation has enough context. Absent context fields are
omitted rather than set to null.

The stable codes owned by this prototype are:

- `yaml-parse-error`
- `schema-version-missing`
- `schema-version-unsupported`
- `schema-validation-failed`
- `recipes-empty`
- `recipes-not-supported`
- `requires-not-supported`

Unknown fields, missing required fields, invalid scalar types, and invalid union
variants share `schema-validation-failed`; `path` and `message` identify the
specific failure. Future codes use lowercase kebab-case and the same envelope,
but are fixed only alongside executable evidence for their behavior.

## Files

```text
prototypes/issue-9/
├── .gitignore
├── fixture/valid/
│   ├── catalog.yaml
│   ├── manifest.yaml
│   ├── recipe.yaml
│   ├── source.yaml
│   ├── state.yaml
│   ├── tbboot.lock.yaml
│   └── trust.yaml
├── test/prototype.test.mjs
├── contract.schema.json
├── validate.mjs
├── package.json
├── package-lock.json
└── README.md
```

Invalid variants are built in the test file from the valid fixtures instead of
creating a fixture file per failure.

## Verification

One `node:test` matrix exercises the public validator seam and proves:

- all seven valid documents are accepted;
- unknown versions and fields are rejected at relevant nesting levels;
- local/Git references, Git selectors, Step variants, and Custom operations are
  closed and discriminated correctly;
- reserved shapes are distinguished from unsupported reserved behavior;
- lock entries require fingerprints for both providers and revisions only for
  Git;
- diagnostics expose the required document and Source/Recipe/Step context;
- fixture paths and bytes are identical before and after every rejected input;
- the schema contract compiles in Ajv strict mode.

The package exposes `node --check` for the implementation and test files and
`node --test` for the runnable prototype check. The focused test file runs
during development; the complete prototype suite runs once at completion.

## Non-goals

The prototype does not resolve Git refs, calculate real installation plans,
execute Custom operations, mutate lock/state/trust files, detect runtime drift,
or implement uninstall. It validates the documents and diagnostic contract that
those later slices will consume.
