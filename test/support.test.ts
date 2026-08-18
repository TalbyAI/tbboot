import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { parseJsonOutput, runCommand } from "./support.ts";

test("captures exit code and keeps stdout and stderr separate", async () => {
	const result = await runCommand({
		file: process.execPath,
		args: [
			"-e",
			"process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
		],
	});

	assert.deepEqual(result, { exitCode: 7, stdout: "out", stderr: "err" });
});

test("rejects and reaps a child process after its timeout", async () => {
	await assert.rejects(
		runCommand({
			file: process.execPath,
			args: ["-e", "setInterval(() => {}, 1_000)"],
			timeoutMs: 50,
		}),
		(error: unknown) => {
			assert(error instanceof Error);
			assert.equal("code" in error ? error.code : undefined, "ETIMEDOUT");
			assert.equal("timeoutMs" in error ? error.timeoutMs : undefined, 50);
			return true;
		},
	);
});

test("starts the command timeout after the readiness marker", async () => {
	const result = await runCommand({
		file: process.execPath,
		args: ["-e", "setTimeout(() => process.stdout.write('READY'), 300)"],
		timeoutMs: 100,
		ready: "READY",
		readyTimeoutMs: 2_000,
	});

	assert.equal(result.exitCode, 0);
});

test("rejects when the readiness marker misses its timeout", async () => {
	await assert.rejects(
		runCommand({
			file: process.execPath,
			args: ["-e", "setTimeout(() => {}, 500)"],
			timeoutMs: 1_000,
			ready: "READY",
			readyTimeoutMs: 50,
		}),
		(error: unknown) => {
			assert(error instanceof Error);
			assert.equal("code" in error ? error.code : undefined, "ETIMEDOUT");
			assert.equal("timeoutMs" in error ? error.timeoutMs : undefined, 50);
			return true;
		},
	);
});

test("rejects child process spawn errors", async () => {
	await assert.rejects(
		runCommand({ file: join(process.cwd(), "__tbboot_missing_command__") }),
		(error: unknown) => {
			assert(error instanceof Error);
			assert.equal("code" in error ? error.code : undefined, "ENOENT");
			return true;
		},
	);
});

test("does not time out after process exit while stdout remains open", async () => {
	const script = [
		"const { spawn } = require('node:child_process')",
		"const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1_500)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true })",
		"holder.unref()",
		"process.stdout.write('done', () => process.exit(0))",
	].join(";");
	const result = await runCommand({
		file: process.execPath,
		args: ["-e", script],
		timeoutMs: 1_000,
	});

	assert.equal(result.exitCode, 0);
});

test("parses exactly one non-empty JSON document", () => {
	assert.deepEqual(parseJsonOutput(' \n{"status":"ok"}\n'), {
		status: "ok",
	});
	assert.throws(() => parseJsonOutput(""), /did not contain a JSON document/);
	assert.throws(() => parseJsonOutput("{}\n{}"), SyntaxError);
});
