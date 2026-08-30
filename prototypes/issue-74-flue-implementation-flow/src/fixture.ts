import { readFile } from "node:fs/promises";
import type { Issue } from "./types.ts";
import type { WorkflowOptions } from "./workflow.ts";

export async function readIssue65Fixture(): Promise<Issue> {
	return JSON.parse(await readFile(new URL("../fixture/issue-65.json", import.meta.url), "utf8")) as Issue;
}

export function createFixtureOptions(issue: Issue, outputDir: string): WorkflowOptions {
	return {
		issue,
		baseRef: "fixture-base",
		baseStatus: "",
		outputDir,
		worktreeDir: `${outputDir}/worktrees`,
		git: {
			createWorktree: async (input) => ({ ...input }),
			status: async () => "",
			snapshot: async () => "clean",
			commit: async () => "fixture-commit-sha",
			diff: async () => "",
		},
		agent: async ({ role, cwd, issue, baseRef }) => ({
			role,
			cwd,
			issue,
			baseRef,
			text: `${role} fixture completed`,
			changedPaths: [],
		}),
		checks: async () => [{
			command: "fixture checks",
			exitCode: 0,
			stdout: "fixture checks passed",
			stderr: "",
		}],
		approve: async () => true,
		publish: false,
	};
}
