import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createWorktree } from "../src/git.ts";
import { preflight } from "../src/preflight.ts";

test("the checked-in fixture describes the ready Issue 65 scenario", async () => {
	const issue = JSON.parse(
		await readFile(new URL("../fixture/issue-65.json", import.meta.url), "utf8"),
	);
	assert.equal(issue.number, 65);
	assert.equal(issue.state, "OPEN");
	assert.ok(issue.labels.includes("ready-for-agent"));
	assert.deepEqual(issue.blockedBy, []);
});

test("preflight reports every blocking reason", () => {
	const result = preflight({
		issue: {
			number: 1,
			state: "CLOSED",
			title: "closed",
			body: "",
			labels: [],
			blockedBy: [{ number: 2, state: "OPEN" }],
			url: "",
		},
		status: " M src/file.ts",
		baseRef: "abc123",
	});
	assert.equal(result.ok, false);
	assert.deepEqual(result.reasons, [
		"Issue is CLOSED",
		"Issue lacks ready-for-agent",
		"Issue has 1 open blocker",
		"base checkout is dirty",
	]);
});

test("worktree creation uses the known base ref and leaves the current ref unchanged", async () => {
	const calls: string[][] = [];
	const git = {
		run: async (args: readonly string[]) => {
			calls.push([...args]);
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	};
	const worktree = await createWorktree(git, {
		baseRef: "abc123",
		branch: "issue/65-run",
		path: "C:/temp/run",
	});
	assert.equal(worktree.branch, "issue/65-run");
	assert.equal(worktree.baseRef, "abc123");
	assert.deepEqual(calls[0], [
		"worktree",
		"add",
		"-b",
		"issue/65-run",
		"C:/temp/run",
		"abc123",
	]);
});
