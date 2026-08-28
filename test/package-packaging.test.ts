import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("npm packing generates the JavaScript runtime before collecting package files", () => {
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { scripts?: { prepack?: string; pretest?: string } };
	assert.equal(packageJson.scripts?.prepack, "npm run build:runtime");
	assert.equal(packageJson.scripts?.pretest, "npm run build:runtime");
});

test("package check exercises local, global, and npx consumers", () => {
	const result = spawnSync(process.execPath, ["scripts/check-pack.mjs"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Local install: OK/);
	assert.match(result.stdout, /Global install: OK/);
	assert.match(result.stdout, /npx install: OK/);
});
