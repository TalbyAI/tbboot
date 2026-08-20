import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type CustomContext,
	detectRuntime,
	prepareCustomStep,
	runHandler,
} from "../src/custom.ts";

const hasPwsh = await detectRuntime("pwsh")
	.then((runtime) => runtime.status === "compatible")
	.catch(() => false);

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

async function processExists(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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

test("runs an inline PowerShell Custom handler through the JSON protocol", {
	skip: !hasPwsh,
}, async () => {
	const outcome = await runHandler({
		runtime: "pwsh",
		content:
			"return @{ status = 'ok'; changed = $false; details = @{ operation = $Request.operation } }",
		request: { operation: "check" },
		cwd: process.cwd(),
	});

	assert.deepEqual(outcome.result, {
		status: "ok",
		changed: false,
		details: { operation: "check" },
	});
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

test("terminates descendants of timed-out handlers", async () => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-tree-"));
	const pidFile = join(root, "child.pid");
	let childPid: number | undefined;
	try {
		await assert.rejects(
			runHandler({
				runtime: "node",
				content: [
					"const { spawn } = await import('node:child_process');",
					"const { writeFile } = await import('node:fs/promises');",
					"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
					"await writeFile(request.pidFile, String(child.pid));",
					"await new Promise(() => {});",
				].join("\n"),
				request: { pidFile },
				cwd: process.cwd(),
				timeoutMs: 500,
			}),
			(error: unknown) =>
				error instanceof Error && "code" in error && error.code === "timeout",
		);
		childPid = Number(await readFile(pidFile, "utf8"));
		assert.equal(
			await waitFor(
				() => processExists(childPid as number).then((exists) => !exists),
				2_000,
			),
			true,
		);
	} finally {
		if (childPid !== undefined && (await processExists(childPid))) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {
				// The process exited between the existence check and cleanup.
			}
		}
		await rm(root, { recursive: true, force: true });
	}
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
	await assert.rejects(
		prepareCustomStep(
			{
				type: "custom",
				check: { runtime: "node", script: "missing.js" },
			},
			context,
		),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "custom-script-missing",
	);
	await assert.rejects(
		prepareCustomStep(
			{
				type: "custom",
				check: {
					runtime: "node",
					selector: ">=999.0 <1000",
					script: "data:text/javascript,return%20{}",
				},
			},
			context,
		),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "custom-script-invalid",
	);
});

test("rejects Custom results with a non-string message", async () => {
	await assert.rejects(
		runHandler({
			runtime: "node",
			content: "return { status: 'ok', changed: false, message: 123 };",
			request: {},
			cwd: process.cwd(),
		}),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "invalid-result",
	);
});
