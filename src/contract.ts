import { readFileSync } from "node:fs";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { parseAllDocuments } from "yaml";
import { errorMessage } from "./shared.ts";
import type { JsonSchema, StepTypeDefinition } from "./steps.ts";

const schemaId = "https://tbboot.dev/schemas/contract-v1";
const contract = JSON.parse(
	readFileSync(new URL("../schemas/contract-v1.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(contract);

export type DocumentKind =
	| "manifest"
	| "source"
	| "recipe"
	| "catalog"
	| "catalog-registry"
	| "lockfile"
	| "state"
	| "trust";

export type DiagnosticSeverity = "error" | "warning";

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

export type GitSelector = { ref: string } | { from: string; to: string };

export type LocalSourceReference = {
	provider: "local";
	locator: { path: string };
	selector?: Record<string, never>;
	recipes?: string[];
};

export type GitSourceReference = {
	provider: "git";
	locator: { repository: string; path?: string };
	selector?: GitSelector;
	recipes?: string[];
};

export type SourceReference = LocalSourceReference | GitSourceReference;
export type SourceDependency = SourceReference & { name: string };
export type ManifestDocument = { schemaVersion: 1; sources: SourceReference[] };
export type CatalogEntry = {
	title: string;
	description: string;
	keywords: string[];
	source: SourceReference;
};
export type CatalogDocument = { schemaVersion: 1; entries: CatalogEntry[] };
export type CatalogRegistryEntry = { name: string; path: string };
export type CatalogRegistryDocument = {
	schemaVersion: 1;
	catalogs: CatalogRegistryEntry[];
};
export type SourceDocument = {
	schemaVersion: 1;
	dependencies?: SourceDependency[];
};
export type Step = {
	type: string;
	optional?: boolean;
	[key: string]: unknown;
};
export type FileStep = Step & {
	type: "file" | "file-fragment";
	input: string;
	target: string;
};
export type CustomOperation = {
	runtime: "node" | "pwsh";
	selector?: string;
	timeoutSeconds?: number;
	script?: string;
	content?: string;
};
export type CustomStep = Step & {
	type: "custom";
	check: CustomOperation;
	install?: CustomOperation;
	uninstall?: CustomOperation;
};
export type RecipeDocument = {
	schemaVersion: 1;
	steps: Step[];
	requires?: Array<{ source: string; recipe: string }>;
};

export type FileStateEffect = {
	source: SourceReference;
	revision?: string;
	sequence?: number;
	sourceFingerprint: string;
	recipe: string;
	step: number;
	type: "file";
	target: string;
	artifactFingerprint: string;
	created: boolean;
};

export type FileFragmentStateEffect = {
	source: SourceReference;
	revision?: string;
	sequence?: number;
	sourceFingerprint: string;
	recipe: string;
	step: number;
	type: "file-fragment";
	target: string;
	marker: string;
	artifactFingerprint: string;
};

export type CustomStateEffect = {
	source: SourceReference;
	revision?: string;
	sequence?: number;
	sourceFingerprint: string;
	recipe: string;
	step: number;
	type: "custom";
	uninstallSupported: boolean;
};
export type ExtensionStateEffect = {
	source: SourceReference;
	revision?: string;
	sequence?: number;
	sourceFingerprint: string;
	recipe: string;
	step: number;
	type: "extension";
	stepType: string;
	extension: { id: string; version: string; fingerprint?: string };
	optional: boolean;
	state?: import("./steps.ts").JsonValue;
};
export type StateEffect =
	| FileStateEffect
	| FileFragmentStateEffect
	| CustomStateEffect
	| ExtensionStateEffect;
export type StateDocument = { schemaVersion: 1; effects: StateEffect[] };
export type LockEntry =
	| {
			source: GitSourceReference;
			revision: string;
			fingerprint: string;
	  }
	| {
			source: LocalSourceReference;
			revision?: never;
			fingerprint: string;
	  };
export type LockfileDocument = { schemaVersion: 1; sources: LockEntry[] };
export type TrustEntry = {
	source: SourceReference;
	revision?: string;
	fingerprint?: string;
};
export type TrustDocument = { schemaVersion: 1; sources: TrustEntry[] };

export type DocumentByKind = {
	manifest: ManifestDocument;
	source: SourceDocument;
	recipe: RecipeDocument;
	catalog: CatalogDocument;
	"catalog-registry": CatalogRegistryDocument;
	lockfile: LockfileDocument;
	state: StateDocument;
	trust: TrustDocument;
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

export type ValidateStepOptions = Pick<
	ValidateDocumentOptions<"recipe">,
	"document" | "source" | "recipe"
> & { step: number };

type DiagnosticContext = Pick<
	Diagnostic,
	"document" | "path" | "source" | "recipe" | "step"
>;
type SchemaVersionRecord = Record<string, unknown> & { schemaVersion: unknown };

const documentKinds: DocumentKind[] = [
	"manifest",
	"source",
	"recipe",
	"catalog",
	"catalog-registry",
	"lockfile",
	"state",
	"trust",
];

const validators: Partial<Record<DocumentKind, ValidateFunction<unknown>>> =
	Object.assign(
		Object.create(null),
		Object.fromEntries(
			documentKinds.map((kind) => [
				kind,
				ajv.getSchema(`${schemaId}#/$defs/${kind}`),
			]),
		),
	);

if (Object.values(validators).some((validator) => validator === undefined)) {
	throw new Error("The contract does not expose all document schemas");
}

function isSchemaVersionRecord(value: unknown): value is SchemaVersionRecord {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "schemaVersion")
	);
}

function errorParam(error: ErrorObject, key: string): string {
	const params = error.params as Record<string, unknown>;
	const value = params[key];
	return typeof value === "string" ? value : String(value);
}

function diagnostic(
	code: string,
	message: string,
	{ document, path, source, recipe, step }: DiagnosticContext = {},
): Diagnostic {
	return {
		code,
		severity: "error",
		message,
		...(document === undefined ? {} : { document }),
		...(path === undefined ? {} : { path }),
		...(source === undefined ? {} : { source }),
		...(recipe === undefined ? {} : { recipe }),
		...(step === undefined ? {} : { step }),
	};
}

function escapePointerToken(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function errorPath(error: ErrorObject): string {
	if (error.keyword === "additionalProperties") {
		return `${error.instancePath}/${escapePointerToken(errorParam(error, "additionalProperty"))}`;
	}
	if (error.keyword === "required") {
		return `${error.instancePath}/${escapePointerToken(errorParam(error, "missingProperty"))}`;
	}
	if (error.keyword === "dependencies") {
		return `${error.instancePath}/${escapePointerToken(errorParam(error, "property"))}`;
	}
	if (error.keyword === "discriminator") {
		return `${error.instancePath}/${escapePointerToken(errorParam(error, "tag"))}`;
	}
	if (error.keyword === "uniqueItems") {
		return `${error.instancePath}/${errorParam(error, "i")}`;
	}
	return error.instancePath;
}

function schemaMessage(error: ErrorObject): string {
	if (error.keyword === "additionalProperties") {
		return `Unknown field: ${errorParam(error, "additionalProperty")}`;
	}
	if (error.keyword === "discriminator") {
		return `Unsupported ${errorParam(error, "tag")}: ${errorParam(error, "tagValue")}`;
	}
	return error.message ?? "Schema validation failed";
}

function actionableErrors(errors: readonly ErrorObject[]): ErrorObject[] {
	const actionable = errors.filter(
		({ keyword }) => keyword !== "oneOf" && keyword !== "if",
	);
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
	const selections =
		kind === "manifest"
			? (value as ManifestDocument).sources.map(
					(entry, index) => [entry, `/sources/${index}/recipes`] as const,
				)
			: kind === "source"
				? ((value as SourceDocument).dependencies ?? []).map(
						(entry, index) =>
							[entry, `/dependencies/${index}/recipes`] as const,
					)
				: [];

	for (const [entry, path] of selections) {
		if (!Object.hasOwn(entry, "recipes")) continue;
		const recipes = entry.recipes as string[];
		diagnostics.push(
			diagnostic(
				recipes.length === 0 ? "recipes-empty" : "recipes-not-supported",
				recipes.length === 0
					? "recipes must be omitted when no selection is requested"
					: "Recipe selection is not supported in the MVP",
				{ ...context, path },
			),
		);
	}

	if (
		kind === "recipe" &&
		((value as RecipeDocument).requires?.length ?? 0) > 0
	) {
		diagnostics.push(
			diagnostic(
				"requires-not-supported",
				"Recipe requirements are not supported in the MVP",
				{ ...context, path: "/requires" },
			),
		);
	}
	return diagnostics;
}

function stepDiagnosticPath(step: number, path: string): string {
	const suffix = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
	return `/steps/${step - 1}${suffix}`;
}

function completeStepSchema(definition: StepTypeDefinition): JsonSchema {
	const properties =
		definition.schema.properties !== null &&
		typeof definition.schema.properties === "object" &&
		!Array.isArray(definition.schema.properties)
			? (definition.schema.properties as Record<string, unknown>)
			: {};
	const required = Array.isArray(definition.schema.required)
		? definition.schema.required.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	return {
		...definition.schema,
		properties: {
			...properties,
			type: { const: definition.id },
			optional: { type: "boolean" },
		},
		required: [...new Set(["type", ...required])],
	};
}

export function validateStep(
	step: Step,
	definition: StepTypeDefinition,
	context: ValidateStepOptions,
): Diagnostic[] {
	let validator: ValidateFunction<unknown>;
	try {
		validator = ajv.compile(completeStepSchema(definition));
	} catch (error) {
		return [
			diagnostic(
				"step-schema-invalid",
				`Invalid schema for Step type ${definition.id}: ${errorMessage(error)}`,
				{
					document: context.document,
					source: context.source,
					recipe: context.recipe,
					step: context.step,
					path: stepDiagnosticPath(context.step, ""),
				},
			),
		];
	}

	if (!validator(step)) {
		return actionableErrors(validator.errors ?? []).map((error) => {
			const path = stepDiagnosticPath(context.step, errorPath(error));
			return diagnostic("step-schema-validation-failed", schemaMessage(error), {
				document: context.document,
				path,
				source: context.source,
				recipe: context.recipe,
				step: context.step,
			});
		});
	}

	if (definition.semanticValidate === undefined) return [];
	try {
		const semanticDiagnostics = definition.semanticValidate(step) ?? [];
		return semanticDiagnostics.map(({ message, path = "" }) =>
			diagnostic("step-semantic-validation-failed", message, {
				document: context.document,
				path: stepDiagnosticPath(context.step, path),
				source: context.source,
				recipe: context.recipe,
				step: context.step,
			}),
		);
	} catch (error) {
		return [
			diagnostic("step-semantic-validation-failed", errorMessage(error), {
				document: context.document,
				path: stepDiagnosticPath(context.step, ""),
				source: context.source,
				recipe: context.recipe,
				step: context.step,
			}),
		];
	}
}

export function validateDocument<K extends DocumentKind>({
	kind,
	text,
	document,
	source,
	recipe,
}: ValidateDocumentOptions<K>): ValidationResult<DocumentByKind[K]> {
	if (!Object.hasOwn(validators, kind))
		throw new TypeError(`Unsupported document kind: ${kind}`);
	const validator = validators[kind] as ValidateFunction<unknown>;
	let yamlDocuments: ReturnType<typeof parseAllDocuments>;
	try {
		yamlDocuments = parseAllDocuments(text, {
			schema: "core",
			uniqueKeys: true,
			version: "1.2",
		});
	} catch (error) {
		return {
			value: undefined,
			diagnostics: [
				diagnostic("yaml-parse-error", errorMessage(error), {
					document,
					source,
					recipe,
				}),
			],
		};
	}

	const yaml11Directive = yamlDocuments.some(
		({ directives }) => directives?.yaml?.version === "1.1",
	);
	if (
		yaml11Directive ||
		yamlDocuments.length !== 1 ||
		yamlDocuments[0].errors.length > 0 ||
		yamlDocuments[0].contents === null
	) {
		const message = yaml11Directive
			? "YAML 1.1 is not supported"
			: yamlDocuments.length === 0
				? "Expected one non-empty YAML document"
				: yamlDocuments.length > 1
					? "Expected exactly one YAML document"
					: (yamlDocuments[0].errors[0]?.message ??
						"Expected a non-empty YAML document");
		return {
			value: undefined,
			diagnostics: [
				diagnostic("yaml-parse-error", message, { document, source, recipe }),
			],
		};
	}

	const yamlDocument = yamlDocuments[0] as ReturnType<
		typeof parseAllDocuments
	>[number];
	const value: unknown = yamlDocument.toJS();
	if (!isSchemaVersionRecord(value)) {
		return {
			value: undefined,
			diagnostics: [
				diagnostic("schema-version-missing", "Missing required schemaVersion", {
					document,
					path: "/schemaVersion",
					source,
					recipe,
				}),
			],
		};
	}
	if (value.schemaVersion !== 1) {
		let schemaVersion: string | undefined;
		try {
			schemaVersion = JSON.stringify(value.schemaVersion);
		} catch {
			schemaVersion = String(value.schemaVersion);
		}
		return {
			value: undefined,
			diagnostics: [
				diagnostic(
					"schema-version-unsupported",
					`Unsupported schemaVersion: ${schemaVersion}`,
					{ document, path: "/schemaVersion", source, recipe },
				),
			],
		};
	}

	const valid = validator(value);
	if (!valid) {
		const diagnostics = actionableErrors(validator.errors ?? []).map(
			(error) => {
				const path = errorPath(error);
				return diagnostic("schema-validation-failed", schemaMessage(error), {
					document,
					path,
					source,
					recipe,
					step: stepFromPath(path),
				});
			},
		);
		return { value: undefined, diagnostics };
	}

	const documentValue = value as DocumentByKind[K];
	const diagnostics = reservedDiagnostics(kind, documentValue, {
		document,
		source,
		recipe,
	});
	return {
		value: diagnostics.length === 0 ? documentValue : undefined,
		diagnostics,
	};
}
