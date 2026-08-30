import { join } from "node:path";
import { preflight } from "./preflight.ts";
import { writeArtifacts } from "./report.ts";
import type { Issue, Worktree } from "./types.ts";

export type Role = "implementer" | "verifier" | "reviewer";
export type Gate = "worktree" | "commit" | "publish";

export type AgentRequest = {
	role: Role;
	cwd: string;
	issue: Issue;
	baseRef: string;
};


export type AgentResult = {
	role: Role;
	cwd: string;
	text: string;
	changedPaths: string[];
	error?: string;
};

export type CheckResult = {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type WorkflowGit = {
	createWorktree(input: { baseRef: string; branch: string; path: string }): Promise<Worktree>;
	status(cwd: string): Promise<string>;
	snapshot(cwd: string): Promise<string>;
	commit(cwd: string, message: string): Promise<string>;
	diff(cwd: string, baseRef: string): Promise<string>;
	removeWorktree?(path: string): Promise<void>;
};

export type WorkflowOptions = {
	issue: Issue;
	baseRef: string;
	baseStatus?: string;
	outputDir: string;
	worktreeDir?: string;
	git: WorkflowGit;
	agent(request: AgentRequest): Promise<AgentResult>;
	checks(cwd: string): Promise<CheckResult[]>;
	approve(gate: Gate, details: Record<string, unknown>): Promise<boolean>;
	publishChanges?(details: { branch: string; commitSha: string }): Promise<{ status: "published"; url?: string }>;
	closeAgent?(): Promise<void>;
	publish: boolean;
};

export type WorkflowResult = {
	status: "ready-for-review" | "stopped" | "preflight-failed" | "needs-changes";
	stoppedAt?: Gate;
	issue: Issue;
	baseRef: string;
	branch?: string;
	commitSha?: string;
	worktrees: Partial<Record<Role, Worktree>>;
	checks: CheckResult[];
	reviews: Partial<Record<"verifier" | "reviewer", AgentResult>>;
	gates: Partial<Record<Gate, boolean>>;
	publication: { status: "disabled" | "denied" | "published"; url?: string };
	diff?: string;
	preflight?: { reasons: string[] };
};

export async function runWorkflow(options: WorkflowOptions): Promise<WorkflowResult> {
	const result: WorkflowResult = {
		status: "ready-for-review",
		issue: options.issue,
		baseRef: options.baseRef,
		worktrees: {},
		checks: [],
		reviews: {},
		gates: {},
		publication: { status: "disabled" },
	};
	const preflightResult = preflight({
		issue: options.issue,
		status: options.baseStatus ?? (await options.git.status(process.cwd())),
		baseRef: options.baseRef,
	});
	if (!preflightResult.ok) {
		result.status = "preflight-failed";
		result.preflight = { reasons: preflightResult.reasons };
		await finish(result, options);
		return result;
	}

	const worktreeApproved = await options.approve("worktree", { issue: options.issue.number, baseRef: options.baseRef });
	result.gates.worktree = worktreeApproved;
	if (!worktreeApproved) {
		return stopAt(result, options, "worktree");
	}

	const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const worktreeDir = options.worktreeDir ?? join(options.outputDir, "worktrees");
	const implementer = await options.git.createWorktree({
		baseRef: options.baseRef,
		branch: `issue/${options.issue.number}-run-${runId}`,
		path: join(worktreeDir, "implementer"),
	});
	result.branch = implementer.branch;
	result.worktrees.implementer = implementer;
	await options.agent({ role: "implementer", cwd: implementer.path, issue: options.issue, baseRef: options.baseRef });
	result.checks = await options.checks(implementer.path);
	if (result.checks.some((check) => check.exitCode !== 0)) {
		result.status = "needs-changes";
		await finish(result, options);
		return result;
	}

	const commitApproved = await options.approve("commit", { branch: implementer.branch, checks: result.checks });
	result.gates.commit = commitApproved;
	if (!commitApproved) {
		return stopAt(result, options, "commit");
	}
	result.commitSha = await options.git.commit(implementer.path, `Issue #${options.issue.number}: implement changes`);
	const reviewInputs = ( ["verifier", "reviewer"] as const).map((role) =>
		options.git.createWorktree({
			baseRef: result.commitSha as string,
			branch: `issue/${options.issue.number}-run-${runId}-${role}`,
			path: join(worktreeDir, role),
		}),
	);
	const [verifierWorktree, reviewerWorktree] = await Promise.all(reviewInputs);
	result.worktrees.verifier = verifierWorktree;
	result.worktrees.reviewer = reviewerWorktree;
	const reviews = await Promise.all([
		runReview(options, result, "verifier", verifierWorktree),
		runReview(options, result, "reviewer", reviewerWorktree),
	]);
	result.reviews.verifier = reviews[0];
	result.reviews.reviewer = reviews[1];
	result.diff = await options.git.diff(implementer.path, options.baseRef);
	if (reviews.some((review) => review.error)) result.status = "needs-changes";

	if (options.publish && result.status === "ready-for-review") {
		await writeArtifacts(options.outputDir, result as unknown as Record<string, unknown>);
		const publishApproved = await options.approve("publish", { branch: implementer.branch, commitSha: result.commitSha });
		result.gates.publish = publishApproved;
		if (!publishApproved) {
			result.publication = { status: "denied" };
		} else if (!options.publishChanges) {
			result.publication = { status: "denied" };
		} else {
			result.publication = await options.publishChanges({
				branch: implementer.branch,
				commitSha: result.commitSha as string,
			});
		}
	} else if (options.publish) {
		result.publication = { status: "denied" };
	}
	await finish(result, options);
	return result;
}

async function runReview(
	options: WorkflowOptions,
	result: WorkflowResult,
	role: "verifier" | "reviewer",
	worktree: Worktree,
): Promise<AgentResult> {
	const before = await options.git.snapshot(worktree.path);
	const review = await options.agent({ role, cwd: worktree.path, issue: options.issue, baseRef: result.commitSha as string });
	const after = await options.git.snapshot(worktree.path);
	return before === after
		? review
		: { ...review, error: `${role} modified its review worktree: ${worktree.path}` };
}

async function stopAt(result: WorkflowResult, options: WorkflowOptions, gate: Gate) {
	result.status = "stopped";
	result.stoppedAt = gate;
	await finish(result, options);
	return result;
}

async function finish(result: WorkflowResult, options: WorkflowOptions) {
	await writeArtifacts(options.outputDir, result as unknown as Record<string, unknown>);
	await options.closeAgent?.();
	if (result.status === "ready-for-review" && options.git.removeWorktree) {
		for (const worktree of Object.values(result.worktrees).reverse()) {
			if (worktree) await options.git.removeWorktree(worktree.path);
		}
	}
}
