import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { DoctorEnvelope } from "../src/doctor.ts";
import { parseJsonOutput, runCommand } from "./support.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "src", "cli.ts");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let installedRoot: string | undefined;
let installedBinPromise: Promise<string> | undefined;

type Fixture = {
	root: string;
	consumerRoot: string;
	sourceRoot: string;
	profileRoot: string;
	cleanup: () => Promise<void>;
};

type RecipeStepFixture = {
	type?: "file" | "file-fragment" | "custom";
	input?: string;
	inputContent?: string;
	inputMissing?: boolean;
	target?: string;
	optional?: boolean;
};

type SnapshotEntry =
	| { root: string; path: string; kind: "directory" }
	| { root: string; path: string; kind: "file"; bytes: Uint8Array };

type CommandOptions = Parameters<typeof runCommand>[0];
type CommandResult = Awaited<ReturnType<typeof runCommand>>;
type RunCliOptions = Omit<CommandOptions, "file" | "args">;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

function commandFor(
	file: string,
	args: string[],
): Pick<CommandOptions, "file" | "args"> {
	if (process.platform !== "win32") return { file, args };
	const quote = (value: string) =>
		/\s/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
	return {
		file: process.env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c", [file, ...args].map(quote).join(" ")],
	};
}

function installedBin(): Promise<string> {
	if (!installedBinPromise) {
		installedBinPromise = (async () => {
			installedRoot = await mkdtemp(join(tmpdir(), "tbboot-installed-"));
			const result = await runCommand({
				...commandFor(npmCommand, [
					"install",
					"--prefix",
					installedRoot,
					"--no-save",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--package-lock=false",
					projectRoot,
				]),
				cwd: projectRoot,
			});
			assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
			return join(
				installedRoot,
				"node_modules",
				".bin",
				process.platform === "win32" ? "tbboot.cmd" : "tbboot",
			);
		})();
	}
	return installedBinPromise;
}

async function runCli(
	fixture: Fixture,
	args: string[],
	options: RunCliOptions = {},
): Promise<CommandResult> {
	const bin = await installedBin();
	return runReadOnlyCommand(fixture, {
		...commandFor(bin, args),
		cwd: projectRoot,
		...options,
	});
}

async function runWritableCli(
	fixture: Fixture,
	args: string[],
	options: RunCliOptions = {},
): Promise<CommandResult> {
	const bin = await installedBin();
	return runCommand({
		...commandFor(bin, args),
		cwd: projectRoot,
		env: {
			USERPROFILE: fixture.profileRoot,
			HOME: fixture.profileRoot,
			...options.env,
		},
		...options,
	});
}

test.after(async () => {
	if (installedRoot) await rm(installedRoot, { recursive: true, force: true });
});

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "tbboot-issue-13-"));
	const consumerRoot = join(root, "consumer");
	const sourceRoot = join(root, "source");
	const profileRoot = join(root, "profile");
	const recipeRoot = join(sourceRoot, "baseline");
	await mkdir(join(consumerRoot, "generated"), { recursive: true });
	await mkdir(join(recipeRoot, "files"), { recursive: true });
	await mkdir(profileRoot);
	await writeFile(
		join(consumerRoot, "tbboot.yaml"),
		[
			"schemaVersion: 1",
			"sources:",
			"  - provider: local",
			"    locator:",
			"      path: ../source",
			"",
		].join("\n"),
	);
	await writeFile(join(sourceRoot, "source.yaml"), "schemaVersion: 1\n");
	await writeFile(
		join(recipeRoot, "recipe.yaml"),
		[
			"schemaVersion: 1",
			"steps:",
			"  - type: file",
			"    input: files/hello.txt",
			"    target: generated/hello.txt",
			"",
		].join("\n"),
	);
	await writeFile(join(recipeRoot, "files", "hello.txt"), "hello\n");
	await writeFile(join(consumerRoot, "generated", "hello.txt"), "hello\n");
	return {
		root,
		consumerRoot,
		sourceRoot,
		profileRoot,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

async function writeRecipe(
	sourceRoot: string,
	recipe: string,
	steps: RecipeStepFixture[],
): Promise<void> {
	const recipeRoot = join(sourceRoot, recipe);
	await mkdir(recipeRoot, { recursive: true });
	await writeFile(
		join(recipeRoot, "recipe.yaml"),
		[
			"schemaVersion: 1",
			"steps:",
			...steps.flatMap((step) => [
				`  - type: ${step.type ?? "file"}`,
				...(step.input === undefined ? [] : [`    input: ${step.input}`]),
				...(step.target === undefined ? [] : [`    target: ${step.target}`]),
				...(step.optional === true ? ["    optional: true"] : []),
				...(step.type === "custom"
					? ["    check:", "      runtime: node", '      content: "return;"']
					: []),
			]),
			"",
		].join("\n"),
	);
	for (const step of steps) {
		if (step.input !== undefined && step.inputContent !== undefined) {
			const inputPath = join(recipeRoot, step.input);
			await mkdir(dirname(inputPath), { recursive: true });
			await writeFile(inputPath, step.inputContent);
		}
		if (step.input !== undefined && step.inputMissing === true) {
			await rm(join(recipeRoot, step.input), { force: true });
		}
	}
}

async function runDoctor(
	fixture: Fixture,
	...args: string[]
): Promise<{ result: CommandResult; envelope: DoctorEnvelope }> {
	const result = await runCli(fixture, [
		"doctor",
		"--json",
		"--root",
		fixture.consumerRoot,
		...args,
	]);
	assert.equal(result.stderr, "");
	return { result, envelope: parseJsonOutput<DoctorEnvelope>(result.stdout) };
}

async function snapshotTree(...roots: string[]): Promise<SnapshotEntry[]> {
	const snapshot: SnapshotEntry[] = [];
	async function visit(root: string, current: string): Promise<void> {
		const entries = (await readdir(current, { withFileTypes: true })).sort(
			(left, right) =>
				left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
		for (const entry of entries) {
			const absolute = join(current, entry.name);
			const path = relative(root, absolute).split(sep).join("/");
			if (entry.isDirectory()) {
				snapshot.push({ root, path, kind: "directory" });
				await visit(root, absolute);
			} else {
				snapshot.push({
					root,
					path,
					kind: "file",
					bytes: await readFile(absolute),
				});
			}
		}
	}
	for (const root of roots) await visit(root, root);
	return snapshot.sort((left, right) => {
		const a = `${left.root}/${left.path}`;
		const b = `${right.root}/${right.path}`;
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

async function runReadOnlyCommand(
	fixture: Fixture,
	command: CommandOptions,
): Promise<CommandResult> {
	const roots = [fixture.consumerRoot, fixture.sourceRoot, fixture.profileRoot];
	const before = await snapshotTree(...roots);
	try {
		return await runCommand({
			...command,
			env: {
				...command.env,
				USERPROFILE: fixture.profileRoot,
				HOME: fixture.profileRoot,
			},
		});
	} finally {
		const after = await snapshotTree(...roots);
		assert.deepEqual(
			after,
			before,
			"read-only process modified a watched tree",
		);
	}
}

test("usage errors return 2 and print usage only on stderr", async () => {
	const fixture = await createFixture();
	try {
		const cases = [
			["doctor", "--unknown"],
			["doctor", "--json", "--unknown"],
			["--json", "doctor"],
			["doctor", "--root"],
			["doctor", "--root="],
			["doctor", `--root=${fixture.consumerRoot}`],
			[
				"doctor",
				"--root",
				fixture.consumerRoot,
				"--root",
				fixture.consumerRoot,
			],
			["doctor", "unexpected"],
		];
		for (const args of cases) {
			const result = await runCli(fixture, args);
			assert.equal(result.exitCode, 2, args.join(" "));
			assert.equal(result.stdout, "", args.join(" "));
			assert.match(result.stderr, /usage: tbboot doctor/, args.join(" "));
		}
	} finally {
		await fixture.cleanup();
	}
});

test("preserves root values beginning with a dash", async () => {
	const fixture = await createFixture();
	try {
		const consumerRoot = join(fixture.root, "-consumer");
		await rename(fixture.consumerRoot, consumerRoot);
		fixture.consumerRoot = consumerRoot;
		const result = await runCli(
			fixture,
			["doctor", "--root", "-consumer", "--json"],
			{ cwd: fixture.root },
		);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		assert.equal(parseJsonOutput<DoctorEnvelope>(result.stdout).status, "ok");
	} finally {
		await fixture.cleanup();
	}
});

test("invalid YAML returns one JSON diagnostic and no stderr", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			"schemaVersion: [\n",
		);
		const result = await runCli(fixture, [
			"doctor",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 1);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<DoctorEnvelope>(result.stdout);
		assert.equal(envelope.status, "error");
		assert.deepEqual(
			envelope.diagnostics.map(({ code }) => code),
			["yaml-parse-error"],
		);
		const firstDiagnostic = envelope.diagnostics[0];
		assert.ok(firstDiagnostic);
		assert.equal(firstDiagnostic.document, "tbboot.yaml");
	} finally {
		await fixture.cleanup();
	}
});

test("valid canonical fixture compiles and validates without contract errors", async () => {
	const fixture = await createFixture();
	try {
		const result = await runCli(fixture, [
			"doctor",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<DoctorEnvelope>(result.stdout);
		assert.equal(envelope.status, "ok");
		assert.equal(envelope.changed, false);
		assert.equal(
			envelope.diagnostics.some(
				({ code }) => code === "schema-validation-failed",
			),
			false,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("linked CLI entrypoint resolves its real path before invoking main", async (t) => {
	const fixture = await createFixture();
	const linkRoot = await mkdtemp(join(tmpdir(), "tbboot-link-"));
	try {
		const link = join(linkRoot, "cli.ts");
		try {
			await symlink(cliPath, link);
		} catch (error) {
			const code = errorCode(error);
			if (code === "EPERM" || code === "EACCES") {
				t.skip("symlinks are not available in this environment");
				return;
			}
			throw error;
		}
		const result = await runReadOnlyCommand(fixture, {
			file: process.execPath,
			args: [link, "doctor", "--json", "--root", fixture.consumerRoot],
			cwd: projectRoot,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<DoctorEnvelope>(result.stdout);
		assert.equal(envelope.status, "ok");
	} finally {
		await rm(linkRoot, { recursive: true, force: true });
		await fixture.cleanup();
	}
});

test("discovers only first-level Recipes in lexical order and preserves Step order", async () => {
	const fixture = await createFixture();
	try {
		await rm(join(fixture.sourceRoot, "baseline"), { recursive: true });
		await writeRecipe(fixture.sourceRoot, "zulu", [
			{
				input: "files/one.txt",
				inputContent: "one\n",
				target: "generated/zulu-one.txt",
			},
			{
				input: "files/two.txt",
				inputContent: "two\n",
				target: "generated/zulu-two.txt",
			},
		]);
		await writeRecipe(fixture.sourceRoot, "alpha", [
			{
				input: "files/one.txt",
				inputContent: "one\n",
				target: "generated/alpha.txt",
			},
		]);
		await mkdir(join(fixture.sourceRoot, "nested", "child"), {
			recursive: true,
		});
		await writeFile(
			join(fixture.sourceRoot, "nested", "child", "recipe.yaml"),
			"schemaVersion: 1\nsteps: []\n",
		);

		const { envelope } = await runDoctor(fixture);
		assert.deepEqual(
			envelope.actions.map(({ recipe, step }) => `${recipe}/${step}`),
			["alpha/1", "zulu/1", "zulu/2"],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("rejects unsupported providers and duplicate normalized local Sources", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				"      repository: https://example.invalid/recipes.git",
				"  - provider: local",
				"    locator:",
				"      path: ../source",
				"  - provider: local",
				"    locator:",
				"      path: ./../source",
				"",
			].join("\n"),
		);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 1);
		assert.deepEqual(
			envelope.diagnostics.map(({ code }) => code),
			["unsupported-source-provider", "duplicate-source"],
		);
		const firstDiagnostic = envelope.diagnostics[0];
		assert.ok(firstDiagnostic);
		assert.equal(firstDiagnostic.path, "/sources/0/provider");
		const secondDiagnostic = envelope.diagnostics[1];
		assert.ok(secondDiagnostic);
		assert.equal(secondDiagnostic.path, "/sources/2/locator/path");
	} finally {
		await fixture.cleanup();
	}
});

test("preserves case-distinct Source and target paths", async (t) => {
	const fixture = await createFixture();
	const probeRoot = join(fixture.root, "case-probe");
	try {
		await mkdir(probeRoot);
		await mkdir(join(probeRoot, "A"));
		try {
			await mkdir(join(probeRoot, "a"));
		} catch (error) {
			if (errorCode(error) === "EEXIST") {
				t.skip("filesystem is case-insensitive");
				return;
			}
			throw error;
		}
		await rm(probeRoot, { recursive: true, force: true });

		const upperSource = join(fixture.sourceRoot, "CaseSource");
		const lowerSource = join(fixture.sourceRoot, "casesource");
		for (const source of [upperSource, lowerSource]) {
			await mkdir(source, { recursive: true });
			await writeFile(join(source, "source.yaml"), "schemaVersion: 1\n");
		}
		await writeRecipe(upperSource, "baseline", [
			{
				input: "files/content.txt",
				inputContent: "upper\n",
				target: "generated/Case.txt",
			},
		]);
		await writeRecipe(lowerSource, "baseline", [
			{
				input: "files/content.txt",
				inputContent: "lower\n",
				target: "generated/case.txt",
			},
		]);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../source/CaseSource",
				"  - provider: local",
				"    locator:",
				"      path: ../source/casesource",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "generated", "Case.txt"),
			"upper\n",
		);
		await writeFile(
			join(fixture.consumerRoot, "generated", "case.txt"),
			"lower\n",
		);

		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 0);
		assert.equal(envelope.actions.length, 2);
		assert.deepEqual(envelope.actions.map(({ target }) => target).sort(), [
			"generated/Case.txt",
			"generated/case.txt",
		]);
		assert.equal(
			envelope.diagnostics.some(({ code }) =>
				["duplicate-source", "file-target-collision"].includes(code),
			),
			false,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("missing input is a conflict and optional missing input is a warning", async () => {
	const fixture = await createFixture();
	try {
		await rm(join(fixture.sourceRoot, "baseline", "files", "hello.txt"));
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 1);
		assert.deepEqual(
			envelope.actions.map(({ state }) => state),
			["conflict"],
		);
		const firstDiagnostic = envelope.diagnostics[0];
		assert.ok(firstDiagnostic);
		assert.equal(firstDiagnostic.code, "source-input-missing");

		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/hello.txt",
				"    optional: true",
				"",
			].join("\n"),
		);
		const optional = await runDoctor(fixture);
		assert.equal(optional.result.exitCode, 0);
		assert.equal(optional.envelope.status, "warning");
		const optionalDiagnostic = optional.envelope.diagnostics[0];
		assert.ok(optionalDiagnostic);
		assert.equal(optionalDiagnostic.severity, "warning");
	} finally {
		await fixture.cleanup();
	}
});

test("unsupported Custom Steps produce no action and follow optionality", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "custom", [
			{ type: "custom", optional: true },
		]);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 0);
		assert.equal(envelope.status, "warning");
		assert.equal(envelope.actions.length, 1);
		const lastDiagnostic = envelope.diagnostics.at(-1);
		assert.ok(lastDiagnostic);
		assert.equal(lastDiagnostic.code, "unsupported-step");
		assert.equal(lastDiagnostic.severity, "warning");
	} finally {
		await fixture.cleanup();
	}
});

test("rejects input and target symlink escapes", async (t) => {
	const fixture = await createFixture();
	try {
		const outsideRoot = join(fixture.root, "outside");
		await mkdir(outsideRoot, { recursive: true });
		try {
			await writeFile(join(outsideRoot, "input.txt"), "outside\n");
			await symlink(
				join(outsideRoot, "input.txt"),
				join(fixture.sourceRoot, "baseline", "files", "outside-link.txt"),
			);
			await writeFile(join(outsideRoot, "target.txt"), "outside\n");
			await symlink(
				join(outsideRoot, "target.txt"),
				join(fixture.consumerRoot, "generated", "outside-link.txt"),
			);
		} catch (error) {
			const code = errorCode(error);
			if (code === "EPERM" || code === "EACCES") {
				t.skip("symlinks are not available in this environment");
				return;
			}
			throw error;
		}

		await writeRecipe(fixture.sourceRoot, "escape", [
			{ input: "files/outside-link.txt", target: "generated/escape-input.txt" },
			{
				input: "files/hello.txt",
				inputContent: "hello\n",
				target: "generated/outside-link.txt",
			},
		]);
		await symlink(
			join(outsideRoot, "input.txt"),
			join(fixture.sourceRoot, "escape", "files", "outside-link.txt"),
		);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 1);
		assert.deepEqual(
			envelope.diagnostics.map(({ code }) => code),
			["source-input-escape", "target-escape"],
		);
		assert.deepEqual(
			envelope.actions
				.filter(({ recipe }) => recipe === "escape")
				.map(({ state }) => state),
			["conflict", "conflict"],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("reserved selections and closed fields stop before Source discovery", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../source",
				"    recipes: []",
				"unexpected: true",
				"",
			].join("\n"),
		);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 1);
		assert.deepEqual(
			envelope.diagnostics.map(({ code }) => code),
			["schema-validation-failed"],
		);
		assert.equal(envelope.actions.length, 0);
		assert.equal(
			envelope.diagnostics.some(({ code }) => code === "source-read"),
			false,
		);

		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../source",
				"    recipes: []",
				"",
			].join("\n"),
		);
		const reserved = await runDoctor(fixture);
		assert.deepEqual(
			reserved.envelope.diagnostics.map(({ code }) => code),
			["recipes-empty"],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("File states are satisfied, missing, or drift with required severity", async () => {
	const fixture = await createFixture();
	try {
		const satisfied = await runDoctor(fixture);
		assert.equal(satisfied.result.exitCode, 0);
		assert.deepEqual(
			satisfied.envelope.actions.map(({ state }) => state),
			["satisfied"],
		);

		await rm(join(fixture.consumerRoot, "generated", "hello.txt"));
		const missing = await runDoctor(fixture);
		assert.equal(missing.result.exitCode, 1);
		assert.deepEqual(
			missing.envelope.actions.map(({ state }) => state),
			["missing"],
		);
		assert.deepEqual(
			missing.envelope.diagnostics.map(({ code }) => code),
			["file-missing"],
		);

		await writeFile(
			join(fixture.consumerRoot, "generated", "hello.txt"),
			"drifted\n",
		);
		const drift = await runDoctor(fixture);
		assert.equal(drift.result.exitCode, 1);
		assert.deepEqual(
			drift.envelope.actions.map(({ state }) => state),
			["drift"],
		);
		assert.deepEqual(
			drift.envelope.diagnostics.map(({ code }) => code),
			["file-drift"],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("File and File Fragment writers sharing a target all conflict", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "file-writer", [
			{
				input: "files/content.txt",
				inputContent: "file\n",
				target: "generated/shared.txt",
			},
		]);
		await writeRecipe(fixture.sourceRoot, "fragment-writer", [
			{
				type: "file-fragment",
				input: "files/content.txt",
				inputContent: "fragment\n",
				target: "generated/shared.txt",
			},
		]);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 1);
		const participants = envelope.actions.filter(
			({ target }) => target === "generated/shared.txt",
		);
		assert.deepEqual(
			participants.map(({ state }) => state),
			["conflict", "conflict"],
		);
		assert.deepEqual(
			envelope.diagnostics
				.filter(({ code }) => code === "file-target-collision")
				.map(({ recipe }) => recipe),
			["file-writer", "fragment-writer"],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("File Fragment normalizes line endings and detects missing, drift, and satisfied blocks", async () => {
	const fixture = await createFixture();
	try {
		const input = "alpha\r\nbeta";
		await writeRecipe(fixture.sourceRoot, "fragment", [
			{
				type: "file-fragment",
				input: "files/fragment.txt",
				inputContent: input,
				target: "AGENTS.md",
			},
		]);
		const missing = await runDoctor(fixture);
		assert.equal(missing.result.exitCode, 1);
		assert.deepEqual(
			missing.envelope.actions
				.filter(({ recipe }) => recipe === "fragment")
				.map(({ state }) => state),
			["missing"],
		);
		assert.deepEqual(
			missing.envelope.diagnostics
				.filter(({ recipe }) => recipe === "fragment")
				.map(({ code }) => code),
			["fragment-missing"],
		);

		await writeFile(
			join(fixture.consumerRoot, "AGENTS.md"),
			[
				"before",
				"<!-- managed-by: source/fragment -->",
				"alpha",
				"beta",
				"<!-- end-managed-by: source/fragment -->",
				"after",
				"",
			].join("\r\n"),
		);
		const satisfied = await runDoctor(fixture);
		assert.equal(satisfied.result.exitCode, 0);
		const satisfiedAction = satisfied.envelope.actions.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(satisfiedAction);
		assert.equal(satisfiedAction.state, "satisfied");

		await writeFile(
			join(fixture.consumerRoot, "AGENTS.md"),
			[
				"before",
				"<!-- managed-by: source/fragment -->",
				"changed",
				"<!-- end-managed-by: source/fragment -->",
				"after",
			].join("\n"),
		);
		const drift = await runDoctor(fixture);
		assert.equal(drift.result.exitCode, 1);
		const driftAction = drift.envelope.actions.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(driftAction);
		assert.equal(driftAction.state, "drift");
		const driftDiagnostic = drift.envelope.diagnostics.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(driftDiagnostic);
		assert.equal(driftDiagnostic.code, "fragment-drift");
	} finally {
		await fixture.cleanup();
	}
});

test("File Fragment structural failures conflict and distinct markers may share a target", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "fragment", [
			{
				type: "file-fragment",
				input: "files/fragment.txt",
				inputContent: "body\n",
				target: "AGENTS.md",
			},
		]);
		await writeFile(
			join(fixture.consumerRoot, "AGENTS.md"),
			[
				"<!-- managed-by: source/fragment -->",
				"body",
				"<!-- end-managed-by: source/fragment -->",
				"<!-- managed-by: source/fragment -->",
				"body",
				"<!-- end-managed-by: source/fragment -->",
			].join("\n"),
		);
		const duplicate = await runDoctor(fixture);
		assert.equal(duplicate.result.exitCode, 1);
		const duplicateAction = duplicate.envelope.actions.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(duplicateAction);
		assert.equal(duplicateAction.state, "conflict");
		assert.deepEqual(
			duplicate.envelope.diagnostics
				.filter(({ recipe }) => recipe === "fragment")
				.map(({ code }) => code),
			["fragment-marker-collision"],
		);

		await writeFile(
			join(fixture.consumerRoot, "AGENTS.md"),
			["<!-- managed-by: source/fragment -->", "body"].join("\n"),
		);
		const incomplete = await runDoctor(fixture);
		const incompleteAction = incomplete.envelope.actions.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(incompleteAction);
		assert.equal(incompleteAction.state, "conflict");
		const incompleteDiagnostic = incomplete.envelope.diagnostics.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(incompleteDiagnostic);
		assert.equal(incompleteDiagnostic.code, "incomplete-fragment");

		await writeFile(
			join(fixture.consumerRoot, "AGENTS.md"),
			"ordinary <!-- managed-by: source/fragment --> text\n",
		);
		const inline = await runDoctor(fixture);
		const inlineAction = inline.envelope.actions.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(inlineAction);
		assert.equal(inlineAction.state, "missing");
		const inlineDiagnostic = inline.envelope.diagnostics.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(inlineDiagnostic);
		assert.equal(inlineDiagnostic.code, "fragment-missing");

		await writeFile(
			join(fixture.consumerRoot, "AGENTS.md"),
			[
				"<!-- managed-by: source/fragment -->",
				"body",
				"<!-- end-managed-by: source/other -->",
			].join("\n"),
		);
		const mismatched = await runDoctor(fixture);
		const mismatchedAction = mismatched.envelope.actions.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(mismatchedAction);
		assert.equal(mismatchedAction.state, "conflict");
		const mismatchedDiagnostic = mismatched.envelope.diagnostics.find(
			({ recipe }) => recipe === "fragment",
		);
		assert.ok(mismatchedDiagnostic);
		assert.equal(mismatchedDiagnostic.code, "incomplete-fragment");

		await writeRecipe(fixture.sourceRoot, "other-fragment", [
			{
				type: "file-fragment",
				input: "files/other.txt",
				inputContent: "other\n",
				target: "AGENTS.md",
			},
		]);
		const distinct = await runDoctor(fixture);
		assert.equal(
			distinct.envelope.diagnostics.some(
				({ code }) => code === "fragment-marker-collision",
			),
			false,
		);
		assert.equal(
			distinct.envelope.diagnostics.some(
				({ code }) => code === "file-target-collision",
			),
			false,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("optional Fragment failures warn, human output is actionable, and doctor is read-only", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "optional-fragment", [
			{
				type: "file-fragment",
				input: "files/missing.txt",
				target: "AGENTS.md",
				optional: true,
			},
		]);
		const json = await runCli(fixture, [
			"doctor",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(json.exitCode, 0);
		assert.equal(json.stderr, "");
		const jsonEnvelope = parseJsonOutput<DoctorEnvelope>(json.stdout);
		assert.equal(jsonEnvelope.status, "warning");

		const human = await runCli(fixture, [
			"doctor",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(human.exitCode, 0);
		assert.equal(human.stderr, "");
		assert.match(human.stdout, /status: warning/);
		assert.match(human.stdout, /source-input-missing/);
	} finally {
		await fixture.cleanup();
	}
});

test("install dry-run reports the complete plan and is read-only", async () => {
	const fixture = await createFixture();
	try {
		await rm(join(fixture.consumerRoot, "generated", "hello.txt"));
		const result = await runCli(fixture, [
			"install",
			"--dry-run",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<{
			command: string;
			changed: boolean;
			actions: Array<{ state: string }>;
		}>(result.stdout);
		assert.equal(envelope.command, "install");
		assert.equal(envelope.changed, false);
		assert.deepEqual(
			envelope.actions.map(({ state }) => state),
			["missing"],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("install creates a File and records ownership", async () => {
	const fixture = await createFixture();
	try {
		const target = join(fixture.consumerRoot, "generated", "hello.txt");
		await rm(target);
		await mkdir(join(fixture.consumerRoot, ".tbboot"));
		await writeFile(
			join(fixture.consumerRoot, ".tbboot", ".gitignore"),
			"/keep\n",
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		assert.equal(await readFile(target, "utf8"), "hello\n");
		const state = parseYaml(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", "state.yaml"),
				"utf8",
			),
		) as {
			schemaVersion: number;
			effects: Array<Record<string, unknown>>;
		};
		assert.equal(state.schemaVersion, 1);
		assert.equal(state.effects.length, 1);
		assert.equal(state.effects[0]?.type, "file");
		assert.equal(state.effects[0]?.created, true);
		assert.match(
			String(state.effects[0]?.artifactFingerprint),
			/^[0-9a-f]{64}$/,
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", ".gitignore"),
				"utf8",
			),
			"/keep\n/state.yaml\n",
		);
		await rm(join(fixture.consumerRoot, ".tbboot", ".gitignore"));
		const metadataRepair = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(metadataRepair.exitCode, 0);
		assert.equal(
			parseJsonOutput<{ changed: boolean }>(metadataRepair.stdout).changed,
			true,
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", ".gitignore"),
				"utf8",
			),
			"/state.yaml\n",
		);
		const beforeSecond = await snapshotTree(
			fixture.consumerRoot,
			fixture.profileRoot,
		);
		const second = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(second.exitCode, 0);
		assert.equal(
			parseJsonOutput<{ changed: boolean }>(second.stdout).changed,
			false,
		);
		assert.deepEqual(
			await snapshotTree(fixture.consumerRoot, fixture.profileRoot),
			beforeSecond,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("install blocks drift and force reconciles only the File", async () => {
	const fixture = await createFixture();
	try {
		const target = join(fixture.consumerRoot, "generated", "hello.txt");
		await rm(target);
		assert.equal(
			(
				await runWritableCli(fixture, [
					"install",
					"--root",
					fixture.consumerRoot,
				])
			).exitCode,
			0,
		);
		await writeFile(target, "local change\n");
		const blocked = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(blocked.exitCode, 1);
		assert.equal(await readFile(target, "utf8"), "local change\n");
		const forced = await runWritableCli(fixture, [
			"install",
			"--force",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(forced.exitCode, 0);
		assert.equal(await readFile(target, "utf8"), "hello\n");
	} finally {
		await fixture.cleanup();
	}
});

test("install creates distinct Managed blocks and force preserves unrelated content", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "first", [
			{
				type: "file-fragment",
				input: "files/first.txt",
				inputContent: "first\r\nline",
				target: "AGENTS.md",
			},
		]);
		await writeRecipe(fixture.sourceRoot, "second", [
			{
				type: "file-fragment",
				input: "files/second.txt",
				inputContent: "second\n",
				target: "AGENTS.md",
			},
		]);
		const target = join(fixture.consumerRoot, "AGENTS.md");
		await writeFile(target, "unmanaged\n");
		const first = await runWritableCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(first.exitCode, 0);
		const installed = await readFile(target, "utf8");
		assert.match(installed, /unmanaged/);
		assert.match(installed, /managed-by: source\/first/);
		assert.match(installed, /managed-by: source\/second/);
		await writeFile(
			target,
			installed.replace("first\nline", "changed locally"),
		);
		const blocked = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(blocked.exitCode, 1);
		const forced = await runWritableCli(fixture, [
			"install",
			"--force",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(forced.exitCode, 0);
		const reconciled = await readFile(target, "utf8");
		assert.match(reconciled, /unmanaged/);
		assert.match(reconciled, /first\nline/);
		assert.match(reconciled, /managed-by: source\/second/);
	} finally {
		await fixture.cleanup();
	}
});

test("install preflight conflicts prevent every write", async () => {
	const fixture = await createFixture();
	try {
		await rm(join(fixture.consumerRoot, "generated", "hello.txt"));
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../source",
				"  - provider: local",
				"    locator:",
				"      path: ./../source",
				"",
			].join("\n"),
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 1);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "tbboot.yaml"), "utf8"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../source",
				"  - provider: local",
				"    locator:",
				"      path: ./../source",
				"",
			].join("\n"),
		);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
			).catch(() => undefined),
			undefined,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("invalid Installation record blocks install before Artifact writes", async () => {
	const fixture = await createFixture();
	try {
		const target = join(fixture.consumerRoot, "generated", "hello.txt");
		await rm(target);
		await mkdir(join(fixture.consumerRoot, ".tbboot"));
		await writeFile(
			join(fixture.consumerRoot, ".tbboot", "state.yaml"),
			"schemaVersion: 2\neffects: []\n",
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 1);
		assert.equal(await readFile(target).catch(() => undefined), undefined);
		assert.equal(
			await readFile(join(fixture.consumerRoot, ".tbboot", ".gitignore")).catch(
				() => undefined,
			),
			undefined,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("force does not bypass structural File and Fragment conflicts", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "conflict", [
			{
				type: "file-fragment",
				input: "files/block.txt",
				inputContent: "conflict\n",
				target: "generated/hello.txt",
			},
		]);
		const result = await runWritableCli(fixture, [
			"install",
			"--force",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 1);
		assert.equal(
			await readFile(
				join(fixture.consumerRoot, "generated", "hello.txt"),
				"utf8",
			),
			"hello\n",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("force rejects nested Managed blocks and preserves non-UTF8 unrelated bytes", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "outer", [
			{
				type: "file-fragment",
				input: "files/outer.txt",
				inputContent: "outer\n",
				target: "AGENTS.md",
			},
		]);
		await writeRecipe(fixture.sourceRoot, "inner", [
			{
				type: "file-fragment",
				input: "files/inner.txt",
				inputContent: "inner\n",
				target: "AGENTS.md",
			},
		]);
		const target = join(fixture.consumerRoot, "AGENTS.md");
		const nested = Buffer.from(
			[
				"<!-- managed-by: source/outer -->",
				"outer",
				"<!-- managed-by: source/inner -->",
				"inner",
				"<!-- end-managed-by: source/inner -->",
				"<!-- end-managed-by: source/outer -->",
				"",
			].join("\n"),
		);
		await writeFile(target, nested);
		const blocked = await runWritableCli(fixture, [
			"install",
			"--force",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(blocked.exitCode, 1);
		assert.deepEqual(await readFile(target), nested);

		await writeFile(target, Buffer.from([0xff, 0xfe, 0x0a]));
		await rm(join(fixture.sourceRoot, "inner"), { recursive: true });
		await rm(join(fixture.sourceRoot, "outer"), { recursive: true });
		await writeRecipe(fixture.sourceRoot, "bytes", [
			{
				type: "file-fragment",
				input: "files/block.txt",
				inputContent: "bytes\n",
				target: "AGENTS.md",
			},
		]);
		const appended = await runWritableCli(fixture, [
			"install",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(appended.exitCode, 0);
		assert.deepEqual(
			(await readFile(target)).subarray(0, 3),
			Buffer.from([0xff, 0xfe, 0x0a]),
		);
	} finally {
		await fixture.cleanup();
	}
});

test("contract gates fail before discovery and omitted root uses cwd", async () => {
	const fixture = await createFixture();
	const validManifest = [
		"schemaVersion: 1",
		"sources:",
		"  - provider: local",
		"    locator:",
		"      path: ../source",
		"",
	].join("\n");
	try {
		const cases: Array<[string, string]> = [
			["sources: []\n", "schema-version-missing"],
			["schemaVersion: 2\nsources: []\n", "schema-version-unsupported"],
			["schemaVersion: 1\nschemaVersion: 1\nsources: []\n", "yaml-parse-error"],
			[
				`${validManifest}---\nschemaVersion: 1\nsources: []\n`,
				"yaml-parse-error",
			],
			[`%YAML 1.1\n---\n${validManifest}`, "yaml-parse-error"],
			[`${validManifest}unexpected: true\n`, "schema-validation-failed"],
		];
		for (const [text, code] of cases) {
			await writeFile(join(fixture.consumerRoot, "tbboot.yaml"), text);
			const { result, envelope } = await runDoctor(fixture);
			assert.equal(result.exitCode, 1, code);
			const firstDiagnostic = envelope.diagnostics[0];
			assert.ok(firstDiagnostic);
			assert.equal(firstDiagnostic.code, code);
			assert.equal(envelope.actions.length, 0);
		}

		await writeFile(join(fixture.consumerRoot, "tbboot.yaml"), validManifest);
		await writeFile(
			join(fixture.sourceRoot, "source.yaml"),
			"schemaVersion: 2\n",
		);
		const invalidSource = await runDoctor(fixture);
		const invalidSourceDiagnostic = invalidSource.envelope.diagnostics[0];
		assert.ok(invalidSourceDiagnostic);
		assert.equal(invalidSourceDiagnostic.code, "schema-version-unsupported");
		assert.equal(invalidSource.envelope.actions.length, 0);

		await writeFile(
			join(fixture.sourceRoot, "source.yaml"),
			"schemaVersion: 1\n",
		);
		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/hello.txt",
				"requires:",
				"  - source: other",
				"    recipe: baseline",
				"",
			].join("\n"),
		);
		const invalidRecipe = await runDoctor(fixture);
		const invalidRecipeDiagnostic = invalidRecipe.envelope.diagnostics[0];
		assert.ok(invalidRecipeDiagnostic);
		assert.equal(invalidRecipeDiagnostic.code, "requires-not-supported");
		assert.equal(invalidRecipe.envelope.actions.length, 0);

		await writeFile(
			join(fixture.sourceRoot, "baseline", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: file",
				"    input: files/hello.txt",
				"    target: generated/hello.txt",
				"",
			].join("\n"),
		);
		const omittedRoot = await runCli(fixture, ["doctor", "--json"], {
			cwd: fixture.consumerRoot,
		});
		assert.equal(omittedRoot.exitCode, 0);
		assert.equal(omittedRoot.stderr, "");
		const omittedRootEnvelope = parseJsonOutput<DoctorEnvelope>(
			omittedRoot.stdout,
		);
		const firstAction = omittedRootEnvelope.actions[0];
		assert.ok(firstAction);
		assert.equal(firstAction.state, "satisfied");
	} finally {
		await fixture.cleanup();
	}
});

test("read-only process helper rejects filesystem writes", async () => {
	const fixture = await createFixture();
	try {
		const target = join(fixture.consumerRoot, "generated", "unexpected.txt");
		const script = `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'unexpected\\n')`;
		await assert.rejects(
			() =>
				runReadOnlyCommand(fixture, {
					file: process.execPath,
					args: ["-e", script],
					cwd: projectRoot,
				}),
			{ name: "AssertionError" },
		);
	} finally {
		await fixture.cleanup();
	}
});

test("read-only process helper checks writes when the command rejects", async () => {
	const fixture = await createFixture();
	try {
		const target = join(fixture.consumerRoot, "generated", "unexpected.txt");
		const script = [
			`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'unexpected\\n')`,
			"setInterval(() => {}, 1000)",
		].join(";");
		await assert.rejects(
			() =>
				runReadOnlyCommand(fixture, {
					file: process.execPath,
					args: ["-e", script],
					cwd: projectRoot,
					timeoutMs: 100,
				}),
			(error: unknown) => {
				assert(error instanceof Error);
				assert.equal(error.name, "AssertionError");
				assert.match(error.message, /read-only process modified/);
				return true;
			},
		);
	} finally {
		await fixture.cleanup();
	}
});
