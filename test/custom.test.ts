import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type CustomContext,
	prepareCustomStep,
	runHandler,
} from "../src/custom.ts";

test("runs an inline Node Custom handler through the JSON protocol", async () => {
	const outcome = await runHandler({
		runtime: "node",
		content:
			"console.error('custom-log:' + request.operation); return { status: 'ok', changed: false, details: { operation: request.operation } };",
		request: { operation: "check" },
		cwd: process.cwd(),
	});

	assert.deepEqual(outcome.result, {
		status: "ok",
		changed: false,
		details: { operation: "check" },
	});
	assert.equal(outcome.stderr, "custom-log:check\n");
});

test("rejects invalid protocol output and terminates timed-out handlers", async () => {
	await assert.rejects(
		runHandler({
			runtime: "node",
			content:
				"process.stdout.write('not-json'); return { status: 'ok', changed: false };",
			request: {},
			cwd: process.cwd(),
		}),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "invalid-result",
	);
	await assert.rejects(
		runHandler({
			runtime: "node",
			content: "await new Promise(() => {});",
			request: {},
			cwd: process.cwd(),
			timeoutMs: 50,
		}),
		(error: unknown) =>
			error instanceof Error && "code" in error && error.code === "timeout",
	);
});

test("rejects Custom scripts that escape the Source root", async () => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-"));
	const sourceRoot = join(root, "source");
	const recipeRoot = join(sourceRoot, "recipe");
	await writeFile(
		join(root, "outside.js"),
		"export default async () => ({ status: 'ok', changed: false });",
	);
	const context: CustomContext = {
		consumerRoot: root,
		sourceRoot,
		recipeRoot,
		recipe: "recipe",
		step: 1,
		source: { provider: "local", locator: { path: sourceRoot } },
		sourceFingerprint: "test",
	};
	await assert.rejects(
		prepareCustomStep(
			{
				type: "custom",
				check: { runtime: "node", script: "../../outside.js" },
			},
			context,
			{ allowCustom: [sourceRoot] },
		),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "custom-script-escape",
	);
});
