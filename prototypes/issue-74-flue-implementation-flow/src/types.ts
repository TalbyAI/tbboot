export type IssueState = "OPEN" | "CLOSED";

export type Blocker = {
	number: number;
	state: IssueState;
};

export type Issue = {
	number: number;
	state: IssueState;
	title: string;
	body: string;
	labels: string[];
	blockedBy: Blocker[];
	url: string;
};

export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type GitRunner = {
	run(args: readonly string[], cwd?: string): Promise<CommandResult>;
};

export type Worktree = {
	baseRef: string;
	branch: string;
	path: string;
};
