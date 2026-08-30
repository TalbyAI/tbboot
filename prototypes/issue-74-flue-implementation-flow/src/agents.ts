import { readFileSync } from "node:fs";
import { init, useModel, useSandbox, useSkill, defineSkill, type Agent } from "@flue/runtime";
import { local, start } from "@flue/runtime/node";
import type { AgentRequest, AgentResult, Role } from "./workflow.ts";

export const FLUE_MODEL = "openrouter/openai/gpt-5.6-luna";

const issueFlowSkill = defineSkill({
	name: "issue-flow",
	description: "Implement or review one prepared GitHub Issue inside the assigned worktree.",
	instructions: readFileSync(new URL("./skills/issue-flow/SKILL.md", import.meta.url), "utf8"),
});

export function createLiveAgentRunner() {
	const requests = new Map<Role, AgentRequest>();
	const agents = new Map<Role, Agent>();
	for (const role of ["implementer", "verifier", "reviewer"] as const) {
		const roleAgent: Agent = () => {
			const request = requests.get(role);
			if (!request) throw new Error(`No request was registered for ${role}`);
			const { cwd } = request;
			useModel(FLUE_MODEL, { thinkingLevel: "xhigh" });
			useSandbox(local({ cwd }));
			useSkill(issueFlowSkill);
			return roleInstructions(request);
		};
		agents.set(role, roleAgent);
	}

	const runtime = start({
		agents: [...agents.entries()].map(([role, agent]) => ({
			agent,
			name: `issue-flow-${role}`,
		})),
	});

	return {
		agent: async (request: AgentRequest): Promise<AgentResult> => {
			requests.set(request.role, request);
			const flue = await runtime;
			const agent = agents.get(request.role) as Agent;
			const handle = init(agent, { id: `issue-${request.issue.number}-${request.role}` });
			const receipt = await handle.dispatch(roleInstructions(request));
			const reply = await handle.read(receipt);
			return { ...request, text: reply.text, changedPaths: [] };
		},
		close: async () => {
			await (await runtime).stop();
		},
	};
}

function roleInstructions(request: AgentRequest): string {
	const issue = `Issue #${request.issue.number}: ${request.issue.title}\n\n${request.issue.body}`;
	if (request.role === "implementer") {
		return `Implement this issue in the assigned worktree. Read the repository instructions and run its relevant checks. Do not commit or publish anything; the host owns the commit gate.\n\n${issue}`;
	}
	if (request.role === "verifier") {
		return `Verify the committed implementation for this issue from the assigned review worktree. Run checks and report concrete failures or evidence. Do not modify files or publish anything.\n\n${issue}`;
	}
	return `Review the committed implementation for this issue from the assigned review worktree. Inspect the diff and report correctness, scope, and acceptance-criteria findings. Do not modify files or publish anything.\n\n${issue}`;
}
