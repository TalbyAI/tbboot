import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { parseAllDocuments } from 'yaml';

const schemaId = 'https://tbboot.dev/schemas/contract-v1';
const contract = JSON.parse(readFileSync(new URL('./contract.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(contract);

const validators = Object.assign(Object.create(null), Object.fromEntries(
  ['manifest', 'source', 'recipe', 'catalog', 'lockfile', 'state', 'trust']
    .map((kind) => [kind, ajv.getSchema(`${schemaId}#/$defs/${kind}`)]),
));

if (Object.values(validators).some((validator) => validator === undefined)) {
  throw new Error('The contract does not expose all document schemas');
}

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
  if (error.keyword === 'uniqueItems') {
    return `${error.instancePath}/${error.params.i}`;
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

export function validateDocument({ kind, text, document, source, recipe }) {
  if (!Object.hasOwn(validators, kind)) throw new TypeError(`Unsupported document kind: ${kind}`);
  const validator = validators[kind];
  const yamlDocuments = parseAllDocuments(text, {
    schema: 'core',
    uniqueKeys: true,
    version: '1.2',
  });

  const yaml11Directive = yamlDocuments.some(({ directives }) => directives?.yaml?.version === '1.1');
  if (yaml11Directive || yamlDocuments.length !== 1 || yamlDocuments[0].errors.length > 0 || yamlDocuments[0].contents === null) {
    const message = yaml11Directive
      ? 'YAML 1.1 is not supported'
      : yamlDocuments.length === 0
      ? 'Expected one non-empty YAML document'
      : yamlDocuments.length > 1
        ? 'Expected exactly one YAML document'
        : yamlDocuments[0].errors[0]?.message ?? 'Expected a non-empty YAML document';
    return {
      value: undefined,
      diagnostics: [diagnostic('yaml-parse-error', message, { document, source, recipe })],
    };
  }

  const value = yamlDocuments[0].toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Object.hasOwn(value, 'schemaVersion')) {
    return { value: undefined, diagnostics: [diagnostic(
      'schema-version-missing',
      'Missing required schemaVersion',
      { document, path: '/schemaVersion', source, recipe },
    )] };
  }
  if (value.schemaVersion !== 1) {
    let schemaVersion;
    try {
      schemaVersion = JSON.stringify(value.schemaVersion);
    } catch {
      schemaVersion = String(value.schemaVersion);
    }
    return { value: undefined, diagnostics: [diagnostic(
      'schema-version-unsupported',
      `Unsupported schemaVersion: ${schemaVersion}`,
      { document, path: '/schemaVersion', source, recipe },
    )] };
  }

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

  const diagnostics = reservedDiagnostics(kind, value, { document, source, recipe });
  return { value: diagnostics.length === 0 ? value : undefined, diagnostics };
}
