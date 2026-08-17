import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { parseAllDocuments } from 'yaml';

const schemaId = 'https://tbboot.dev/schemas/contract-v1';
const contract = JSON.parse(readFileSync(new URL('../schemas/contract-v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(contract);

export type DocumentKind =
  | 'manifest'
  | 'source'
  | 'recipe'
  | 'catalog'
  | 'lockfile'
  | 'state'
  | 'trust';

export type DiagnosticSeverity = 'error' | 'warning';

export type Diagnostic = {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  document?: string;
  path?: string;
  source?: string;
  recipe?: string;
  step?: number;
};

export type LocalSourceReference = {
  provider: 'local';
  locator: { path: string };
  recipes?: string[];
};

export type GitSourceReference = {
  provider: 'git';
  locator: { repository: string; path?: string };
  recipes?: string[];
};

export type SourceReference = LocalSourceReference | GitSourceReference;
export type SourceDependency = SourceReference & { name: string };
export type ManifestDocument = { schemaVersion: 1; sources: SourceReference[] };
export type SourceDocument = { schemaVersion: 1; dependencies?: SourceDependency[] };
export type FileStep = {
  type: 'file' | 'file-fragment';
  input: string;
  target: string;
  optional?: boolean;
};
export type CustomStep = { type: 'custom'; optional?: boolean; check: unknown };
export type Step = FileStep | CustomStep;
export type RecipeDocument = {
  schemaVersion: 1;
  steps: Step[];
  requires?: Array<{ source: string; recipe: string }>;
};

export type DocumentByKind = {
  manifest: ManifestDocument;
  source: SourceDocument;
  recipe: RecipeDocument;
  catalog: Record<string, unknown>;
  lockfile: Record<string, unknown>;
  state: Record<string, unknown>;
  trust: Record<string, unknown>;
};

export type ValidationResult<T = DocumentByKind[DocumentKind]> = {
  value?: T;
  diagnostics: Diagnostic[];
};

export type ValidateDocumentOptions<K extends DocumentKind = DocumentKind> = {
  kind: K;
  text: string;
  document: string;
  source?: string;
  recipe?: string;
};

type DiagnosticContext = Pick<Diagnostic, 'document' | 'path' | 'source' | 'recipe' | 'step'>;
type SchemaVersionRecord = Record<string, unknown> & { schemaVersion: unknown };

const documentKinds: DocumentKind[] = ['manifest', 'source', 'recipe', 'catalog', 'lockfile', 'state', 'trust'];

const validators: Partial<Record<DocumentKind, ValidateFunction<unknown>>> = Object.assign(
  Object.create(null),
  Object.fromEntries(documentKinds.map((kind) => [kind, ajv.getSchema(`${schemaId}#/$defs/${kind}`)])),
);

if (Object.values(validators).some((validator) => validator === undefined)) {
  throw new Error('The contract does not expose all document schemas');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSchemaVersionRecord(value: unknown): value is SchemaVersionRecord {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.hasOwn(value, 'schemaVersion');
}

function errorParam(error: ErrorObject, key: string): string {
  const params = error.params as Record<string, unknown>;
  const value = params[key];
  return typeof value === 'string' ? value : String(value);
}

function diagnostic(code: string, message: string, { document, path, source, recipe, step }: DiagnosticContext = {}): Diagnostic {
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

function escapePointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function errorPath(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') {
    return `${error.instancePath}/${escapePointerToken(errorParam(error, 'additionalProperty'))}`;
  }
  if (error.keyword === 'required') {
    return `${error.instancePath}/${escapePointerToken(errorParam(error, 'missingProperty'))}`;
  }
  if (error.keyword === 'dependencies') {
    return `${error.instancePath}/${escapePointerToken(errorParam(error, 'property'))}`;
  }
  if (error.keyword === 'discriminator') {
    return `${error.instancePath}/${escapePointerToken(errorParam(error, 'tag'))}`;
  }
  if (error.keyword === 'uniqueItems') {
    return `${error.instancePath}/${errorParam(error, 'i')}`;
  }
  return error.instancePath;
}

function schemaMessage(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') {
    return `Unknown field: ${errorParam(error, 'additionalProperty')}`;
  }
  if (error.keyword === 'discriminator') {
    return `Unsupported ${errorParam(error, 'tag')}: ${errorParam(error, 'tagValue')}`;
  }
  return error.message ?? 'Schema validation failed';
}

function actionableErrors(errors: readonly ErrorObject[]): ErrorObject[] {
  const actionable = errors.filter(({ keyword }) => keyword !== 'oneOf' && keyword !== 'if');
  return actionable.length > 0 ? actionable : [...errors];
}

function stepFromPath(path: string): number | undefined {
  const match = /^\/steps\/(\d+)(?:\/|$)/.exec(path);
  return match ? Number(match[1]) + 1 : undefined;
}

function reservedDiagnostics<K extends DocumentKind>(
  kind: K,
  value: DocumentByKind[K],
  context: DiagnosticContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const selections = kind === 'manifest'
    ? (value as ManifestDocument).sources.map((entry, index) => [entry, `/sources/${index}/recipes`] as const)
    : kind === 'source'
      ? ((value as SourceDocument).dependencies ?? [])
        .map((entry, index) => [entry, `/dependencies/${index}/recipes`] as const)
      : [];

  for (const [entry, path] of selections) {
    if (!Object.hasOwn(entry, 'recipes')) continue;
    const recipes = entry.recipes as string[];
    diagnostics.push(diagnostic(
      recipes.length === 0 ? 'recipes-empty' : 'recipes-not-supported',
      recipes.length === 0
        ? 'recipes must be omitted when no selection is requested'
        : 'Recipe selection is not supported in the MVP',
      { ...context, path },
    ));
  }

  if (kind === 'recipe' && (((value as RecipeDocument).requires?.length) ?? 0) > 0) {
    diagnostics.push(diagnostic(
      'requires-not-supported',
      'Recipe requirements are not supported in the MVP',
      { ...context, path: '/requires' },
    ));
  }
  return diagnostics;
}

export function validateDocument<K extends DocumentKind>({
  kind,
  text,
  document,
  source,
  recipe,
}: ValidateDocumentOptions<K>): ValidationResult<DocumentByKind[K]> {
  if (!Object.hasOwn(validators, kind)) throw new TypeError(`Unsupported document kind: ${kind}`);
  const validator = validators[kind] as ValidateFunction<unknown>;
  let yamlDocuments: ReturnType<typeof parseAllDocuments>;
  try {
    yamlDocuments = parseAllDocuments(text, {
      schema: 'core',
      uniqueKeys: true,
      version: '1.2',
    });
  } catch (error) {
    return {
      value: undefined,
      diagnostics: [diagnostic('yaml-parse-error', errorMessage(error), { document, source, recipe })],
    };
  }

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

  const yamlDocument = yamlDocuments[0] as ReturnType<typeof parseAllDocuments>[number];
  const value: unknown = yamlDocument.toJS();
  if (!isSchemaVersionRecord(value)) {
    return { value: undefined, diagnostics: [diagnostic(
      'schema-version-missing',
      'Missing required schemaVersion',
      { document, path: '/schemaVersion', source, recipe },
    )] };
  }
  if (value.schemaVersion !== 1) {
    let schemaVersion: string | undefined;
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
    const diagnostics = actionableErrors(validator.errors ?? []).map((error) => {
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

  const documentValue = value as DocumentByKind[K];
  const diagnostics = reservedDiagnostics(kind, documentValue, { document, source, recipe });
  return { value: diagnostics.length === 0 ? documentValue : undefined, diagnostics };
}
