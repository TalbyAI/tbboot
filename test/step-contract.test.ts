import assert from "node:assert/strict";
import test from "node:test";
import { validateDocument, validateStep } from "../src/contract.ts";
import type { StepTypeDefinition } from "../src/steps.ts";

function makeDefinition(
	semanticValidate?: StepTypeDefinition["semanticValidate"],
): StepTypeDefinition {
	return {
		id: "team.template",
		apiVersion: 1,
		extension: { id: "team.tbboot", version: "1.0.0" },
		schema: {
			type: "object",
			required: ["type", "target", "template"],
			properties: {
				type: { const: "team.template" },
				target: { type: "string", minLength: 1 },
				template: { type: "string", minLength: 1 },
				optional: { type: "boolean" },
			},
			additionalProperties: false,
		},
		semanticValidate,
		behavior: "declarative",
		capabilities: [],
		execution: { inProcess: true },
		createExecutor: () => ({}),
	};
}

test("parses an extension Step with first-level fields", () => {
	const result = validateDocument({
		kind: "recipe",
		text: [
			"schemaVersion: 1",
			"steps:",
			"  - type: team.template",
			"    target: README.md",
			"    template: README.template",
			"",
		].join("\n"),
		document: "recipe.yaml",
	});
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.value);
	assert.equal(
		(result.value.steps[0] as Record<string, unknown>).template,
		"README.template",
	);
});

test("validates a complete Step against its registered schema", () => {
	const diagnostics = validateStep(
		{ type: "team.template", target: "README.md" },
		makeDefinition(),
		{ document: "recipe.yaml", step: 1 },
	);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]?.code, "step-schema-validation-failed");
	assert.equal(diagnostics[0]?.path, "/steps/0/template");
});

test("semantic validation can add errors after structural validation", () => {
	const diagnostics = validateStep(
		{
			type: "team.template",
			target: "README.md",
			template: "README.md",
		},
		makeDefinition(() => [
			{ message: "Template must not equal target", path: "/template" },
		]),
		{ document: "recipe.yaml", step: 2 },
	);
	assert.deepEqual(diagnostics, [
		{
			code: "step-semantic-validation-failed",
			severity: "error",
			message: "Template must not equal target",
			document: "recipe.yaml",
			path: "/steps/1/template",
			step: 2,
		},
	]);
});
