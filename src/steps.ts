import type { RecipeDocument, Step } from "./contract.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonSchema = Record<string, unknown>;
export type Capability = string;

export type ExtensionIdentity = {
	id: string;
	version: string;
	fingerprint?: string;
};

export type SemanticDiagnostic = {
	message: string;
	path?: string;
};

export type SemanticValidator = (
	step: Step,
) => readonly SemanticDiagnostic[] | undefined;

export type RuntimeRequirement = {
	id: string;
	version?: string;
	capabilities?: readonly Capability[];
};

export type StepExecutionDefinition = {
	inProcess?: boolean;
	outOfProcess?: {
		entrypoint: string;
		runtimes: readonly RuntimeRequirement[];
	};
};

export type StepExecutionContext = {
	recipe: RecipeDocument;
	step: Step;
	source?: {
		identity: string;
		revision?: string;
		fingerprint?: string;
	};
	mode: "in-process" | "out-of-process";
	runtime?: unknown;
	services: Readonly<Record<string, unknown>>;
	capabilities: readonly Capability[];
	cancellation: {
		signal: AbortSignal;
	};
};

export type StepResult = {
	status: "ok" | "missing" | "drift" | "error";
	changed: boolean;
	message?: string;
	details?: JsonValue;
	state?: JsonValue;
};

export type StepOperation = (
	context: StepExecutionContext,
	state?: JsonValue,
) => Promise<StepResult>;

export type StepExecutor = {
	check?: StepOperation;
	install?: StepOperation;
	uninstall?: StepOperation;
};

export type StepTypeDefinition = {
	id: string;
	apiVersion: number;
	extension: ExtensionIdentity;
	schema: JsonSchema;
	semanticValidate?: SemanticValidator;
	behavior: "declarative" | "arbitrary-instance";
	capabilities: readonly Capability[];
	execution: StepExecutionDefinition;
	createExecutor: (step: Step, context: StepExecutionContext) => StepExecutor;
};

export class StepTypeRegistryError extends Error {
	readonly code: "invalid-id" | "duplicate-id";

	constructor(code: "invalid-id" | "duplicate-id", message: string) {
		super(message);
		this.name = "StepTypeRegistryError";
		this.code = code;
	}
}

export class StepTypeRegistry {
	private readonly definitions = new Map<string, StepTypeDefinition>();

	register(definition: StepTypeDefinition): void {
		if (typeof definition.id !== "string" || definition.id.length === 0) {
			throw new StepTypeRegistryError(
				"invalid-id",
				"Step type ID must be a non-empty string",
			);
		}
		if (this.definitions.has(definition.id)) {
			throw new StepTypeRegistryError(
				"duplicate-id",
				`Step type ${definition.id} is already registered`,
			);
		}
		this.definitions.set(definition.id, definition);
	}

	get(typeId: string): StepTypeDefinition | undefined {
		return this.definitions.get(typeId);
	}
}

const commonStepProperties = {
	type: { type: "string", minLength: 1 },
	optional: { type: "boolean" },
};

function fileSchema(type: "file" | "file-fragment"): JsonSchema {
	return {
		type: "object",
		required: ["type", "input", "target"],
		properties: {
			...commonStepProperties,
			type: { const: type },
			input: {
				type: "string",
				minLength: 1,
				pattern: "^(?![A-Za-z]:)(?![\\\\/]|~(?:[\\\\/]|$)).+",
			},
			target: {
				type: "string",
				minLength: 1,
				pattern:
					"^(?![A-Za-z]:)(?![\\\\/]|~(?:[\\\\/]|$))(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+",
			},
		},
		additionalProperties: false,
	};
}

const customOperationSchema = {
	type: "object",
	required: ["runtime"],
	properties: {
		runtime: { enum: ["node", "pwsh"] },
		selector: { type: "string", minLength: 1 },
		timeoutSeconds: { type: "integer", minimum: 1 },
		script: { type: "string", minLength: 1 },
		content: { type: "string", minLength: 1 },
	},
	oneOf: [
		{ required: ["script"], properties: { script: true, content: false } },
		{ required: ["content"], properties: { script: false, content: true } },
	],
	additionalProperties: false,
};

function builtinDefinition(
	id: "file" | "file-fragment" | "custom",
): StepTypeDefinition {
	const schema =
		id === "custom"
			? {
					type: "object",
					required: ["type", "check"],
					properties: {
						...commonStepProperties,
						type: { const: "custom" },
						check: customOperationSchema,
						install: customOperationSchema,
						uninstall: customOperationSchema,
					},
					dependencies: { uninstall: ["install"] },
					additionalProperties: false,
				}
			: fileSchema(id);
	return {
		id,
		apiVersion: 1,
		extension: { id: "tbboot", version: "0.1.0" },
		schema,
		behavior: id === "custom" ? "arbitrary-instance" : "declarative",
		capabilities: [],
		execution: { inProcess: true },
		createExecutor: () => ({}),
	};
}

export function createBuiltinStepTypeRegistry(): StepTypeRegistry {
	const registry = new StepTypeRegistry();
	registry.register(builtinDefinition("file"));
	registry.register(builtinDefinition("file-fragment"));
	registry.register(builtinDefinition("custom"));
	return registry;
}

export const stepTypeRegistry = createBuiltinStepTypeRegistry();

export function registerStepType(definition: StepTypeDefinition): void {
	stepTypeRegistry.register(definition);
}
