import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createWorktree, runGit } from "./git.ts";
import type { WorkflowGit } from "./workflow.ts";
import type { Issue, CommandResult, GitRunner } from "./types.ts";

const execFileAsync = promisify(execFile);
type GhRunner = (args: string[], cwd: string) => Promise<CommandResult>;

export function createGitHost(repoRoot: string): WorkflowGit {
	const runner: GitRunner = { run: (args, cwd = repoRoot) => runGit(args, cwd) };
	const output = async (args: string[], cwd: string) => {
		const result = await runGit(args, cwd);
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
		return result.stdout;
	};
	return {
		createWorktree: (input) => createWorktree(runner, input),
		status: (cwd) => output(["status", "--porcelain"], cwd),
		snapshot: (cwd) => output(["status", "--porcelain"], cwd),
		commit: async (cwd, message) => {
			await output(["add", "--all"], cwd);
			await output(["commit", "-m", message], cwd);
			return (await output(["rev-parse", "HEAD"], cwd)).trim();
		},
		diff: (cwd, baseRef) => output(["diff", "--binary", baseRef, "HEAD"], cwd),
		removeWorktree: async (path) => {
			await output(["worktree", "remove", "--force", path], repoRoot);
		},
	};
}

export async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	try {
		const result = await execFileAsync(command, args, { cwd, encoding: "utf8", windowsHide: true });
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr || failure.message,
			exitCode: typeof failure.code === "number" ? failure.code : 1,
		};
	}
}

export async function loadIssue(repoRoot: string, number: number, gh: GhRunner = runGh): Promise<Issue> {
	const [result, dependencies] = await Promise.all([
		gh(["issue", "view", String(number), "--json", "number,state,title,body,labels,url"], repoRoot),
		gh(["api", `repos/{owner}/{repo}/issues/${number}/dependencies/blocked_by`], repoRoot),
	]);
	const raw = JSON.parse(result.stdout) as {
		number: number;
		state: Issue["state"];
		title: string;
		body: string;
		labels?: Array<string | { name: string }>;
		url: string;
	};
	const blockedBy = JSON.parse(dependencies.stdout) as Array<{ number: number; state: string }>;
	return {
		number: raw.number,
		state: raw.state,
		title: raw.title,
		body: raw.body,
		labels: (raw.labels ?? []).map((label) => typeof label === "string" ? label : label.name),
		blockedBy: blockedBy.map((blocker) => ({
			number: blocker.number,
			state: blocker.state.toUpperCase() as Issue["state"],
		})),
		url: raw.url,
	};
}

export async function currentBase(repoRoot: string): Promise<{ ref: string; status: string }> {
	const [ref, status] = await Promise.all([
		requiredGit(["rev-parse", "HEAD"], repoRoot),
		requiredGit(["status", "--porcelain"], repoRoot),
	]);
	return { ref: ref.trim(), status };
}

export async function publishDraft(
	repoRoot: string,
	branch: string,
	issue: Issue,
	bodyFile: string,
): Promise<{ status: "published"; url?: string }> {
	await requiredGit(["push", "--set-upstream", "origin", branch], repoRoot);
	const result = await runGh([
		"pr",
		"create",
		"--draft",
		"--head",
		branch,
		"--title",
		`Issue #${issue.number}: ${issue.title}`,
		"--body-file",
		bodyFile,
	], repoRoot);
	const url = result.stdout.trim();
	if (!url) throw new Error("gh pr create did not return a PR URL");
	const expectedBody = await readFile(bodyFile, "utf8");
	const remote = await runGh(["pr", "view", url, "--json", "body"], repoRoot);
	const actualBody = (JSON.parse(remote.stdout) as { body?: string }).body ?? "";
	if (actualBody !== expectedBody) throw new Error("published PR body differs from the prepared body file");
	return { status: "published", url };
}

async function requiredGit(args: string[], cwd: string): Promise<string> {
	const result = await runGit(args, cwd);
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout;
}

async function runGh(args: string[], cwd: string): Promise<CommandResult> {
	try {
		const result = await execFileAsync("gh", args, { cwd, encoding: "utf8", windowsHide: true });
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
		throw new Error(failure.stderr || failure.stdout || failure.message);
	}
}
