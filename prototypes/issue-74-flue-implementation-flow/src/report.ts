import { mkdir, writeFile } from "node:fs/promises";

export async function writeArtifacts(outputDir: string, result: Record<string, unknown>) {
	await mkdir(outputDir, { recursive: true });
	const reviews = (result.reviews ?? {}) as Record<string, { text?: string }>;
	const checks = result.checks ?? [];
	await Promise.all([
		writeFile(`${outputDir}/report.json`, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
		writeFile(`${outputDir}/checks.json`, `${JSON.stringify(checks, null, 2)}\n`, "utf8"),
		writeFile(`${outputDir}/diff.patch`, String(result.diff ?? ""), "utf8"),
		writeFile(`${outputDir}/verifier.md`, reviews.verifier?.text ?? "", "utf8"),
		writeFile(`${outputDir}/reviewer.md`, reviews.reviewer?.text ?? "", "utf8"),
		writeFile(`${outputDir}/pr-body.md`, buildPrBody(result), "utf8"),
	]);
}

function buildPrBody(result: Record<string, unknown>): string {
	const issue = result.issue as { number?: number; title?: string } | undefined;
	return [
		`# Issue #${issue?.number ?? "unknown"}: ${issue?.title ?? "implementation"}`,
		"",
		`Status: ${String(result.status)}`,
		`Commit: ${String(result.commitSha ?? "not created")}`,
		"",
		"This body was prepared locally. Publication is disabled unless explicitly requested and approved.",
		"",
	].join("\n");
}
