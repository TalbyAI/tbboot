import { isAbsolute, relative, sep } from "node:path";

type FinishEnvelope = {
	status: "ok" | "warning" | "error";
	diagnostics: readonly { severity: "error" | "warning" }[];
};

export function finish<T extends FinishEnvelope>(
	envelope: T,
): { envelope: T; exitCode: 0 | 1 } {
	const hasError = envelope.diagnostics.some(
		({ severity }) => severity === "error",
	);
	const hasWarning = envelope.diagnostics.some(
		({ severity }) => severity === "warning",
	);
	envelope.status = hasError ? "error" : hasWarning ? "warning" : "ok";
	return { envelope, exitCode: hasError ? 1 : 0 };
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isNotFound(error: unknown): boolean {
	return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted)
		throw Object.assign(new Error("cancelled"), { code: "cancelled" });
}

export function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
	);
}

export function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}
