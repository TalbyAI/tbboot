import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
