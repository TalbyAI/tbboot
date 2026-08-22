import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsonOutput, runCommand } from "./support.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "src", "cli.ts");

type Fixture = {
	root: string;
	consumerRoot: string;
	sourceRoot: string;
	profileRoot: string;
	cleanup: () => Promise<void>;
};

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

type Envelope = {
	schemaVersion: number;
	command: string;
	status: "ok" | "warning" | "error";
	changed: boolean;
	actions: unknown[];
	diagnostics: Array<{ code: string; severity: string; message: string }>;
};

async function createFixture(): Promise<Fixture> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tbboot-mvp-")));
	const consumerRoot = join(root, "consumer");
	const sourceRoot = join(root, "source");
	const profileRoot = join(root, "profile");
	const recipeRoot = join(sourceRoot, "baseline");
	await mkdir(join(recipeRoot, "files"), { recursive: true });
	await mkdir(consumerRoot);
	await mkdir(profileRoot);
	await writeFile(
		join(consumerRoot, "tbboot.yaml"),
		"schemaVersion: 1\nsources:\n  - provider: local\n    locator:\n      path: ../source\n",
	);
	await writeFile(join(sourceRoot, "source.yaml"), "schemaVersion: 1\n");
	await writeFile(join(recipeRoot, "files", "hello.txt"), "hello\n");
	await writeFile(join(recipeRoot, "files", "managed.md"), "managed block\n");
	await writeLifecycleRecipe(recipeRoot);
	await writeFile(join(consumerRoot, "AGENTS.md"), "user content\n");
	return {
		root,
		consumerRoot,
		sourceRoot,
		profileRoot,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

async function writeLifecycleRecipe(recipeRoot: string): Promise<void> {
	await writeFile(
		join(recipeRoot, "recipe.yaml"),
		[
			"schemaVersion: 1",
			"steps:",
			"  - type: file",
			"    input: files/hello.txt",
			"    target: generated/hello.txt",
			"  - type: file-fragment",
			"    input: files/managed.md",
			"    target: AGENTS.md",
			"  - type: custom",
			"    check:",
			"      runtime: node",
			"      content: |",
			'        console.error("mvp-check-log");',
			'        return { status: "ok", changed: false };',
			"    install:",
			"      runtime: node",
			"      content: |",
			'        const { access, writeFile } = await import("node:fs/promises");',
			"        try {",
			'          await access("custom.txt");',
			'          return { status: "ok", changed: false };',
			"        } catch {",
			'          await writeFile("custom.txt", "custom\\n");',
			'          console.error("mvp-install-log");',
			'          return { status: "ok", changed: true };',
			"        }",
			"    uninstall:",
			"      runtime: node",
			"      content: |",
			'        const { access, rm } = await import("node:fs/promises");',
			"        try {",
			'          await access("custom.txt");',
			'          await rm("custom.txt");',
			'          return { status: "ok", changed: true };',
			"        } catch {",
			'          return { status: "ok", changed: false };',
			"        }",
			"",
		].join("\n"),
		"utf8",
	);
}

function runCli(fixture: Fixture, args: string[]): Promise<CommandResult> {
	return runCommand({
		file: process.execPath,
		args: [cliPath, ...args],
		cwd: fixture.consumerRoot,
		env: {
			USERPROFILE: fixture.profileRoot,
			HOME: fixture.profileRoot,
		},
	});
}

function jsonEnvelope(result: CommandResult, command?: string): Envelope {
	assert.notEqual(result.stdout.trim(), "");
	const envelope = parseJsonOutput<Envelope>(result.stdout);
	assert.equal(envelope.schemaVersion, 1);
	assert.equal(typeof envelope.command, "string");
	if (command !== undefined) assert.equal(envelope.command, command);
	assert.ok(["ok", "warning", "error"].includes(envelope.status));
	assert.equal(typeof envelope.changed, "boolean");
	assert.ok(Array.isArray(envelope.actions));
	assert.ok(Array.isArray(envelope.diagnostics));
	return envelope;
}

type SnapshotEntry =
	| { root: string; path: string; kind: "directory" }
	| { root: string; path: string; kind: "file"; bytes: Uint8Array };

async function snapshotFiles(...roots: string[]): Promise<SnapshotEntry[]> {
	const snapshot: SnapshotEntry[] = [];
	async function visit(root: string, current: string): Promise<void> {
		const entries = (await readdir(current, { withFileTypes: true })).sort(
			(left, right) => left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			const absolute = join(current, entry.name);
			if (entry.isDirectory()) {
				snapshot.push({
					root,
					path: relative(root, absolute).split(sep).join("/"),
					kind: "directory",
				});
				await visit(root, absolute);
			} else if (entry.isFile()) {
				snapshot.push({
					root,
					path: relative(root, absolute).split(sep).join("/"),
					kind: "file",
					bytes: await readFile(absolute),
				});
			}
		}
	}
	for (const root of roots) await visit(root, root);
	return snapshot.sort((left, right) =>
		`${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`),
	);
}

async function runCliUntilFile(
	fixture: Fixture,
	args: string[],
	readyPath: string,
	preloadPath?: string,
): Promise<CommandResult> {
	const child = spawn(
		process.execPath,
		[
			...(preloadPath === undefined
				? []
				: ["--import", pathToFileURL(preloadPath).href]),
			cliPath,
			...args,
		],
		{
			cwd: fixture.consumerRoot,
			env: {
				...process.env,
				USERPROFILE: fixture.profileRoot,
				HOME: fixture.profileRoot,
			},
			windowsHide: true,
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const closed = new Promise<CommandResult>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
	});
	const deadline = Date.now() + 10_000;
	try {
		while (Date.now() < deadline) {
			if (
				await readFile(readyPath).then(
					() => true,
					() => false,
				)
			)
				break;
			if (child.exitCode !== null) {
				throw new Error(
					`CLI exited before readiness: ${child.exitCode}\n${stdout}\n${stderr}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(
			await readFile(readyPath).then(
				() => true,
				() => false,
			),
			"Custom process did not reach the cancellation readiness point",
		);
		if (preloadPath === undefined) child.kill("SIGINT");
		const exitTimer = setTimeout(() => child.kill(), 15_000);
		try {
			return await closed;
		} finally {
			clearTimeout(exitTimer);
		}
	} catch (error) {
		if (child.exitCode === null) child.kill();
		await closed.catch(() => undefined);
		throw error;
	}
}

test("MVP runtime matrix accepts the supported Windows x64 boundary", async (t) => {
	if (process.platform !== "win32" || process.arch !== "x64") {
		t.skip("Issue 21 acceptance runs on Windows x64");
		return;
	}
	if (process.env.TBBOOT_PWSH_MATRIX === "preinstalled") {
		t.skip("The preinstalled PowerShell leg does not enforce the MVP boundary");
		return;
	}
	const nodeVersion = process.versions.node.split(".").map(Number);
	assert.ok(
		(nodeVersion[0] ?? 0) === 24 && (nodeVersion[1] ?? 0) >= 12,
		`unsupported Node version: ${process.version}`,
	);
	const pwsh = await runCommand({
		file: "pwsh",
		args: ["-NoProfile", "--version"],
	});
	assert.equal(pwsh.exitCode, 0, pwsh.stderr);
	const pwshVersion = pwsh.stdout.match(/(\d+)\.(\d+)/);
	assert.ok(pwshVersion, pwsh.stdout);
	assert.equal(pwshVersion[1], "7");
	assert.ok(Number(pwshVersion[2]) >= 6, pwsh.stdout);
});

test("MVP runtime rejection is preflight-only and read-only", async (t) => {
	if (process.platform !== "win32" || process.arch !== "x64") {
		t.skip("Issue 21 acceptance runs on Windows x64");
		return;
	}
	const fixture = await createFixture();
	try {
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      selector: '>=25.0 <26.0'",
				"      content: 'return { status: \"ok\", changed: false };'",
				"  - type: custom",
				"    check:",
				"      runtime: pwsh",
				"      selector: '>=8.0 <9.0'",
				"      content: 'return [pscustomobject]@{ status = \"ok\"; changed = $false }'",
				"",
			].join("\n"),
			"utf8",
		);
		const before = await snapshotFiles(
			fixture.consumerRoot,
			fixture.sourceRoot,
			fixture.profileRoot,
		);
		const result = await runCli(fixture, [
			"doctor",
			"--root",
			fixture.consumerRoot,
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
		]);
		assert.equal(result.exitCode, 1);
		const envelope = jsonEnvelope(result);
		assert.ok(
			envelope.diagnostics.filter(({ code }) => code === "runtime-incompatible")
				.length >= 2,
			JSON.stringify(envelope),
		);
		assert.deepEqual(
			await snapshotFiles(
				fixture.consumerRoot,
				fixture.sourceRoot,
				fixture.profileRoot,
			),
			before,
		);

		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: windows-powershell",
				"      content: 'return { status: \"ok\", changed: false };'",
				"",
			].join("\n"),
			"utf8",
		);
		const unsupported = await runCli(fixture, [
			"doctor",
			"--root",
			fixture.consumerRoot,
			"--json",
		]);
		assert.equal(unsupported.exitCode, 1);
		assert.equal(unsupported.stderr, "");
		assert.ok(
			jsonEnvelope(unsupported).diagnostics.some(
				({ code }) => code === "schema-validation-failed",
			),
		);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI runs external Node and PowerShell Custom handlers", async (t) => {
	const pwsh = await runCommand({
		file: "pwsh",
		args: ["-NoProfile", "--version"],
	}).catch(() => undefined);
	if (pwsh?.exitCode !== 0) {
		t.skip("PowerShell 7 is not available");
		return;
	}
	const fixture = await createFixture();
	try {
		const recipeRoot = join(fixture.sourceRoot, "baseline");
		await mkdir(join(recipeRoot, "scripts"));
		await writeFile(
			join(recipeRoot, "scripts", "node.mjs"),
			[
				"export default async function handler(request) {",
				'  const { join } = await import("node:path");',
				'  const { rm, writeFile } = await import("node:fs/promises");',
				'  const target = join(request.consumerRoot, "external-node.txt");',
				'  if (request.operation === "install") await writeFile(target, "node\\n");',
				'  if (request.operation === "uninstall") await rm(target);',
				'  console.error("external-node-" + request.operation + "-log");',
				'  return { status: "ok", changed: request.operation !== "check" };',
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			join(recipeRoot, "scripts", "pwsh.ps1"),
			[
				"$target = Join-Path $Request.consumerRoot 'external-pwsh.txt'",
				"if ($Request.operation -eq 'install') { Set-Content -Path $target -Value 'pwsh' -NoNewline }",
				"if ($Request.operation -eq 'uninstall') { Remove-Item -LiteralPath $target }",
				'Write-Error "external-pwsh-$($Request.operation)-log"',
				"@{ status = 'ok'; changed = ($Request.operation -ne 'check') }",
				"",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			join(recipeRoot, "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      script: scripts/node.mjs",
				"    install:",
				"      runtime: node",
				"      script: scripts/node.mjs",
				"    uninstall:",
				"      runtime: node",
				"      script: scripts/node.mjs",
				"  - type: custom",
				"    check:",
				"      runtime: pwsh",
				"      script: scripts/pwsh.ps1",
				"    install:",
				"      runtime: pwsh",
				"      script: scripts/pwsh.ps1",
				"    uninstall:",
				"      runtime: pwsh",
				"      script: scripts/pwsh.ps1",
				"",
			].join("\n"),
			"utf8",
		);
		const installed = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
		]);
		assert.equal(installed.exitCode, 0, installed.stdout);
		assert.match(installed.stderr, /external-node-(install|check)-log/);
		assert.match(installed.stderr, /external-pwsh-(install|check)-log/);
		assert.equal(jsonEnvelope(installed, "install").changed, true);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "external-node.txt"), "utf8"),
			"node\n",
		);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "external-pwsh.txt"), "utf8"),
			"pwsh",
		);

		const uninstalled = await runCli(fixture, [
			"uninstall",
			"--root",
			fixture.consumerRoot,
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
		]);
		assert.equal(uninstalled.exitCode, 0, uninstalled.stdout);
		assert.equal(jsonEnvelope(uninstalled, "uninstall").changed, true);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "external-node.txt"),
				"utf8",
			).catch(() => undefined),
			undefined,
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "external-pwsh.txt"),
				"utf8",
			).catch(() => undefined),
			undefined,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI runs an erasable TypeScript Custom handler", async () => {
	const fixture = await createFixture();
	const allowCustom = ["--allow-custom", fixture.sourceRoot];
	try {
		const recipeRoot = join(fixture.sourceRoot, "baseline");
		await mkdir(join(recipeRoot, "scripts"));
		await writeFile(
			join(recipeRoot, "scripts", "node.ts"),
			[
				'import { rm, writeFile } from "node:fs/promises";',
				'import { join } from "node:path";',
				"type Request = {",
				'  operation: "check" | "install" | "uninstall";',
				"  consumerRoot: string;",
				"};",
				'type Result = { status: "ok"; changed: boolean };',
				"export default async function handler(request: Request): Promise<Result> {",
				'  const target = join(request.consumerRoot, "external-ts.txt");',
				'  if (request.operation === "install") await writeFile(target, "typescript\\n");',
				'  if (request.operation === "uninstall") await rm(target, { force: true });',
				'  console.error("external-ts-" + request.operation + "-log");',
				'  return { status: "ok", changed: request.operation !== "check" };',
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			join(recipeRoot, "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      script: scripts/node.ts",
				"    install:",
				"      runtime: node",
				"      script: scripts/node.ts",
				"    uninstall:",
				"      runtime: node",
				"      script: scripts/node.ts",
				"",
			].join("\n"),
			"utf8",
		);

		const installed = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(installed.exitCode, 0, installed.stdout);
		assert.equal(jsonEnvelope(installed, "install").changed, true);
		assert.match(installed.stderr, /external-ts-(check|install)-log/);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "external-ts.txt"), "utf8"),
			"typescript\n",
		);

		const uninstalled = await runCli(fixture, [
			"uninstall",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(uninstalled.exitCode, 0, uninstalled.stdout);
		assert.equal(jsonEnvelope(uninstalled, "uninstall").changed, true);
		assert.match(uninstalled.stderr, /external-ts-uninstall-log/);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "external-ts.txt"),
				"utf8",
			).catch(() => undefined),
			undefined,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI reports a Custom timeout through the JSON contract", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      timeoutSeconds: 1",
				"      content: 'await new Promise(() => setInterval(() => {}, 1000));'",
				"",
			].join("\n"),
			"utf8",
		);
		const result = await runCli(fixture, [
			"doctor",
			"--root",
			fixture.consumerRoot,
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
		]);
		assert.equal(result.exitCode, 1);
		const envelope = jsonEnvelope(result);
		assert.ok(
			envelope.diagnostics.some(({ code }) => code === "custom-error"),
			JSON.stringify(envelope),
		);
		assert.ok(
			envelope.diagnostics.some(({ message }) => /timeout/i.test(message)),
			JSON.stringify(envelope),
		);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI treats a timed-out optional Custom check as a warning", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    optional: true",
				"    check:",
				"      runtime: node",
				"      timeoutSeconds: 1",
				"      content: 'await new Promise(() => setInterval(() => {}, 1000));'",
				"",
			].join("\n"),
			"utf8",
		);
		const result = await runCli(fixture, [
			"doctor",
			"--root",
			fixture.consumerRoot,
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
		]);
		assert.equal(result.exitCode, 0, result.stdout);
		const envelope = jsonEnvelope(result);
		assert.equal(envelope.status, "warning");
		assert.ok(
			envelope.diagnostics.some(
				({ code, severity, message }) =>
					code === "custom-error" &&
					severity === "warning" &&
					/timeout/i.test(message),
			),
			JSON.stringify(envelope),
		);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI cancels Custom install at the process boundary and reconciles", async () => {
	const fixture = await createFixture();
	const readyPath = join(fixture.consumerRoot, "cancel-ready");
	const preloadPath = join(fixture.root, "cancel-loader.mjs");
	const allowCustom = ["--allow-custom", fixture.sourceRoot];
	try {
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/hello.txt",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      content: 'return { status: \"ok\", changed: false };'",
				"    install:",
				"      runtime: node",
				"      content: |",
				'        const { writeFile } = await import("node:fs/promises");',
				'        await writeFile("cancel-ready", "ready\\n");',
				"        await new Promise(() => setInterval(() => {}, 1000));",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: after-cancel.txt",
				"",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			preloadPath,
			[
				'import { existsSync } from "node:fs";',
				`const readyPath = ${JSON.stringify(readyPath)};`,
				"const timer = setInterval(() => {",
				"  if (existsSync(readyPath)) {",
				"    clearInterval(timer);",
				'    process.emit("SIGINT");',
				"  }",
				"}, 25);",
				"",
			].join("\n"),
			"utf8",
		);
		const cancelled = await runCliUntilFile(
			fixture,
			["install", "--root", fixture.consumerRoot, ...allowCustom, "--json"],
			readyPath,
			preloadPath,
		);
		assert.equal(
			cancelled.exitCode,
			130,
			`${cancelled.stdout}\n${cancelled.stderr}`,
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
				"utf8",
			),
			"hello\n",
		);
		assert.match(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", "state.yaml"),
				"utf8",
			),
			/type: file/,
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "after-cancel.txt"),
				"utf8",
			).catch(() => undefined),
			undefined,
		);

		await rm(readyPath, { force: true });
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/hello.txt",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      content: 'return { status: \"ok\", changed: false };'",
				"    install:",
				"      runtime: node",
				"      content: 'return { status: \"ok\", changed: false };'",
				"",
			].join("\n"),
			"utf8",
		);
		const reconciled = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(reconciled.exitCode, 0, reconciled.stdout);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI persists required failure state and reconciles it later", async () => {
	const fixture = await createFixture();
	const allowCustom = ["--allow-custom", fixture.sourceRoot];
	try {
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/before-failure.txt",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      content: 'return { status: \"ok\", changed: false };'",
				"    install:",
				"      runtime: node",
				"      content: |",
				'        if (request.operation === "install") {',
				'          console.error("required-install-failure");',
				'          return { status: "error", changed: false, message: "required failure" };',
				"        }",
				'        return { status: "ok", changed: false };',
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/after-failure.txt",
				"",
			].join("\n"),
			"utf8",
		);

		const failed = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(failed.exitCode, 1, failed.stdout);
		assert.match(failed.stderr, /required-install-failure/);
		const failedEnvelope = jsonEnvelope(failed, "install");
		assert.equal(failedEnvelope.status, "error");
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "before-failure.txt"),
				"utf8",
			),
			"hello\n",
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "after-failure.txt"),
				"utf8",
			).catch(() => undefined),
			undefined,
		);
		const partialState = await readFile(
			join(fixture.consumerRoot, ".tbboot", "state.yaml"),
			"utf8",
		);
		assert.match(partialState, /step: 1/);
		assert.doesNotMatch(partialState, /step: 2/);
		assert.doesNotMatch(partialState, /step: 3/);

		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/before-failure.txt",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      content: 'return { status: \"ok\", changed: false };'",
				"    install:",
				"      runtime: node",
				"      content: 'return { status: \"ok\", changed: false };'",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/after-failure.txt",
				"",
			].join("\n"),
			"utf8",
		);
		const reconciled = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(reconciled.exitCode, 0, reconciled.stdout);
		assert.equal(jsonEnvelope(reconciled, "install").status, "ok");
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "after-failure.txt"),
				"utf8",
			),
			"hello\n",
		);
		const finalState = await readFile(
			join(fixture.consumerRoot, ".tbboot", "state.yaml"),
			"utf8",
		);
		assert.equal((finalState.match(/step: [123]/g) ?? []).length, 3);
		assert.equal((finalState.match(/step: 1/g) ?? []).length, 1);
		assert.equal((finalState.match(/step: 2/g) ?? []).length, 1);
		assert.equal((finalState.match(/step: 3/g) ?? []).length, 1);
	} finally {
		await fixture.cleanup();
	}
});

test("MVP CLI lifecycle preserves read-only boundaries and ownership", async () => {
	const fixture = await createFixture();
	const allowCustom = ["--allow-custom", fixture.sourceRoot];
	try {
		const beforeDoctor = await snapshotFiles(
			fixture.consumerRoot,
			fixture.sourceRoot,
			fixture.profileRoot,
		);
		const doctor = await runCli(fixture, [
			"doctor",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(doctor.exitCode, 1);
		assert.equal(doctor.stderr, "");
		assert.equal(jsonEnvelope(doctor).changed, false);
		assert.deepEqual(
			await snapshotFiles(
				fixture.consumerRoot,
				fixture.sourceRoot,
				fixture.profileRoot,
			),
			beforeDoctor,
		);

		const beforeDryRun = await snapshotFiles(
			fixture.consumerRoot,
			fixture.sourceRoot,
			fixture.profileRoot,
		);
		const dryRun = await runCli(fixture, [
			"install",
			"--dry-run",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(dryRun.exitCode, 0);
		assert.equal(dryRun.stderr, "");
		const dryRunEnvelope = jsonEnvelope(dryRun);
		assert.equal(dryRunEnvelope.changed, false);
		assert.ok(
			dryRunEnvelope.diagnostics.some(
				({ code }) => code === "custom-check-deferred",
			),
		);
		assert.deepEqual(
			await snapshotFiles(
				fixture.consumerRoot,
				fixture.sourceRoot,
				fixture.profileRoot,
			),
			beforeDryRun,
		);

		const installed = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(installed.exitCode, 0, installed.stdout);
		assert.match(installed.stderr, /mvp-install-log/);
		assert.match(installed.stderr, /mvp-check-log/);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
				"utf8",
			),
			"hello\n",
		);
		assert.match(
			await readFile(join(fixture.consumerRoot, "AGENTS.md"), "utf8"),
			/managed block/,
		);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "custom.txt"), "utf8"),
			"custom\n",
		);
		assert.equal(jsonEnvelope(installed).changed, true);

		const beforeSecondInstall = await snapshotFiles(
			fixture.consumerRoot,
			fixture.sourceRoot,
			fixture.profileRoot,
		);
		const secondInstall = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(secondInstall.exitCode, 0);
		assert.equal(jsonEnvelope(secondInstall).changed, false);
		assert.deepEqual(
			await snapshotFiles(
				fixture.consumerRoot,
				fixture.sourceRoot,
				fixture.profileRoot,
			),
			beforeSecondInstall,
		);

		await writeFile(
			join(fixture.consumerRoot, "generated", "hello.txt"),
			"local change\n",
			"utf8",
		);
		const blocked = await runCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(blocked.exitCode, 1);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
				"utf8",
			),
			"local change\n",
		);
		const forced = await runCli(fixture, [
			"install",
			"--force",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
			"--json",
		]);
		assert.equal(forced.exitCode, 0);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
				"utf8",
			),
			"hello\n",
		);

		const humanUninstall = await runCli(fixture, [
			"uninstall",
			"--root",
			fixture.consumerRoot,
			...allowCustom,
		]);
		assert.equal(humanUninstall.exitCode, 0, humanUninstall.stdout);
		assert.equal(humanUninstall.stderr.includes("{"), false);
		assert.match(humanUninstall.stdout, /status: ok/);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
				"utf8",
			).catch(() => undefined),
			undefined,
		);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "custom.txt"), "utf8").catch(
				() => undefined,
			),
			undefined,
		);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "AGENTS.md"), "utf8"),
			"user content\n",
		);

		const secondUninstall = await runCli(fixture, [
			"uninstall",
			"--root",
			fixture.consumerRoot,
			"--json",
		]);
		assert.equal(secondUninstall.exitCode, 0);
		assert.equal(jsonEnvelope(secondUninstall).changed, false);
	} finally {
		await fixture.cleanup();
	}
});
