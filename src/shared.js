import { isAbsolute, relative, sep } from "node:path";
export function finish(envelope) {
    const hasError = envelope.diagnostics.some(({ severity }) => severity === "error");
    const hasWarning = envelope.diagnostics.some(({ severity }) => severity === "warning");
    envelope.status = hasError ? "error" : hasWarning ? "warning" : "ok";
    return { envelope, exitCode: hasError ? 1 : 0 };
}
export function errorCode(error) {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function isNotFound(error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}
export function isInside(root, candidate) {
    const child = relative(root, candidate);
    return (child === "" ||
        (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)));
}
export function normalizeNewlines(value) {
    return value.replace(/\r\n?/g, "\n");
}
