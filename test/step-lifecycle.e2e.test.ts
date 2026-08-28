import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDoctor } from "../src/doctor.ts";
import { runInstall, runUninstall } from "../src/install.ts";
import {
	registerStepType,
	type StepExecutionContext,
	type StepTypeDefinition,
} from "../src/steps.ts";

async function createFixture(step: string): Promise<{
	root: string;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "tbboot-step-type-"));
	const consumer = join(root, "consumer");
	const source = join(root, "source");
	await mkdir(join(source, "baseline"), { recursive: true });
	await mkdir(consumer);
	await writeFile(
		join(consumer, "tbboot.yaml"),
		"schemaVersion: 1\nsources:\n  - provider: local\n    locator:\n      path: ../source\n",
	);
	await writeFile(join(source, "source.yaml"), "schemaVersion: 1\n");
	await writeFile(
		join(source, "baseline", "recipe.yaml"),
		`schemaVersion: 1\nsteps:\n${step}\n`,
	);
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function definition(
	id: string,
	createExecutor: StepTypeDefinition["createExecutor"],
): StepTypeDefinition {
	return {
		id,
		apiVersion: 1,
		extension: { id: "team.tbboot.tests", version: "1.0.0" },
		schema: {
			type: "object",
			required: ["type", "value"],
			properties: {
				type: { const: id },
				value: { type: "string", minLength: 1 },
				optional: { type: "boolean" },
			},
			additionalProperties: false,
		},
		behavior: "declarative",
		capabilities: [],
		execution: { inProcess: true },
		createExecutor,
	};
}

test("the host creates and executes one registered Step executor per instance", async () => {
	const type = "team.test.lifecycle";
	let created = 0;
	const contexts: StepExecutionContext[] = [];
	registerStepType(
		definition(type, (step, context) => {
			created += 1;
			contexts.push(context);
			assert.equal(step, context.step);
			return {
				install: async (executionContext) => {
					assert.equal(executionContext, context);
					return {
						status: "ok",
						changed: true,
						state: { installed: true },
					};
				},
				check: async (executionContext, state) => {
					assert.equal(executionContext.step, context.step);
					if (state !== undefined) assert.deepEqual(state, { installed: true });
					return { status: "ok", changed: false };
				},
				uninstall: async (executionContext, state) => {
					assert.equal(executionContext.step, context.step);
					assert.deepEqual(state, { installed: true });
					return { status: "ok", changed: true };
				},
			};
		}),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const doctor = await runDoctor(join(fixture.root, "consumer"));
		assert.equal(doctor.exitCode, 0);
		assert.equal(doctor.envelope.actions[0]?.type, type);
		assert.equal(doctor.envelope.actions[0]?.state, "ok");
		assert.equal(created, 1);
		assert.equal(contexts[0]?.step.type, type);
		assert.equal(contexts[0]?.mode, "in-process");

		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);
		assert.equal(install.envelope.actions[0]?.state, "ok");
		assert.equal(install.envelope.changed, true);
		assert.equal(created, 2);

		const uninstall = await runUninstall(join(fixture.root, "consumer"), {});
		assert.equal(uninstall.exitCode, 0);
		assert.equal(uninstall.envelope.actions[0]?.type, type);
		assert.equal(uninstall.envelope.actions[0]?.state, "removed");
		assert.equal(uninstall.envelope.changed, true);
		assert.equal(created, 3);
	} finally {
		await fixture.cleanup();
	}
});

test("unknown required and optional Step types keep host optionality", async () => {
	for (const [optional, exitCode, severity] of [
		[false, 1, "error"],
		[true, 0, "warning"],
	] as const) {
		const fixture = await createFixture(
			`  - type: team.test.unknown\n    value: ignored\n${optional ? "    optional: true\n" : ""}`,
		);
		try {
			const result = await runDoctor(join(fixture.root, "consumer"));
			assert.equal(result.exitCode, exitCode);
			assert.equal(result.envelope.diagnostics[0]?.code, "step-type-unknown");
			assert.equal(result.envelope.diagnostics[0]?.severity, severity);
			assert.equal(result.envelope.actions.length, 0);
		} finally {
			await fixture.cleanup();
		}
	}
});

test("a registered Step schema error remains fatal even when optional", async () => {
	const type = "team.test.invalid";
	registerStepType(
		definition(type, () => ({
			check: async () => ({ status: "ok", changed: false }),
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    optional: true\n`,
	);
	try {
		const result = await runDoctor(join(fixture.root, "consumer"));
		assert.equal(result.exitCode, 1);
		assert.equal(
			result.envelope.diagnostics[0]?.code,
			"step-schema-validation-failed",
		);
		assert.equal(result.envelope.diagnostics[0]?.severity, "error");
	} finally {
		await fixture.cleanup();
	}
});
