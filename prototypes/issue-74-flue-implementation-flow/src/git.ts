import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitRunner, Worktree } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function runGit(
	args: readonly string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const result = await execFileAsync("git", [...args], {
			cwd,
			encoding: "utf8",
			windowsHide: true,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			code?: number | string;
		};
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			exitCode: typeof failure.code === "number" ? failure.code : 1,
		};
	}
}

export async function createWorktree(
	git: GitRunner,
	input: { baseRef: string; branch: string; path: string },
): Promise<Worktree> {
	const result = await git.run([
		"worktree",
		"add",
		"-b",
		input.branch,
		input.path,
		input.baseRef,
	]);
	if (result.exitCode !== 0) {
		throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
	}
	return { ...input };
}
