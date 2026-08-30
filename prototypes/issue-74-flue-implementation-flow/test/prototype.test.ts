import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the checked-in fixture describes the ready Issue 65 scenario", async () => {
	const issue = JSON.parse(
		await readFile(new URL("../fixture/issue-65.json", import.meta.url), "utf8"),
	);
	assert.equal(issue.number, 65);
	assert.equal(issue.state, "OPEN");
	assert.ok(issue.labels.includes("ready-for-agent"));
	assert.deepEqual(issue.blockedBy, []);
});
