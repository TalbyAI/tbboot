import type { Issue } from "./types.ts";

export type PreflightInput = {
	issue: Issue;
	status: string;
	baseRef: string;
};

export type PreflightResult =
	| { ok: true }
	| { ok: false; reasons: string[] };

export function preflight(input: PreflightInput): PreflightResult {
	const reasons: string[] = [];
	if (input.issue.state !== "OPEN") reasons.push(`Issue is ${input.issue.state}`);
	if (!input.issue.labels.includes("ready-for-agent")) {
		reasons.push("Issue lacks ready-for-agent");
	}
	const openBlockers = input.issue.blockedBy.filter((blocker) => blocker.state === "OPEN");
	if (openBlockers.length > 0) {
		reasons.push(
			`Issue has ${openBlockers.length} open blocker${openBlockers.length === 1 ? "" : "s"}`,
		);
	}
	if (input.status.trim()) reasons.push("base checkout is dirty");
	if (!input.baseRef.trim()) reasons.push("base ref is empty");
	return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
}
