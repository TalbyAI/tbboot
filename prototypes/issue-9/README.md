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

Invalid variants live in `test/prototype.test.mjs`; `fixture/valid/` contains
only canonical examples.
