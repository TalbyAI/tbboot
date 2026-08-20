import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
	type CustomAuthorizationOptions,
	type CustomContext,
	detectRuntime,
	prepareCustomStep,
	runHandler,
	sourceFingerprint,
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
		assert.equal(
			await waitFor(
				() =>
					readFile(pidFile)
						.then(() => true)
						.catch(() => false),
				2_000,
			),
			true,
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
	await mkdir(recipeRoot, { recursive: true });
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
				check: { runtime: "node", script: "." },
			},
			context,
			{ allowCustom: [sourceRoot] },
		),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "custom-script-not-file",
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

test("temporary interactive authorization does not persist trust", async () => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-trust-"));
	const sourceRoot = join(root, "source");
	const profileRoot = join(root, "profile");
	const originalStdin = process.stdin;
	await mkdir(join(sourceRoot, "recipe"), { recursive: true });
	await mkdir(profileRoot);
	Object.defineProperty(process, "stdin", {
		configurable: true,
		value: Readable.from(["y\n"]),
	});
	try {
		await prepareCustomStep(
			{
				type: "custom",
				check: {
					runtime: "node",
					content: "return { status: 'ok', changed: false };",
				},
			},
			{
				consumerRoot: root,
				sourceRoot,
				recipeRoot: join(sourceRoot, "recipe"),
				recipe: "recipe",
				step: 1,
				source: { provider: "local", locator: { path: sourceRoot } },
				sourceFingerprint: "source-fingerprint",
			},
			{
				profileRoot,
				interactive: true,
				persistTrust: false,
			} satisfies CustomAuthorizationOptions,
		);
		assert.equal(existsSync(join(profileRoot, ".tbboot", "trust.yaml")), false);
	} finally {
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: originalStdin,
		});
		await rm(root, { recursive: true, force: true });
	}
});

test("persistent trust is scoped to the Git Source revision", async () => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-git-trust-"));
	const consumerRoot = join(root, "consumer");
	const sourceRoot = join(root, "source");
	const recipeRoot = join(sourceRoot, "recipe");
	const profileRoot = join(root, "profile");
	const trustPath = join(profileRoot, ".tbboot", "trust.yaml");
	const source = {
		provider: "git" as const,
		locator: { repository: "https://example.test/source.git" },
	};
	const step = {
		type: "custom" as const,
		check: {
			runtime: "node" as const,
			content: "return { status: 'ok', changed: false };",
		},
	};
	const context = (revision: string): CustomContext => ({
		consumerRoot,
		sourceRoot,
		recipeRoot,
		recipe: "recipe",
		step: 1,
		source,
		revision,
		sourceFingerprint: "fingerprint",
	});
	try {
		await mkdir(recipeRoot, { recursive: true });
		await mkdir(consumerRoot);
		await mkdir(join(profileRoot, ".tbboot"), { recursive: true });
		await writeFile(
			trustPath,
			[
				"schemaVersion: 1",
				"sources:",
				"  - source:",
				"      provider: git",
				"      locator:",
				"        repository: https://example.test/source.git",
				"    revision: old-revision",
				"",
			].join("\n"),
		);
		await assert.rejects(
			prepareCustomStep(step, context("new-revision"), { profileRoot }),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "custom-authorization-required",
		);
		await writeFile(
			trustPath,
			[
				"schemaVersion: 1",
				"sources:",
				"  - source:",
				"      provider: git",
				"      locator:",
				"        repository: https://example.test/source.git",
				"    revision: new-revision",
				"",
			].join("\n"),
		);
		await prepareCustomStep(step, context("new-revision"), { profileRoot });
		assert.equal(
			existsSync(join(consumerRoot, ".tbboot", "trust.yaml")),
			false,
		);
		assert.equal(existsSync(trustPath), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prepares an in-Source script through a symlinked Source root", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-source-link-"));
	const realSourceRoot = join(root, "source-real");
	const sourceRoot = join(root, "source-link");
	const recipeRoot = join(sourceRoot, "recipe");
	const script = join(realSourceRoot, "shared.js");
	try {
		await mkdir(join(realSourceRoot, "recipe"), { recursive: true });
		await writeFile(
			script,
			"export default async () => ({ status: 'ok', changed: false });",
		);
		try {
			await symlink(
				realSourceRoot,
				sourceRoot,
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") {
				t.skip("symlinks are not available in this environment");
				return;
			}
			throw error;
		}
		const prepared = await prepareCustomStep(
			{
				type: "custom",
				check: { runtime: "node", script: "../shared.js" },
			},
			{
				consumerRoot: root,
				sourceRoot,
				recipeRoot,
				recipe: "recipe",
				step: 1,
				source: { provider: "local", locator: { path: sourceRoot } },
				sourceFingerprint: "test",
			},
			{ allowCustom: [sourceRoot] },
		);
		assert.equal(prepared.check?.script, await realpath(script));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fingerprints symlink metadata without reading linked directories", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-fingerprint-"));
	const sourceRoot = join(root, "source");
	const outsideRoot = join(root, "outside");
	try {
		await mkdir(sourceRoot, { recursive: true });
		await mkdir(outsideRoot, { recursive: true });
		await writeFile(join(outsideRoot, "foreign.txt"), "one\n");
		try {
			await symlink(
				outsideRoot,
				join(sourceRoot, "linked"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") {
				t.skip("symlinks are not available in this environment");
				return;
			}
			throw error;
		}
		const before = await sourceFingerprint(sourceRoot);
		await writeFile(join(outsideRoot, "foreign.txt"), "two\n");
		assert.equal(await sourceFingerprint(sourceRoot), before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runs an external PowerShell Custom handler through the JSON protocol", {
	skip: !hasPwsh,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "tbboot-custom-pwsh-"));
	const script = join(root, "handler.ps1");
	try {
		await writeFile(
			script,
			"return @{ status = 'ok'; changed = $false; details = @{ operation = $Request.operation } }",
		);
		const outcome = await runHandler({
			runtime: "pwsh",
			script,
			request: { operation: "check" },
			cwd: root,
		});
		assert.deepEqual(outcome.result, {
			status: "ok",
			changed: false,
			details: { operation: "check" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
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
