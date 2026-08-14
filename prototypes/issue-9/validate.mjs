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
