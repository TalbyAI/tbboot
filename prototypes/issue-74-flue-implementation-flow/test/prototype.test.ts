import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/git.ts";
import { preflight } from "../src/preflight.ts";
import { runWorkflow, type WorkflowOptions } from "../src/workflow.ts";
import { runCli } from "../src/cli.ts";
import type { Issue } from "../src/types.ts";

const readyIssue65: Issue = {
	number: 65,
	state: "OPEN",
	title: "Built-ins mediante el registro sin regresión del MVP",
	body: "Implement the built-ins through the static registry.",
	labels: ["ready-for-agent"],
	blockedBy: [],
	url: "https://github.com/TalbyAI/tbboot/issues/65",
};

async function withOutput<T>(callback: (outputDir: string) => Promise<T>): Promise<T> {
	const outputDir = await mkdtemp(join(tmpdir(), "tbboot-issue-74-test-"));
	try {
		return await callback(outputDir);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
}

function fixtureOptions(overrides: Partial<WorkflowOptions> = {}): WorkflowOptions {
	const worktree = async (input: { baseRef: string; branch: string; path: string }) => ({ ...input });
	return {
		issue: readyIssue65,
		baseRef: "base-sha",
		baseStatus: "",
		outputDir: "",
		git: {
			createWorktree: worktree,
			status: async () => "",
			snapshot: async () => "clean",
			commit: async () => "commit-sha",
			diff: async () => "diff",
		},
		agent: async ({ role, cwd }) => ({ role, cwd, text: "ok", changedPaths: [] }),
		checks: async () => [{ command: "node check.mjs", exitCode: 0, stdout: "ok", stderr: "" }],
		approve: async () => true,
		publishChanges: async () => ({ status: "published" as const }),
		publish: false,
		...overrides,
	};
}

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

test("denying the commit gate prevents commit and publication", async () => {
	await withOutput(async (outputDir) => {
		const events: string[] = [];
		const result = await runWorkflow(fixtureOptions({
			outputDir,
			approve: async (gate) => {
				events.push(`gate:${gate}`);
				return gate !== "commit";
			},
			git: {
				createWorktree: async (input) => ({ ...input }),
				status: async () => "",
				snapshot: async () => "clean",
				commit: async () => {
					events.push("commit");
					return "sha";
				},
				diff: async () => "diff",
				removeWorktree: async () => {
					events.push("remove");
				},
			},
			publishChanges: async () => {
				events.push("publish");
				return { status: "published" as const };
			},
		}));
		assert.equal(result.status, "stopped");
		assert.equal(result.stoppedAt, "commit");
		assert.deepEqual(result.gates, { worktree: true, commit: false });
		assert.deepEqual(events, ["gate:worktree", "gate:commit"]);
	});
});

test("verifier and reviewer run concurrently in distinct worktrees", async () => {
	await withOutput(async (outputDir) => {
		const started: string[] = [];
		let active = 0;
		let peak = 0;
		const result = await runWorkflow(fixtureOptions({
			outputDir,
			agent: async ({ role, cwd }) => {
				started.push(`${role}:${cwd}`);
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return { role, cwd, text: "ok", changedPaths: [] };
			},
		}));
		assert.equal(result.status, "ready-for-review");
		assert.equal(peak, 2);
		const verifierCwd = started.find((value) => value.startsWith("verifier:"));
		const reviewerCwd = started.find((value) => value.startsWith("reviewer:"));
		assert.ok(verifierCwd);
		assert.ok(reviewerCwd);
		assert.notEqual(verifierCwd, reviewerCwd);
	});
});

test("default execution never calls the publisher", async () => {
	await withOutput(async (outputDir) => {
		let published = false;
		const result = await runWorkflow(fixtureOptions({
			outputDir,
			publishChanges: async () => {
				published = true;
				return { status: "published" as const };
			},
		}));
		assert.equal(result.publication.status, "disabled");
		assert.equal(published, false);
		assert.deepEqual((await readdir(outputDir)).sort(), [
			"checks.json",
			"diff.patch",
			"pr-body.md",
			"report.json",
			"reviewer.md",
			"verifier.md",
		]);
		const report = JSON.parse(await readFile(join(outputDir, "report.json"), "utf8"));
		assert.equal(report.branch.startsWith("issue/65-run-"), true);
		assert.equal(report.commitSha, "commit-sha");
	});
});

test("a review agent changing its worktree is reported as a failed review", async () => {
	await withOutput(async (outputDir) => {
		const snapshots = new Map<string, number>();
		const result = await runWorkflow(fixtureOptions({
			outputDir,
			git: {
				createWorktree: async (input) => ({ ...input }),
				status: async () => "",
				snapshot: async (cwd) => {
					const count = (snapshots.get(cwd) ?? 0) + 1;
					snapshots.set(cwd, count);
					return cwd.endsWith("reviewer") && count === 2 ? " M report.md" : "clean";
				},
				commit: async () => "commit-sha",
				diff: async () => "diff",
			},
		}));
		assert.equal(result.status, "needs-changes");
		assert.match(result.reviews.reviewer?.error ?? "", /modified its review worktree/);
	});
});

test("live agent source uses OpenRouter Luna xhigh and local cwd", async () => {
	const source = await readFile(new URL("../src/agents.ts", import.meta.url), "utf8");
	assert.match(source, /openrouter\/openai\/gpt-5\.6-luna/);
	assert.match(source, /thinkingLevel:\s*["']xhigh["']/);
	assert.match(source, /local\(\{ cwd \}\)/);
	assert.doesNotMatch(source, /useSubagent\(/);
});

test("fixture dry-run does not require provider credentials", async () => {
	await withOutput(async (outputDir) => {
		const result = await runCli(["--fixture", "--dry-run", "--output", outputDir]);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /ready-for-review/);
	});
});

test("README documents the required safety and execution boundaries", async () => {
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	for (const term of ["OPENROUTER_API_KEY", "xhigh", "local()", "not a security", "--fixture", "--dry-run", "--issue 65", "--publish", ".env.example", "Copy-Item", "loadEnvFile"]) {
		assert.match(readme, new RegExp(term.replace(/[()]/g, "\\$&")));
	}
});

test("the environment example documents the OpenRouter key", async () => {
	const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
	assert.match(example, /^OPENROUTER_API_KEY=replace-with-your-openrouter-key$/m);
	assert.match(await readFile(new URL("../.gitignore", import.meta.url), "utf8"), /^\.env$/m);
});

test("launch loads OPENROUTER_API_KEY from its env file before fixture execution", async () => {
	await withOutput(async (outputDir) => {
		const envDir = await mkdtemp(join(tmpdir(), "tbboot-issue-74-env-"));
		const envFile = join(envDir, ".env");
		const previous = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			await writeFile(envFile, "OPENROUTER_API_KEY=fixture-openrouter-key\n", "utf8");
			const result = await runCli(["--fixture", "--dry-run", "--output", outputDir], { envFile });
			assert.equal(result.exitCode, 0);
			assert.equal(process.env.OPENROUTER_API_KEY, "fixture-openrouter-key");
		} finally {
			if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = previous;
			await rm(envDir, { recursive: true, force: true });
		}
	});
});
