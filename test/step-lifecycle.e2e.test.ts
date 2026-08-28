import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
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

function abortAfterAwait(controller: AbortController): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(() => {
			controller.abort();
			resolve();
		});
	});
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

test("doctor passes persisted registered Step state to a later check", async () => {
	const type = "team.test.doctor-state";
	const checkedStates: unknown[] = [];
	registerStepType(
		definition(type, () => ({
			install: async () => ({
				status: "ok",
				changed: true,
				state: { installed: true },
			}),
			check: async (_context, state) => {
				checkedStates.push(state);
				return { status: "ok", changed: false };
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);
		await writeFile(
			join(fixture.root, "consumer", "tbboot.yaml"),
			"schemaVersion: 1\nsources:\n  - provider: local\n    locator:\n      path: ../source/\n",
		);

		const doctor = await runDoctor(join(fixture.root, "consumer"));
		assert.equal(doctor.exitCode, 0);
		assert.deepEqual(checkedStates, [{ installed: true }, { installed: true }]);
	} finally {
		await fixture.cleanup();
	}
});

test("persists state returned by a check-only Step", async () => {
	const type = "team.test.check-only-state";
	registerStepType(
		definition(type, () => ({
			check: async () => ({
				status: "ok",
				changed: false,
				state: { checked: true },
			}),
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);
		const state = parse(
			await readFile(
				join(fixture.root, "consumer", ".tbboot", "state.yaml"),
				"utf8",
			),
		) as { effects: Array<{ state?: unknown }> };
		assert.deepEqual(
			state.effects.map((effect) => effect.state),
			[{ checked: true }],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("persists newer state returned by a Step check", async () => {
	const type = "team.test.check-state-update";
	registerStepType(
		definition(type, () => ({
			install: async () => ({
				status: "ok",
				changed: true,
				state: { installed: true },
			}),
			check: async () => ({
				status: "ok",
				changed: false,
				state: { checked: true },
			}),
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);
		const state = parse(
			await readFile(
				join(fixture.root, "consumer", ".tbboot", "state.yaml"),
				"utf8",
			),
		) as { effects: Array<{ state?: unknown }> };
		assert.deepEqual(
			state.effects.map((effect) => effect.state),
			[{ checked: true }],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("does not pass state from a different extension identity", async () => {
	const type = "team.test.doctor-extension-identity";
	const checkedStates: unknown[] = [];
	const installedStates: unknown[] = [];
	const registered = definition(type, () => ({
		install: async (_context, state) => {
			installedStates.push(state);
			return {
				status: "ok",
				changed: true,
				state: { installed: true },
			};
		},
		check: async (_context, state) => {
			checkedStates.push(state);
			return { status: "ok", changed: false };
		},
	}));
	registerStepType(registered);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);

		registered.extension = { id: "team.tbboot.tests", version: "2.0.0" };
		const doctor = await runDoctor(join(fixture.root, "consumer"));
		assert.equal(doctor.exitCode, 0);
		assert.deepEqual(checkedStates, [{ installed: true }, undefined]);

		const update = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(update.exitCode, 0);
		assert.deepEqual(installedStates, [undefined, undefined]);
	} finally {
		await fixture.cleanup();
	}
});

test("uninstall matches persisted extension identity fields regardless of order", async () => {
	const type = "team.test.reordered-extension-identity";
	const uninstalledStates: unknown[] = [];
	registerStepType(
		definition(type, () => ({
			install: async () => ({
				status: "ok",
				changed: true,
				state: { installed: true },
			}),
			check: async () => ({ status: "ok", changed: false }),
			uninstall: async (_context, state) => {
				uninstalledStates.push(state);
				return { status: "ok", changed: true };
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);
		const state = parse(
			await readFile(
				join(fixture.root, "consumer", ".tbboot", "state.yaml"),
				"utf8",
			),
		) as {
			effects: Array<{
				extension: { id: string; version: string };
				state: unknown;
			}>;
		};
		const effect = state.effects[0];
		assert.ok(effect);
		state.effects[0] = {
			...effect,
			extension: {
				version: effect.extension.version,
				id: effect.extension.id,
			},
		};
		await writeFile(
			join(fixture.root, "consumer", ".tbboot", "state.yaml"),
			stringify(state),
		);

		const uninstall = await runUninstall(join(fixture.root, "consumer"), {});
		assert.equal(uninstall.exitCode, 0);
		assert.deepEqual(uninstalledStates, [{ installed: true }]);
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

test("persists an install-only Step effect so uninstall can run without check", async () => {
	const type = "team.test.install-only";
	let uninstalled = false;
	registerStepType(
		definition(type, () => ({
			install: async () => ({
				status: "ok",
				changed: true,
				state: { installed: true },
			}),
			uninstall: async (_context, state) => {
				assert.deepEqual(state, { installed: true });
				uninstalled = true;
				return { status: "ok", changed: true };
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);

		const uninstall = await runUninstall(join(fixture.root, "consumer"), {});
		assert.equal(uninstall.exitCode, 0);
		assert.equal(uninstall.envelope.actions[0]?.state, "removed");
		assert.equal(uninstalled, true);
		const state = parse(
			await readFile(
				join(fixture.root, "consumer", ".tbboot", "state.yaml"),
				"utf8",
			),
		) as { effects: unknown[] };
		assert.deepEqual(state.effects, []);
	} finally {
		await fixture.cleanup();
	}
});

test("reports Step cancellation during registered uninstall with exit code 130", async () => {
	const type = "team.test.cancelled-uninstall";
	registerStepType(
		definition(type, () => ({
			install: async () => ({
				status: "ok",
				changed: true,
				state: { installed: true },
			}),
			uninstall: async () => {
				throw Object.assign(new Error("cancelled"), { code: "cancelled" });
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);

		const uninstall = await runUninstall(join(fixture.root, "consumer"), {});
		assert.equal(uninstall.exitCode, 130);
		assert.equal(uninstall.envelope.diagnostics[0]?.code, "step-cancelled");
	} finally {
		await fixture.cleanup();
	}
});

test("reports cancellation when a registered doctor check returns after abort", async () => {
	const type = "team.test.cancelled-doctor";
	const controller = new AbortController();
	registerStepType(
		definition(type, () => ({
			check: async () => {
				await abortAfterAwait(controller);
				return { status: "ok", changed: false };
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const result = await runDoctor(join(fixture.root, "consumer"), {
			signal: controller.signal,
		});
		assert.equal(result.exitCode, 130);
		assert.equal(result.envelope.diagnostics[0]?.code, "step-cancelled");
	} finally {
		await fixture.cleanup();
	}
});

test("reports cancellation when a registered install returns after abort", async () => {
	const type = "team.test.cancelled-install";
	const controller = new AbortController();
	registerStepType(
		definition(type, () => ({
			install: async () => {
				await abortAfterAwait(controller);
				return {
					status: "ok",
					changed: true,
					state: { installed: true },
				};
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const result = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
			signal: controller.signal,
		});
		assert.equal(result.exitCode, 130);
		assert.equal(result.envelope.diagnostics[0]?.code, "step-cancelled");
	} finally {
		await fixture.cleanup();
	}
});

test("reports cancellation when a registered uninstall returns after abort", async () => {
	const type = "team.test.cancelled-uninstall-return";
	const controller = new AbortController();
	registerStepType(
		definition(type, () => ({
			install: async () => ({
				status: "ok",
				changed: true,
				state: { installed: true },
			}),
			uninstall: async () => {
				await abortAfterAwait(controller);
				return { status: "ok", changed: true };
			},
		})),
	);
	const fixture = await createFixture(
		`  - type: ${type}\n    value: maintained\n`,
	);
	try {
		const install = await runInstall(join(fixture.root, "consumer"), {
			dryRun: false,
			force: false,
		});
		assert.equal(install.exitCode, 0);

		const result = await runUninstall(join(fixture.root, "consumer"), {
			signal: controller.signal,
		});
		assert.equal(result.exitCode, 130);
		assert.equal(result.envelope.diagnostics[0]?.code, "step-cancelled");
	} finally {
		await fixture.cleanup();
	}
});
