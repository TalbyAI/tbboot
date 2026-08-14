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
