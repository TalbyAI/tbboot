import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseJsonOutput, runCommand } from "./support.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "src", "cli.ts");

async function createFixture(): Promise<{
	root: string;
	profileRoot: string;
	catalogPath: string;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(
		join(process.env.TEMP ?? process.env.TMP ?? ".", "tbboot-catalog-"),
	);
	const profileRoot = join(root, "profile");
	await mkdir(profileRoot);
	const catalogPath = join(root, "team.yaml");
	await writeFile(
		catalogPath,
		[
			"schemaVersion: 1",
			"entries:",
			"  - title: Team defaults",
			"    description: Shared repository setup",
			"    keywords: [team, defaults]",
			"    source:",
			"      provider: git",
			"      locator:",
			"        repository: https://example.com/team.git",
			"",
		].join("\n"),
		"utf8",
	);
	return {
		root,
		profileRoot,
		catalogPath,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

async function runCli(
	fixture: { root: string; profileRoot: string },
	args: string[],
) {
	return runCommand({
		file: process.execPath,
		args: [cliPath, ...args],
		cwd: fixture.root,
		env: {
			USERPROFILE: fixture.profileRoot,
			HOME: fixture.profileRoot,
		},
	});
}

test("rejects invalid Catalog command arguments with usage on stderr", async () => {
	const fixture = await createFixture();
	try {
		for (const args of [
			["catalog"],
			["catalog", "list", "extra"],
			["catalog", "add"],
			["catalog", "info"],
			["catalog", "search"],
			["catalog", "remove"],
			["catalog", "list", "--unknown"],
			["catalog", "search", "term", "one", "two"],
			["catalog", "add", "path", "name", "extra"],
		]) {
			const result = await runCli(fixture, args);
			assert.equal(result.exitCode, 2, args.join(" "));
			assert.equal(result.stdout, "", args.join(" "));
			assert.match(result.stderr, /usage: tbboot catalog/, args.join(" "));
		}
	} finally {
		await fixture.cleanup();
	}
});

test("registers a Catalog under its basename without extension", async () => {
	const fixture = await createFixture();
	try {
		const before = await readFile(fixture.catalogPath);
		const result = await runCli(fixture, [
			"catalog",
			"add",
			"team.yaml",
			"--json",
		]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr, "");
		const envelope = parseJsonOutput<{ command: string; changed: boolean }>(
			result.stdout,
		);
		assert.equal(envelope.command, "catalog add");
		assert.equal(envelope.changed, true);
		const registry = parseYaml(
			await readFile(
				join(fixture.profileRoot, ".tbboot", "catalogs.yaml"),
				"utf8",
			),
		) as { catalogs: Array<{ name: string; path: string }> };
		assert.deepEqual(registry.catalogs, [
			{ name: "team", path: fixture.catalogPath },
		]);
		assert.deepEqual(await readFile(fixture.catalogPath), before);
	} finally {
		await fixture.cleanup();
	}
});

test("lists, inspects, and removes a Catalog without deleting its file", async () => {
	const fixture = await createFixture();
	try {
		await runCli(fixture, ["catalog", "add", "team.yaml", "--json"]);
		const listed = await runCli(fixture, ["catalog", "list", "--json"]);
		assert.equal(listed.exitCode, 0);
		const listEnvelope = parseJsonOutput<{
			catalogs: Array<{
				name: string;
				path: string;
				valid: boolean;
				entries: number;
			}>;
		}>(listed.stdout);
		assert.deepEqual(listEnvelope.catalogs, [
			{ name: "team", path: fixture.catalogPath, valid: true, entries: 1 },
		]);

		const info = await runCli(fixture, [
			"catalog",
			"info",
			fixture.catalogPath,
			"--json",
		]);
		assert.equal(info.exitCode, 0);
		const infoEnvelope = parseJsonOutput<{
			catalog: {
				name: string;
				path: string;
				entries: Array<{ title: string }>;
			};
		}>(info.stdout);
		assert.equal(infoEnvelope.catalog.name, "team");
		assert.equal(infoEnvelope.catalog.path, fixture.catalogPath);
		assert.equal(infoEnvelope.catalog.entries[0]?.title, "Team defaults");

		const removed = await runCli(fixture, [
			"catalog",
			"remove",
			"TEAM",
			"--json",
		]);
		assert.equal(removed.exitCode, 0);
		assert.equal(
			parseYaml(
				await readFile(
					join(fixture.profileRoot, ".tbboot", "catalogs.yaml"),
					"utf8",
				),
			).catalogs.length,
			0,
		);
		assert.equal(
			await readFile(fixture.catalogPath, "utf8").then(() => true),
			true,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("rejects invalid Catalogs, duplicate names, and duplicate paths", async () => {
	const fixture = await createFixture();
	try {
		const invalidPath = join(fixture.root, "invalid.yaml");
		await writeFile(invalidPath, "schemaVersion: 2\n", "utf8");
		const invalid = await runCli(fixture, [
			"catalog",
			"add",
			invalidPath,
			"--json",
		]);
		assert.equal(invalid.exitCode, 1);
		assert.equal(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(invalid.stdout)
				.diagnostics[0]?.code,
			"catalog-validation-failed",
		);

		const first = await runCli(fixture, [
			"catalog",
			"add",
			"team.yaml",
			"--json",
		]);
		assert.equal(first.exitCode, 0);
		const duplicateName = await runCli(fixture, [
			"catalog",
			"add",
			"team.yaml",
			"TEAM",
			"--json",
		]);
		assert.equal(duplicateName.exitCode, 1);
		assert.equal(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(
				duplicateName.stdout,
			).diagnostics[0]?.code,
			"catalog-name-duplicate",
		);
		const duplicatePath = await runCli(fixture, [
			"catalog",
			"add",
			"team.yaml",
			"other",
			"--json",
		]);
		assert.equal(duplicatePath.exitCode, 1);
		assert.equal(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(
				duplicatePath.stdout,
			).diagnostics[0]?.code,
			"catalog-path-duplicate",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("rejects duplicate Source identities within one Catalog", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			fixture.catalogPath,
			[
				"schemaVersion: 1",
				"entries:",
				"  - title: First",
				"    description: First",
				"    keywords: [one]",
				"    source:",
				"      provider: git",
				"      locator:",
				"        repository: https://example.com/team.git",
				"  - title: Second",
				"    description: Second",
				"    keywords: [two]",
				"    source:",
				"      provider: git",
				"      locator:",
				"        repository: https://example.com/team.git",
				"      selector:",
				"        ref: main",
				"",
			].join("\n"),
			"utf8",
		);
		const result = await runCli(fixture, [
			"catalog",
			"add",
			"team.yaml",
			"--json",
		]);
		assert.equal(result.exitCode, 1);
		assert.equal(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(result.stdout)
				.diagnostics[0]?.code,
			"catalog-entry-duplicate-source",
		);
		assert.equal(
			await readFile(
				join(fixture.profileRoot, ".tbboot", "catalogs.yaml"),
			).catch(() => undefined),
			undefined,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("searches globally or within one Catalog with deterministic matching", async () => {
	const fixture = await createFixture();
	const secondPath = join(fixture.root, "other.yaml");
	try {
		await writeFile(
			secondPath,
			[
				"schemaVersion: 1",
				"entries:",
				"  - title: Alpha defaults",
				"    description: Team setup",
				"    keywords: [shared]",
				"    source:",
				"      provider: git",
				"      locator:",
				"        repository: https://example.com/team.git",
				"",
			].join("\n"),
			"utf8",
		);
		assert.equal(
			(await runCli(fixture, ["catalog", "add", "team.yaml", "--json"]))
				.exitCode,
			0,
		);
		assert.equal(
			(
				await runCli(fixture, [
					"catalog",
					"add",
					"other.yaml",
					"Other",
					"--json",
				])
			).exitCode,
			0,
		);

		const global = await runCli(fixture, [
			"catalog",
			"search",
			"defaults",
			"--json",
		]);
		assert.equal(global.exitCode, 0);
		const globalEnvelope = parseJsonOutput<{
			results: Array<{ catalog: string; title: string }>;
		}>(global.stdout);
		assert.deepEqual(
			globalEnvelope.results.map(({ catalog, title }) => [catalog, title]),
			[
				["Other", "Alpha defaults"],
				["team", "Team defaults"],
			],
		);

		const scoped = await runCli(fixture, [
			"catalog",
			"search",
			"TEAM",
			"tEaM",
			"--json",
		]);
		assert.equal(scoped.exitCode, 0);
		const scopedEnvelope = parseJsonOutput<{
			results: Array<{ catalog: string; title: string }>;
		}>(scoped.stdout);
		assert.deepEqual(
			scopedEnvelope.results.map(({ catalog, title }) => [catalog, title]),
			[["team", "Team defaults"]],
		);

		const none = await runCli(fixture, [
			"catalog",
			"search",
			"missing",
			"--json",
		]);
		assert.equal(none.exitCode, 0);
		assert.deepEqual(
			parseJsonOutput<{ results: unknown[] }>(none.stdout).results,
			[],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("normalizes relative local Source paths and reports external Catalog changes", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			fixture.catalogPath,
			[
				"schemaVersion: 1",
				"entries:",
				"  - title: First",
				"    description: First",
				"    keywords: [one]",
				"    source:",
				"      provider: local",
				"      locator:",
				"        path: sources/one",
				"  - title: Second",
				"    description: Second",
				"    keywords: [two]",
				"    source:",
				"      provider: local",
				"      locator:",
				"        path: ./sources/../sources/one",
				"",
			].join("\n"),
			"utf8",
		);
		const duplicate = await runCli(fixture, [
			"catalog",
			"add",
			"team.yaml",
			"--json",
		]);
		assert.equal(duplicate.exitCode, 1);
		assert.equal(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(
				duplicate.stdout,
			).diagnostics[0]?.code,
			"catalog-entry-duplicate-source",
		);

		await writeFile(
			fixture.catalogPath,
			"schemaVersion: 1\nentries: []\n",
			"utf8",
		);
		assert.equal(
			(await runCli(fixture, ["catalog", "add", "team.yaml", "--json"]))
				.exitCode,
			0,
		);
		const registryPath = join(fixture.profileRoot, ".tbboot", "catalogs.yaml");
		const registryBefore = await readFile(registryPath);
		await writeFile(fixture.catalogPath, "schemaVersion: 2\n", "utf8");
		const listed = await runCli(fixture, ["catalog", "list", "--json"]);
		assert.equal(listed.exitCode, 1);
		assert.equal(
			parseJsonOutput<{ diagnostics: Array<{ code: string }> }>(listed.stdout)
				.diagnostics[0]?.code,
			"catalog-validation-failed",
		);
		assert.deepEqual(await readFile(registryPath), registryBefore);
	} finally {
		await fixture.cleanup();
	}
});
