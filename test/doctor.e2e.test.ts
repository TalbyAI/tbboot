import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { DoctorEnvelope } from "../src/doctor.ts";
import { planLocalInstall } from "../src/doctor.ts";
import {
	GitSourceError,
	isGitRevisionAllowed,
	materializeGitSource,
	resolveGitSelector,
} from "../src/git.ts";
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

type GitFixture = {
	repo: string;
	revisions: {
		base: string;
		x: string;
		y: string;
		upperA: string;
		upperB: string;
	};
	cleanup: () => Promise<void>;
};

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

async function git(repo: string, args: string[]): Promise<string> {
	const result = await runCommand({
		...commandFor("git", args),
		cwd: repo,
		env: {
			GIT_CONFIG_GLOBAL: join(repo, ".git-global-config"),
			GIT_CONFIG_SYSTEM: join(repo, ".git-system-config"),
		},
	});
	assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}

async function commitGitFiles(
	repo: string,
	files: Record<string, string>,
	message: string,
): Promise<string> {
	for (const [path, content] of Object.entries(files)) {
		const file = join(repo, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}
	await git(repo, ["add", "--all"]);
	await git(repo, ["commit", "--quiet", "-m", message]);
	return git(repo, ["rev-parse", "HEAD"]);
}

async function createGitFixture(): Promise<GitFixture> {
	const repo = await mkdtemp(join(tmpdir(), "tbboot-git-"));
	try {
		await git(repo, ["init", "--quiet", "--initial-branch=main"]);
		await git(repo, ["config", "user.name", "tbboot fixture"]);
		await git(repo, ["config", "user.email", "fixture@example.test"]);
		await git(repo, ["config", "commit.gpgsign", "false"]);
		await git(repo, ["config", "tag.gpgsign", "false"]);
		await git(repo, [
			"config",
			"core.hooksPath",
			join(repo, ".git", "no-hooks"),
		]);
		const base = await commitGitFiles(
			repo,
			{
				"source.yaml": "schemaVersion: 1\n",
				"baseline/recipe.yaml":
					"schemaVersion: 1\nsteps:\n  - type: file\n    input: input.txt\n    target: generated.txt\n",
				"baseline/input.txt": "base\n",
				"nested/source/source.yaml": "schemaVersion: 1\n",
				"nested/source/baseline/recipe.yaml":
					"schemaVersion: 1\nsteps:\n  - type: file\n    input: input.txt\n    target: nested.txt\n",
				"nested/source/baseline/input.txt": "nested\n",
			},
			"base",
		);
		await git(repo, ["tag", "v1", base]);
		await git(repo, ["branch", "line-x"]);
		await git(repo, ["checkout", "--quiet", "line-x"]);
		const x = await commitGitFiles(repo, { "x.txt": "x\n" }, "x");
		await git(repo, ["tag", "v2", x]);
		await git(repo, ["tag", "same", x]);
		await git(repo, ["checkout", "--quiet", "main"]);
		await git(repo, ["branch", "line-y"]);
		await git(repo, ["checkout", "--quiet", "line-y"]);
		const y = await commitGitFiles(repo, { "y.txt": "y\n" }, "y");
		await git(repo, ["branch", "same", y]);
		await git(repo, ["checkout", "--quiet", "line-x"]);
		await git(repo, ["merge", "--quiet", "--no-ff", "--no-edit", "line-y"]);
		const upperA = await git(repo, ["rev-parse", "HEAD"]);
		await git(repo, ["tag", "range-a", upperA]);
		await git(repo, ["checkout", "--quiet", "line-y"]);
		await git(repo, ["merge", "--quiet", "--no-ff", "--no-edit", x]);
		const upperB = await git(repo, ["rev-parse", "HEAD"]);
		await git(repo, ["tag", "range-b", upperB]);
		return {
			repo,
			revisions: { base, x, y, upperA, upperB },
			cleanup: () => rm(repo, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(repo, { recursive: true, force: true });
		throw error;
	}
}

test("local install plans keep only the input bytes and derive creation", async () => {
	const fixture = await createFixture();
	try {
		const plan = await planLocalInstall(fixture.consumerRoot, false);
		const artifact = plan.artifacts.find(
			({ recipe, type }) => recipe === "baseline" && type === "file",
		);
		assert.ok(artifact);
		assert.equal(artifact.input.toString(), "hello\n");
		assert.equal("sourceInput" in artifact, false);
		assert.equal("created" in artifact, false);
	} finally {
		await fixture.cleanup();
	}
});

test("Source dependencies resolve transitively, in order, and only once", async () => {
	const fixture = await createFixture();
	const sharedRoot = join(fixture.root, "shared");
	const firstRoot = join(fixture.root, "first");
	const secondRoot = join(fixture.root, "second");
	const rootSource = join(fixture.root, "root-source");
	try {
		for (const sourceRoot of [sharedRoot, firstRoot, secondRoot, rootSource]) {
			await mkdir(sourceRoot, { recursive: true });
			await writeFile(join(sourceRoot, "source.yaml"), "schemaVersion: 1\n");
		}
		await writeRecipe(sharedRoot, "shared", [
			{
				input: "files/shared.txt",
				inputContent: "shared\n",
				target: "generated/shared.txt",
			},
		]);
		await writeRecipe(firstRoot, "first", [
			{
				input: "files/first.txt",
				inputContent: "first\n",
				target: "generated/first.txt",
			},
		]);
		await writeRecipe(secondRoot, "second", [
			{
				input: "files/second.txt",
				inputContent: "second\n",
				target: "generated/second.txt",
			},
		]);
		await writeRecipe(rootSource, "root", [
			{
				input: "files/root.txt",
				inputContent: "root\n",
				target: "generated/root.txt",
			},
		]);
		const dependency = (name: string, path: string): string[] => [
			`  - name: ${name}`,
			"    provider: local",
			"    locator:",
			`      path: ${path}`,
		];
		await writeFile(
			join(firstRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				...dependency("shared", "../shared"),
				"",
			].join("\n"),
		);
		await writeFile(
			join(secondRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				...dependency("shared", "../shared"),
				"",
			].join("\n"),
		);
		await writeFile(
			join(rootSource, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				...dependency("first", "../first"),
				...dependency("second", "../second"),
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../root-source",
				"",
			].join("\n"),
		);

		const result = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const envelope = parseJsonOutput<
			DoctorEnvelope & { actions: Array<{ target: string }> }
		>(result.stdout);
		assert.deepEqual(
			envelope.actions.map(({ target }) => target),
			[
				"generated/shared.txt",
				"generated/first.txt",
				"generated/second.txt",
				"generated/root.txt",
			],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("Git Source dependencies are resolved before their dependent Source", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		const revision = await commitGitFiles(
			gitFixture.repo,
			{
				"source.yaml": [
					"schemaVersion: 1",
					"dependencies:",
					"  - name: nested",
					"    provider: git",
					"    locator:",
					`      repository: ${JSON.stringify(gitFixture.repo)}`,
					"      path: nested/source",
					"    selector:",
					"      ref: v1",
					"",
				].join("\n"),
			},
			"source-dependency",
		);
		await git(gitFixture.repo, ["tag", "deps", revision]);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"    selector:",
				"      ref: deps",
				"",
			].join("\n"),
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const envelope = parseJsonOutput<DoctorEnvelope>(result.stdout);
		assert.deepEqual(
			envelope.actions.map(({ target }) => target),
			["nested.txt", "generated.txt"],
		);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as { sources: unknown[] };
		assert.equal(lock.sources.length, 2);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("Source dependency cycles fail preflight without writing artifacts", async () => {
	const fixture = await createFixture();
	const firstRoot = join(fixture.root, "cycle-first");
	const secondRoot = join(fixture.root, "cycle-second");
	try {
		for (const sourceRoot of [firstRoot, secondRoot]) {
			await mkdir(sourceRoot, { recursive: true });
			await writeRecipe(sourceRoot, "cycle", [
				{
					input: "files/value.txt",
					inputContent: "value\n",
					target: "generated/cycle.txt",
				},
			]);
		}
		await writeFile(
			join(firstRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: second",
				"    provider: local",
				"    locator:",
				"      path: ../cycle-second",
				"",
			].join("\n"),
		);
		await writeFile(
			join(secondRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: first",
				"    provider: local",
				"    locator:",
				"      path: ../cycle-first",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../cycle-first",
				"",
			].join("\n"),
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 1);
		assert.notEqual(result.stdout.trim(), "", result.stderr);
		const envelope = parseJsonOutput<DoctorEnvelope>(result.stdout);
		const cycle = envelope.diagnostics.find(
			({ code }) => code === "source-dependency-cycle",
		);
		assert.ok(cycle);
		assert.match(cycle.message, /cycle-first.*cycle-second.*cycle-first/);
		assert.equal(existsSync(join(fixture.consumerRoot, "generated")), true);
		assert.equal(
			existsSync(join(fixture.consumerRoot, "generated", "cycle.txt")),
			false,
		);
		assert.equal(
			existsSync(join(fixture.consumerRoot, ".tbboot", "state.yaml")),
			false,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("same-level duplicate and incompatible Source dependencies fail preflight", async () => {
	const fixture = await createFixture();
	const dependencyRoot = join(fixture.root, "duplicate-dependency");
	const rootSource = join(fixture.root, "duplicate-root");
	const gitFixture = await createGitFixture();
	try {
		await mkdir(dependencyRoot, { recursive: true });
		await mkdir(rootSource, { recursive: true });
		await writeRecipe(dependencyRoot, "dependency", [
			{
				input: "files/value.txt",
				inputContent: "value\n",
				target: "generated/dependency.txt",
			},
		]);
		await writeRecipe(rootSource, "root", [
			{
				input: "files/value.txt",
				inputContent: "root\n",
				target: "generated/root.txt",
			},
		]);
		await writeFile(
			join(rootSource, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: first",
				"    provider: local",
				"    locator:",
				"      path: ../duplicate-dependency",
				"  - name: second",
				"    provider: local",
				"    locator:",
				"      path: ../duplicate-dependency",
				"    selector: {}",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../duplicate-root",
				"",
			].join("\n"),
		);
		const duplicate = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(duplicate.exitCode, 1);
		assert.ok(
			parseJsonOutput<DoctorEnvelope>(duplicate.stdout).diagnostics.some(
				({ code }) => code === "duplicate-source",
			),
		);
		assert.equal(
			existsSync(join(fixture.consumerRoot, "generated", "dependency.txt")),
			false,
		);

		await writeFile(
			join(rootSource, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: v1",
				"    provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"      path: nested/source",
				"    selector:",
				"      ref: v1",
				"  - name: v2",
				"    provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"      path: nested/source",
				"    selector:",
				"      ref: v2",
				"",
			].join("\n"),
		);
		const incompatible = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(incompatible.exitCode, 1);
		assert.ok(
			parseJsonOutput<DoctorEnvelope>(incompatible.stdout).diagnostics.some(
				({ code }) => code === "git-selector-incompatible",
			),
		);
		assert.equal(
			existsSync(join(fixture.consumerRoot, "tbboot.lock.yaml")),
			false,
		);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("Git selector provider resolves refs, ranges, and intersections", async () => {
	const fixture = await createGitFixture();
	try {
		assert.equal(
			(await resolveGitSelector(fixture.repo, [{ ref: "v1" }])).revision,
			fixture.revisions.base,
		);
		assert.equal(
			(await resolveGitSelector(fixture.repo, [{ ref: "refs/tags/v2" }]))
				.revision,
			fixture.revisions.x,
		);
		assert.equal(
			(
				await resolveGitSelector(pathToFileURL(fixture.repo).href, [
					{ ref: "refs/heads/line-x" },
				])
			).revision,
			fixture.revisions.upperA,
		);
		assert.equal(
			(await resolveGitSelector(fixture.repo, [{ from: "v1", to: "v2" }]))
				.revision,
			fixture.revisions.x,
		);
		assert.equal(
			(await resolveGitSelector(fixture.repo, [{ from: "v2", to: "v2" }]))
				.revision,
			fixture.revisions.x,
		);
		assert.equal(
			(
				await resolveGitSelector(fixture.repo, [
					{ ref: "v2" },
					{ ref: "refs/tags/same" },
				])
			).revision,
			fixture.revisions.x,
		);
		await assert.rejects(
			() => resolveGitSelector(fixture.repo, [{ ref: "missing" }]),
			(error) =>
				error instanceof GitSourceError && error.code === "git-ref-not-found",
		);
		await assert.rejects(
			() =>
				resolveGitSelector(join(fixture.repo, "missing-repository"), [
					{ ref: "v1" },
				]),
			(error) =>
				error instanceof GitSourceError && error.code === "git-repository-read",
		);
		await assert.rejects(
			() => resolveGitSelector(fixture.repo, [{ ref: "same" }]),
			(error) =>
				error instanceof GitSourceError && error.code === "git-ref-ambiguous",
		);
		await assert.rejects(
			() => resolveGitSelector(fixture.repo, [{ from: "v2", to: "v1" }]),
			(error) =>
				error instanceof GitSourceError && error.code === "git-range-invalid",
		);
		await assert.rejects(
			() => resolveGitSelector(fixture.repo, [{ ref: "v1" }, { ref: "v2" }]),
			(error) =>
				error instanceof GitSourceError &&
				error.code === "git-selector-incompatible",
		);
		await assert.rejects(
			() =>
				resolveGitSelector(fixture.repo, [
					{ from: "v1", to: "range-a" },
					{ from: "v1", to: "range-b" },
				]),
			(error) =>
				error instanceof GitSourceError &&
				error.code === "git-selector-ambiguous" &&
				Array.isArray(error.details.revisions) &&
				error.details.revisions.includes(fixture.revisions.x) &&
				error.details.revisions.includes(fixture.revisions.y),
		);
		await git(fixture.repo, [
			"update-ref",
			"refs/remotes/origin/topic/release",
			fixture.revisions.x,
		]);
		await git(fixture.repo, [
			"update-ref",
			"refs/remotes/upstream/release",
			fixture.revisions.y,
		]);
		assert.equal(
			(await resolveGitSelector(fixture.repo, [{ ref: "release" }])).revision,
			fixture.revisions.y,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("Git Source materialization supports repository roots and internal paths", async () => {
	const fixture = await createGitFixture();
	try {
		const rootSource = await materializeGitSource(
			fixture.repo,
			{
				provider: "git",
				locator: { repository: fixture.repo },
				selector: { ref: "v1" },
			},
			fixture.revisions.base,
		);
		try {
			assert.equal(
				(await readFile(join(rootSource.sourceRoot, "source.yaml"))).toString(),
				"schemaVersion: 1\n",
			);
		} finally {
			await rootSource.cleanup();
		}
		await assert.rejects(
			() =>
				materializeGitSource(
					fixture.repo,
					{
						provider: "git",
						locator: { repository: fixture.repo },
					},
					"not-a-git-object",
				),
			(error) =>
				error instanceof GitSourceError &&
				error.code === "git-repository-read" &&
				error.message.includes("full Git object name"),
		);
		await assert.rejects(
			() =>
				isGitRevisionAllowed(fixture.repo, { ref: "v1" }, "not-a-git-object"),
			(error) =>
				error instanceof GitSourceError &&
				error.code === "git-repository-read" &&
				error.message.includes("full Git object name"),
		);

		const reference = {
			provider: "git" as const,
			locator: { repository: fixture.repo, path: "nested/source" },
			selector: { ref: "v1" as const },
		};
		const first = await materializeGitSource(
			fixture.repo,
			reference,
			fixture.revisions.base,
		);
		const second = await materializeGitSource(
			fixture.repo,
			reference,
			fixture.revisions.base,
		);
		try {
			assert.equal(
				(await readFile(join(first.sourceRoot, "source.yaml"))).toString(),
				"schemaVersion: 1\n",
			);
			assert.equal(first.fingerprint, second.fingerprint);
		} finally {
			await first.cleanup();
			await second.cleanup();
		}
	} finally {
		await fixture.cleanup();
	}
});

test("doctor resolves Git Sources at the repository root and internal paths", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"      path: nested/source",
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		await writeFile(join(fixture.consumerRoot, "generated.txt"), "base\n");
		await writeFile(join(fixture.consumerRoot, "nested.txt"), "nested\n");
		const result = await runGitReadOnlyCommand(fixture, gitFixture.repo, {
			...commandFor(await installedBin(), [
				"doctor",
				"--json",
				"--root",
				fixture.consumerRoot,
			]),
			cwd: projectRoot,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<DoctorEnvelope>(result.stdout);
		assert.equal(envelope.status, "ok");
		assert.deepEqual(
			envelope.actions.map(({ target }) => target),
			["generated.txt", "nested.txt"],
		);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

async function configureGitConsumer(
	fixture: Fixture,
	gitFixture: GitFixture,
	selector: string,
): Promise<void> {
	await writeFile(
		join(fixture.consumerRoot, "tbboot.yaml"),
		[
			"schemaVersion: 1",
			"sources:",
			"  - provider: git",
			"    locator:",
			`      repository: ${gitFixture.repo}`,
			"    selector:",
			`      ref: ${selector}`,
			"",
		].join("\n"),
	);
}

test("install creates and reuses an authoritative Git lockfile", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await configureGitConsumer(fixture, gitFixture, "line-y");
		const first = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(first.exitCode, 0, `${first.stdout}\n${first.stderr}`);
		const lockPath = join(fixture.consumerRoot, "tbboot.lock.yaml");
		const firstLock = parseYaml(await readFile(lockPath, "utf8")) as {
			schemaVersion: number;
			sources: Array<{
				source: {
					provider: string;
					locator: { repository: string };
					selector: unknown;
				};
				revision: string;
				fingerprint: string;
			}>;
		};
		assert.equal(firstLock.schemaVersion, 1);
		assert.equal(firstLock.sources.length, 1);
		const firstEntry = firstLock.sources[0];
		assert.ok(firstEntry);
		assert.equal(firstEntry.source.provider, "git");
		assert.equal(
			firstEntry.source.locator.repository,
			await realpath(gitFixture.repo),
		);
		assert.deepEqual(firstEntry.source.selector, { ref: "line-y" });
		assert.match(firstEntry.revision, /^[0-9a-f]{40}$/);
		assert.match(firstEntry.fingerprint, /^[0-9a-f]{64}$/);
		const state = parseYaml(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", "state.yaml"),
				"utf8",
			),
		) as { effects: Array<{ revision?: string }> };
		assert.equal(state.effects[0]?.revision, firstEntry.revision);
		await writeFile(join(gitFixture.repo, "baseline/input.txt"), "changed\n");
		await git(gitFixture.repo, ["add", "--all"]);
		await git(gitFixture.repo, ["commit", "--quiet", "-m", "advance"]);

		const second = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(second.exitCode, 0, `${second.stdout}\n${second.stderr}`);
		const secondLock = parseYaml(
			await readFile(lockPath, "utf8"),
		) as typeof firstLock;
		assert.equal(secondLock.sources[0]?.revision, firstEntry.revision);
		assert.equal(
			(await readFile(join(fixture.consumerRoot, "generated.txt"))).toString(),
			"base\n",
		);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("Git lockfile and artifacts stay untouched when another source fails preflight", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				`    locator:\n      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"  - provider: local",
				"    locator:",
				"      path: ../missing-source",
				"",
			].join("\n"),
		);
		const result = await runGitReadOnlyCommand(fixture, gitFixture.repo, {
			...commandFor(await installedBin(), [
				"install",
				"--json",
				"--root",
				fixture.consumerRoot,
			]),
			cwd: projectRoot,
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.stdout, /source-read/);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("update-lock removes Git entries no longer declared", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"      path: nested/source",
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		const initial = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(initial.exitCode, 0, `${initial.stdout}\n${initial.stderr}`);
		await configureGitConsumer(fixture, gitFixture, "v1");
		const update = await runWritableCli(fixture, [
			"install",
			"--update-lock",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(update.exitCode, 0, `${update.stdout}\n${update.stderr}`);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as { sources: Array<{ source: { locator: { path?: string } } }> };
		assert.equal(lock.sources.length, 1);
		assert.equal(lock.sources[0]?.source.locator.path, undefined);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("stale Git lockfiles require update and frozen mode blocks missing entries", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await configureGitConsumer(fixture, gitFixture, "v1");
		await writeFile(
			join(fixture.consumerRoot, "tbboot.lock.yaml"),
			"schemaVersion: 1\nsources: []\n",
		);
		const lockPath = join(fixture.consumerRoot, "tbboot.lock.yaml");
		await rm(lockPath);
		const frozen = await runGitReadOnlyCommand(fixture, gitFixture.repo, {
			...commandFor(await installedBin(), [
				"install",
				"--dry-run",
				"--frozen-lockfile",
				"--json",
				"--root",
				fixture.consumerRoot,
			]),
			cwd: projectRoot,
		});
		assert.equal(frozen.exitCode, 1);
		assert.deepEqual(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(
				frozen.stdout,
			).diagnostics.map(({ code }) => code),
			["lockfile-missing"],
		);

		const initial = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(initial.exitCode, 0, `${initial.stdout}\n${initial.stderr}`);
		const lockBeforeStale = await readFile(lockPath);
		const artifactBeforeStale = await readFile(
			join(fixture.consumerRoot, "generated.txt"),
		);
		await configureGitConsumer(fixture, gitFixture, "line-y");
		const normal = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(normal.exitCode, 1);
		assert.deepEqual(await readFile(lockPath), lockBeforeStale);
		assert.deepEqual(
			await readFile(join(fixture.consumerRoot, "generated.txt")),
			artifactBeforeStale,
		);
		const update = await runWritableCli(fixture, [
			"install",
			"--update-lock",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(update.exitCode, 0, `${update.stdout}\n${update.stderr}`);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as { sources: Array<{ source: unknown }> };
		const updatedEntry = lock.sources[0];
		assert.ok(updatedEntry);
		assert.deepEqual((updatedEntry.source as { selector: unknown }).selector, {
			ref: "line-y",
		});
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("invalid Git lockfiles block resolution before Git access", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${join(gitFixture.repo, "missing-repository")}`,
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.lock.yaml"),
			"schemaVersion: 1\nsources: [\n",
		);
		const result = await runGitReadOnlyCommand(fixture, gitFixture.repo, {
			...commandFor(await installedBin(), [
				"install",
				"--json",
				"--root",
				fixture.consumerRoot,
			]),
			cwd: projectRoot,
		});
		assert.equal(result.exitCode, 1);
		assert.deepEqual(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(
				result.stdout,
			).diagnostics.map(({ code }) => code),
			["lockfile-invalid"],
		);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("Git locator paths are normalized before duplicate detection", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"      path: nested/./source",
				"    selector:",
				"      ref: v1",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"      path: nested/source",
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 1);
		assert.ok(
			envelope.diagnostics.some(({ code }) => code === "duplicate-source"),
		);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("root Git duplicate diagnostics point at locator", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		const { envelope } = await runDoctor(fixture);
		const duplicate = envelope.diagnostics.find(
			({ code }) => code === "duplicate-source",
		);
		assert.ok(duplicate);
		assert.equal(duplicate.path, "/sources/1/locator");
		assert.match(duplicate.message, /\/sources\/0\/locator/);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("lock updates replace equivalent normalized Git locators", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"      path: nested/./source",
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		const repositoryAlias = join(fixture.root, "git-alias");
		await symlink(
			gitFixture.repo,
			repositoryAlias,
			process.platform === "win32" ? "junction" : "dir",
		);
		const relativeRepository = relative(fixture.consumerRoot, repositoryAlias)
			.split(sep)
			.join("/");
		await writeFile(
			join(fixture.consumerRoot, "tbboot.lock.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - source:",
				"      provider: git",
				"      locator:",
				`        repository: ${relativeRepository}`,
				"        path: nested/./source",
				"      selector:",
				"        ref: v1",
				"    revision: old",
				"    fingerprint: old",
				"",
			].join("\n"),
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--update-lock",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as {
			sources: Array<{
				source: { locator: { repository: string; path?: string } };
			}>;
		};
		assert.equal(lock.sources.length, 1);
		assert.equal(
			lock.sources[0]?.source.locator.repository,
			await realpath(gitFixture.repo),
		);
		assert.equal(lock.sources[0]?.source.locator.path, "nested/source");
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("compatible Git selectors reuse one authoritative lock entry independent of declaration order", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      from: v1",
				"      to: v2",
				"",
			].join("\n"),
		);
		const first = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(first.exitCode, 0, `${first.stdout}\n${first.stderr}`);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      to: v2",
				"      from: v1",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		const second = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(second.exitCode, 0, `${second.stdout}\n${second.stderr}`);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("unlocked Git sources reuse first-pass resolution during lock finalization", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	const tracePath = join(fixture.root, "git-trace.json");
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${pathToFileURL(gitFixture.repo).href}`,
				"    selector:",
				"      ref: v1",
				"",
			].join("\n"),
		);
		const result = await runWritableCli(
			fixture,
			["install", "--json", "--root", fixture.consumerRoot],
			{ env: { GIT_TRACE2_EVENT: tracePath } },
		);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const cloneCount = (await readFile(tracePath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
			.filter(
				({ event, argv }) => event === "start" && argv?.includes("clone"),
			).length;
		assert.equal(cloneCount, 2);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("frozen lockfiles validate every convergent Git selector", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		const lockedSource = await materializeGitSource(
			fixture.consumerRoot,
			{
				provider: "git",
				locator: { repository: gitFixture.repo },
				selector: { from: "v1", to: "v2" },
			},
			gitFixture.revisions.base,
		);
		const fingerprint = lockedSource.fingerprint;
		await lockedSource.cleanup();
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      ref: v2",
				"  - provider: git",
				"    locator:",
				`      repository: ${gitFixture.repo}`,
				"    selector:",
				"      from: v1",
				"      to: v2",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.lock.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - source:",
				"      provider: git",
				"      locator:",
				`        repository: ${gitFixture.repo}`,
				"      selector:",
				"        from: v1",
				"        to: v2",
				`    revision: ${gitFixture.revisions.base}`,
				`    fingerprint: ${fingerprint}`,
				"",
			].join("\n"),
		);

		const result = await runGitReadOnlyCommand(fixture, gitFixture.repo, {
			...commandFor(await installedBin(), [
				"install",
				"--dry-run",
				"--frozen-lockfile",
				"--json",
				"--root",
				fixture.consumerRoot,
			]),
			cwd: projectRoot,
		});
		assert.equal(result.exitCode, 1);
		assert.ok(
			parseJsonOutput<DoctorEnvelope>(result.stdout).diagnostics.some(
				({ code }) => code === "lockfile-stale",
			),
		);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("compatible transitive Git selectors converge independent of discovery order", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	const firstRoot = join(fixture.root, "first");
	const secondRoot = join(fixture.root, "second");
	const bridgeRoot = join(fixture.root, "bridge");
	try {
		const c1 = await commitGitFiles(
			gitFixture.repo,
			{ "nested/source/source.yaml": "schemaVersion: 1\n# c1\n" },
			"c1",
		);
		await git(gitFixture.repo, ["tag", "c1", c1]);
		const c2 = await commitGitFiles(
			gitFixture.repo,
			{ "nested/source/source.yaml": "schemaVersion: 1\n# c2\n" },
			"c2",
		);
		await git(gitFixture.repo, ["tag", "c2", c2]);
		for (const sourceRoot of [firstRoot, secondRoot, bridgeRoot]) {
			await mkdir(sourceRoot, { recursive: true });
		}
		await writeFile(
			join(firstRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: shared",
				"    provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"      path: nested/source",
				"    selector:",
				"      from: c1",
				"      to: c2",
				"",
			].join("\n"),
		);
		await writeFile(
			join(secondRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: bridge",
				"    provider: local",
				"    locator:",
				"      path: ../bridge",
				"",
			].join("\n"),
		);
		await writeFile(
			join(bridgeRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: shared",
				"    provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"      path: nested/source",
				"    selector:",
				"      from: v1",
				"      to: c1",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../first",
				"  - provider: local",
				"    locator:",
				"      path: ../second",
				"",
			].join("\n"),
		);

		const result = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as {
			sources: Array<{
				source: { locator: { path?: string } };
				revision: string;
			}>;
		};
		assert.equal(lock.sources.length, 1);
		assert.equal(lock.sources[0]?.source.locator.path, "nested/source");
		assert.equal(lock.sources[0]?.revision, c1);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("discarded Source revisions do not keep unreachable Git dependencies in the lockfile", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	const firstRoot = join(fixture.root, "first");
	const secondRoot = join(fixture.root, "second");
	const bridgeRoot = join(fixture.root, "bridge");
	try {
		const c1 = await commitGitFiles(
			gitFixture.repo,
			{ "nested/source/source.yaml": "schemaVersion: 1\n# c1\n" },
			"c1",
		);
		await git(gitFixture.repo, ["tag", "c1", c1]);
		const c2 = await commitGitFiles(
			gitFixture.repo,
			{
				"nested/source/source.yaml": [
					"schemaVersion: 1",
					"dependencies:",
					"  - name: discarded",
					"    provider: git",
					"    locator:",
					`      repository: ${JSON.stringify(gitFixture.repo)}`,
					"      path: nested/dependency",
					"    selector:",
					"      ref: c2",
					"",
				].join("\n"),
				"nested/dependency/source.yaml": "schemaVersion: 1\n",
			},
			"c2",
		);
		await git(gitFixture.repo, ["tag", "c2", c2]);
		for (const sourceRoot of [firstRoot, secondRoot, bridgeRoot]) {
			await mkdir(sourceRoot, { recursive: true });
		}
		await writeFile(
			join(firstRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: shared",
				"    provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"      path: nested/source",
				"    selector:",
				"      from: c1",
				"      to: c2",
				"",
			].join("\n"),
		);
		await writeFile(
			join(secondRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: bridge",
				"    provider: local",
				"    locator:",
				"      path: ../bridge",
				"",
			].join("\n"),
		);
		await writeFile(
			join(bridgeRoot, "source.yaml"),
			[
				"schemaVersion: 1",
				"dependencies:",
				"  - name: shared",
				"    provider: git",
				"    locator:",
				`      repository: ${JSON.stringify(gitFixture.repo)}`,
				"      path: nested/source",
				"    selector:",
				"      from: v1",
				"      to: c1",
				"",
			].join("\n"),
		);
		await writeFile(
			join(fixture.consumerRoot, "tbboot.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - provider: local",
				"    locator:",
				"      path: ../first",
				"  - provider: local",
				"    locator:",
				"      path: ../second",
				"",
			].join("\n"),
		);

		const result = await runWritableCli(fixture, [
			"install",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as {
			sources: Array<{
				source: { locator: { path?: string } };
				revision: string;
			}>;
		};
		assert.deepEqual(
			lock.sources.map(({ source }) => source.locator.path),
			["nested/source"],
		);
		assert.equal(lock.sources[0]?.revision, c1);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

test("update-lock prunes Git entries for a local-only Manifest", async () => {
	const fixture = await createFixture();
	const gitFixture = await createGitFixture();
	try {
		await writeFile(
			join(fixture.consumerRoot, "tbboot.lock.yaml"),
			[
				"schemaVersion: 1",
				"sources:",
				"  - source:",
				"      provider: git",
				"      locator:",
				`        repository: ${JSON.stringify(gitFixture.repo)}`,
				"        path: nested/source",
				"      selector:",
				"        ref: v1",
				`    revision: ${gitFixture.revisions.base}`,
				"    fingerprint: stale",
				"",
			].join("\n"),
		);
		const result = await runWritableCli(fixture, [
			"install",
			"--update-lock",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		const lock = parseYaml(
			await readFile(join(fixture.consumerRoot, "tbboot.lock.yaml"), "utf8"),
		) as { sources: unknown[] };
		assert.deepEqual(lock.sources, []);
	} finally {
		await gitFixture.cleanup();
		await fixture.cleanup();
	}
});

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

async function runGitReadOnlyCommand(
	fixture: Fixture,
	gitRepository: string,
	command: CommandOptions,
): Promise<CommandResult> {
	const before = await snapshotTree(
		fixture.consumerRoot,
		gitRepository,
		fixture.profileRoot,
	);
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
		const after = await snapshotTree(
			fixture.consumerRoot,
			gitRepository,
			fixture.profileRoot,
		);
		assert.deepEqual(after, before, "Git doctor modified a watched tree");
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

test("parses lockfile modes and rejects duplicates or incompatible modes", async () => {
	const fixture = await createFixture();
	try {
		for (const flag of ["--update-lock", "--frozen-lockfile"]) {
			const result = await runCli(fixture, [
				"install",
				"--dry-run",
				"--json",
				"--root",
				fixture.consumerRoot,
				flag,
			]);
			assert.equal(result.exitCode, 0, flag);
			assert.equal(result.stderr, "", flag);
			assert.equal(
				parseJsonOutput<{ command: string }>(result.stdout).command,
				"install",
			);
		}

		for (const args of [
			["--update-lock", "--update-lock"],
			["--frozen-lockfile", "--frozen-lockfile"],
			["--update-lock", "--frozen-lockfile"],
		]) {
			const result = await runCli(fixture, [
				"install",
				"--dry-run",
				"--root",
				fixture.consumerRoot,
				...args,
			]);
			assert.equal(result.exitCode, 2, args.join(" "));
			assert.equal(result.stdout, "", args.join(" "));
			assert.match(result.stderr, /usage: tbboot install/, args.join(" "));
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

test("reports Git repository errors and duplicate normalized local Sources", async () => {
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
			["git-repository-read", "duplicate-source"],
		);
		const firstDiagnostic = envelope.diagnostics[0];
		assert.ok(firstDiagnostic);
		assert.equal(firstDiagnostic.path, "/sources/0/selector");
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

test("unauthorized optional Custom Steps produce a warning and no process", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "custom", [
			{ type: "custom", optional: true },
		]);
		const { result, envelope } = await runDoctor(fixture);
		assert.equal(result.exitCode, 0);
		assert.equal(envelope.status, "warning");
		assert.equal(envelope.actions.length, 2);
		const lastDiagnostic = envelope.diagnostics.at(-1);
		assert.ok(lastDiagnostic);
		assert.equal(lastDiagnostic.code, "custom-authorization-required");
		assert.equal(lastDiagnostic.severity, "warning");
	} finally {
		await fixture.cleanup();
	}
});

test("runs an authorized inline Custom lifecycle and uninstalls its effect", async () => {
	const fixture = await createFixture();
	try {
		await mkdir(join(fixture.sourceRoot, "custom"), { recursive: true });
		await writeFile(
			join(fixture.sourceRoot, "custom", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      content: |",
				"        const { access } = await import('node:fs/promises');",
				"        const { join } = await import('node:path');",
				"        try { await access(join(request.consumerRoot, 'custom.txt')); return { status: 'ok', changed: false }; }",
				"        catch { return { status: 'missing', changed: false }; }",
				"    install:",
				"      runtime: node",
				"      content: |",
				"        const { writeFile } = await import('node:fs/promises');",
				"        const { join } = await import('node:path');",
				"        await writeFile(join(request.consumerRoot, 'custom.txt'), 'custom\\n');",
				"        return { status: 'ok', changed: true };",
				"    uninstall:",
				"      runtime: node",
				"      content: |",
				"        const { rm } = await import('node:fs/promises');",
				"        const { join } = await import('node:path');",
				"        await rm(join(request.consumerRoot, 'custom.txt'), { force: true });",
				"        return { status: 'ok', changed: true };",
				"",
			].join("\n"),
		);
		const install = await runWritableCli(fixture, [
			"install",
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(install.exitCode, 0, `${install.stdout}\n${install.stderr}`);
		assert.equal(install.stderr, "");
		const installed = parseJsonOutput<{
			actions: Array<{ type: string; state: string }>;
			changed: boolean;
		}>(install.stdout);
		assert.equal(installed.changed, true);
		assert.ok(
			installed.actions.some(
				({ type, state }) => type === "custom" && state === "ok",
			),
		);
		assert.equal(
			await readFile(join(fixture.consumerRoot, "custom.txt"), "utf8"),
			"custom\n",
		);

		const doctor = await runDoctor(
			fixture,
			"--allow-custom",
			fixture.sourceRoot,
		);
		assert.equal(doctor.result.exitCode, 0);
		assert.ok(
			doctor.envelope.actions.some(
				({ type, state }) => type === "custom" && state === "ok",
			),
		);

		const uninstall = await runWritableCli(fixture, [
			"uninstall",
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(
			uninstall.exitCode,
			0,
			`${uninstall.stdout}\n${uninstall.stderr}`,
		);
		assert.equal(uninstall.stderr, "");
		assert.equal(existsSync(join(fixture.consumerRoot, "custom.txt")), false);
		const state = parseYaml(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", "state.yaml"),
				"utf8",
			),
		) as { effects: Array<{ type: string }> };
		assert.equal(
			state.effects.some(({ type }) => type === "custom"),
			false,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("uninstall preserves Custom effects without an uninstall handler", async () => {
	const fixture = await createFixture();
	try {
		await mkdir(join(fixture.sourceRoot, "custom"), { recursive: true });
		await writeFile(
			join(fixture.sourceRoot, "custom", "recipe.yaml"),
			[
				"schemaVersion: 1",
				"steps:",
				"  - type: custom",
				"    check:",
				"      runtime: node",
				"      content: \"return { status: 'ok', changed: false };\"",
				"    install:",
				"      runtime: node",
				"      content: \"return { status: 'ok', changed: true };\"",
				"",
			].join("\n"),
		);
		const install = await runWritableCli(fixture, [
			"install",
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(install.exitCode, 0, `${install.stdout}\n${install.stderr}`);

		const uninstall = await runWritableCli(fixture, [
			"uninstall",
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(
			uninstall.exitCode,
			0,
			`${uninstall.stdout}\n${uninstall.stderr}`,
		);
		const envelope = parseJsonOutput<{
			status: string;
			diagnostics: Array<{ code: string; severity: string }>;
		}>(uninstall.stdout);
		assert.equal(envelope.status, "warning");
		assert.deepEqual(envelope.diagnostics.at(-1), {
			code: "uninstall-unsupported",
			severity: "warning",
			message: "Custom step does not declare an uninstall operation",
			source: fixture.sourceRoot,
			recipe: "custom",
			step: 1,
		});
		const state = parseYaml(
			await readFile(
				join(fixture.consumerRoot, ".tbboot", "state.yaml"),
				"utf8",
			),
		) as { effects: Array<{ type: string }> };
		assert.equal(
			state.effects.some(({ type }) => type === "custom"),
			true,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("install dry-run defers authorized Custom processes", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "custom", [{ type: "custom" }]);
		const before = await snapshotTree(
			fixture.consumerRoot,
			fixture.profileRoot,
		);
		const result = await runCli(fixture, [
			"install",
			"--dry-run",
			"--allow-custom",
			fixture.sourceRoot,
			"--json",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<{
			changed: boolean;
			actions: Array<{ type: string; state: string }>;
			diagnostics: Array<{ code: string }>;
		}>(result.stdout);
		assert.equal(envelope.changed, false);
		assert.ok(
			envelope.actions.some(
				({ type, state }) => type === "custom" && state === "deferred",
			),
		);
		assert.ok(
			envelope.diagnostics.some(({ code }) => code === "custom-check-deferred"),
		);
		assert.deepEqual(
			await snapshotTree(fixture.consumerRoot, fixture.profileRoot),
			before,
		);
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

test("force replaces the valid Managed block after inline marker text", async () => {
	const fixture = await createFixture();
	try {
		await writeRecipe(fixture.sourceRoot, "fragment", [
			{
				type: "file-fragment",
				input: "files/fragment.txt",
				inputContent: "new\n",
				target: "AGENTS.md",
			},
		]);
		const target = join(fixture.consumerRoot, "AGENTS.md");
		const marker = "source/fragment";
		await writeFile(
			target,
			[
				`unmanaged <!-- managed-by: ${marker} -->inline<!-- end-managed-by: ${marker} -->`,
				`<!-- managed-by: ${marker} -->`,
				"old",
				`<!-- end-managed-by: ${marker} -->`,
				"",
			].join("\n"),
		);

		const result = await runWritableCli(fixture, [
			"install",
			"--force",
			"--root",
			fixture.consumerRoot,
		]);
		assert.equal(result.exitCode, 0);
		assert.equal(
			await readFile(target, "utf8"),
			[
				`unmanaged <!-- managed-by: ${marker} -->inline<!-- end-managed-by: ${marker} -->`,
				`<!-- managed-by: ${marker} -->`,
				"new",
				`<!-- end-managed-by: ${marker} -->`,
				"",
			].join("\n"),
		);
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
