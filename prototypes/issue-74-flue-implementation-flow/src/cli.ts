import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadEnvFile, stdin as input, stdout as output } from "node:process";
import { dirname, join, resolve } from "node:path";
import { createLiveAgentRunner } from "./agents.ts";
import { createFixtureOptions, readIssue65Fixture } from "./fixture.ts";
import { currentBase, createGitHost, loadIssue, publishDraft, runCommand } from "./host.ts";
import { runGit } from "./git.ts";
import { runWorkflow, type Gate } from "./workflow.ts";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(prototypeRoot, "..", "..");

export type CliResult = { exitCode: number; stdout: string };
export type RunCliOptions = { envFile?: string };

type Flags = {
	issue?: number;
	fixture: boolean;
	dryRun: boolean;
	publish: boolean;
	output?: string;
};

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
	loadPrototypeEnv(options.envFile);
	const flags = parseArgs(args);
	if (flags.fixture || flags.dryRun) {
		const issue = await readIssue65Fixture();
		const outputDir = flags.output
			? resolve(flags.output)
			: resolve(prototypeRoot, "runs", `fixture-${Date.now()}`);
		const result = await runWorkflow({
			...createFixtureOptions(issue, outputDir),
			publish: false,
		});
		return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
	}

	if (!flags.issue) throw new Error("live mode requires --issue <number>");
	if (!process.env.OPENROUTER_API_KEY) {
		throw new Error("live mode requires OPENROUTER_API_KEY; use --fixture --dry-run without credentials");
	}
	const issue = await loadIssue(repoRoot, flags.issue);
	const base = await currentBase(repoRoot);
	const outputDir = flags.output
		? resolve(flags.output)
		: resolve(prototypeRoot, "runs", `issue-${issue.number}-${Date.now()}`);
	const worktreeDir = await mkdtemp(join(repoRoot, "..", "tbboot-issue-74-worktrees-"));
	const live = createLiveAgentRunner();
	const git = createGitHost(repoRoot);
	const result = await runWorkflow({
		issue,
		baseRef: base.ref,
		baseStatus: base.status,
		outputDir,
		worktreeDir,
		git,
		agent: live.agent,
		closeAgent: live.close,
		checks: (cwd) => runChecks(cwd),
		approve: approveInteractive,
		publish: flags.publish,
		publishChanges: flags.publish
			? ({ branch }) => publishDraft(repoRoot, branch, issue, join(outputDir, "pr-body.md"))
			: undefined,
	});
	if (result.status === "ready-for-review") await rm(worktreeDir, { recursive: true, force: true });
	return { exitCode: result.status === "ready-for-review" ? 0 : 2, stdout: `${JSON.stringify(result, null, 2)}\n` };
}

export function loadPrototypeEnv(envFile = resolve(prototypeRoot, ".env")): void {
	if (existsSync(envFile)) loadEnvFile(envFile);
}

async function runChecks(cwd: string) {
	const install = await runCommand("npm", ["ci"], cwd);
	if (install.exitCode !== 0) return [{ command: "npm ci", ...install }];
	const test = await runCommand("npm", ["test"], cwd);
	const check = await runCommand("npm", ["run", "check"], cwd);
	return [
		{ command: "npm ci", ...install },
		{ command: "npm test", ...test },
		{ command: "npm run check", ...check },
	];
}

async function approveInteractive(gate: Gate, details: Record<string, unknown>): Promise<boolean> {
	if (!input.isTTY) return false;
	const readline = createInterface({ input, output });
	try {
		const answer = await readline.question(`HITL ${gate} ${JSON.stringify(details)}. Continue? [y/N] `);
		return /^(y|yes)$/i.test(answer.trim());
	} finally {
		readline.close();
	}
}

function parseArgs(args: string[]): Flags {
	const flags: Flags = { fixture: false, dryRun: false, publish: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--fixture") flags.fixture = true;
		else if (arg === "--dry-run") flags.dryRun = true;
		else if (arg === "--publish") flags.publish = true;
		else if (arg === "--issue") flags.issue = Number.parseInt(requireValue(args, ++index, arg), 10);
		else if (arg === "--output") flags.output = requireValue(args, ++index, arg);
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (flags.issue !== undefined && !Number.isInteger(flags.issue)) throw new Error("--issue must be an integer");
	return flags;
}

function requireValue(args: string[], index: number, flag: string): string {
	if (!args[index]) throw new Error(`${flag} requires a value`);
	return args[index];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCli(process.argv.slice(2))
		.then((result) => {
			process.stdout.write(result.stdout);
			process.exitCode = result.exitCode;
		})
		.catch((error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}
