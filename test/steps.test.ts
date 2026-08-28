import assert from "node:assert/strict";
import test from "node:test";
import { type StepTypeDefinition, StepTypeRegistry } from "../src/steps.ts";

function makeDefinition(id: string): StepTypeDefinition {
	return {
		id,
		apiVersion: 1,
		extension: { id: "team.tbboot", version: "1.0.0" },
		schema: { type: "object" },
		behavior: "declarative",
		capabilities: [],
		execution: { inProcess: true },
		createExecutor: () => ({}),
	};
}

test("resolves a statically registered Step type", () => {
	const registry = new StepTypeRegistry();
	const definition = makeDefinition("team.example");
	registry.register(definition);
	assert.equal(registry.get("team.example"), definition);
});

test("rejects duplicate Step type IDs without replacing the first definition", () => {
	const registry = new StepTypeRegistry();
	const first = makeDefinition("team.example");
	registry.register(first);
	assert.throws(
		() => registry.register(makeDefinition("team.example")),
		/already registered/,
	);
	assert.equal(registry.get("team.example"), first);
});

test("returns undefined for an unknown Step type", () => {
	assert.equal(new StepTypeRegistry().get("missing"), undefined);
});
