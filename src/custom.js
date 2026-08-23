import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { validateDocument, } from "./contract.js";
import { isInside } from "./shared.js";
const execFileAsync = promisify(execFile);
export const MAX_TIMEOUT_MS = 2_147_483_647;
const CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUTS = {
    check: 60,
    install: 1_800,
    uninstall: 1_800,
};
const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;
const RANGE_RE = /^>=(\d+\.\d+(?:\.\d+)?)\s+<(\d+(?:\.\d+){0,2})$/;
const runtimeCache = new Map();
export const RUNTIME_DEFINITIONS = Object.freeze({
    node: Object.freeze({
        command: "node",
        range: ">=24.12 <25",
        versionArgs: ["--version"],
    }),
    pwsh: Object.freeze({
        command: "pwsh",
        range: ">=7.6 <8",
        versionArgs: ["-NoProfile", "--version"],
    }),
});
const ALL_CUSTOM_OPERATIONS = [
    "check",
    "install",
    "uninstall",
];
function runnerError(code, details = {}) {
    const error = new Error(typeof details.message === "string" ? details.message : code, { cause: details.cause });
    error.code = code;
    Object.assign(error, details);
    return error;
}
function compare(left, right) {
    return (left.major - right.major ||
        left.minor - right.minor ||
        left.patch - right.patch);
}
export function parseVersion(text) {
    const match = String(text).match(VERSION_RE);
    return match
        ? {
            major: Number(match[1]),
            minor: Number(match[2]),
            patch: Number(match[3] ?? 0),
        }
        : null;
}
export function parseRange(text) {
    const match = String(text).match(RANGE_RE);
    if (!match)
        throw runnerError("custom-runtime-selector", {
            message: `Unsupported runtime range: ${text}`,
        });
    const bound = (value) => {
        const parts = value.split(".").map(Number);
        return {
            major: parts[0],
            minor: parts[1] ?? 0,
            patch: parts[2] ?? 0,
        };
    };
    return {
        lower: { ...bound(match[1]), inclusive: true },
        upper: { ...bound(match[2]), inclusive: false },
    };
}
export function satisfies(version, range) {
    const parsed = parseRange(range);
    return (compare(version, parsed.lower) >= 0 && compare(version, parsed.upper) < 0);
}
function classifyRuntime(name, available, version, file, selector) {
    const definition = RUNTIME_DEFINITIONS[name];
    const range = selector ?? definition.range;
    const compatible = available && version !== null && satisfies(version, range);
    return {
        name,
        command: definition.command,
        file: available ? file : null,
        version: available ? version : null,
        status: !available ? "missing" : compatible ? "compatible" : "incompatible",
        supported: compatible,
    };
}
async function resolveExecutable(command) {
    const resolver = process.platform === "win32" ? "where.exe" : "which";
    try {
        const { stdout } = await execFileAsync(resolver, [command], {
            encoding: "utf8",
            windowsHide: true,
            shell: false,
        });
        const file = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        if (file)
            return file;
    }
    catch (error) {
        if (error.code === "ENOENT")
            throw error;
    }
    throw runnerError("runtime-missing", {
        message: `Unable to resolve runtime executable: ${command}`,
    });
}
async function detectRuntimeUncached(name, selector) {
    const definition = RUNTIME_DEFINITIONS[name];
    let file = process.execPath;
    let versionText = process.version;
    if (name === "pwsh") {
        file = definition.command;
        const temporaryProfile = await mkdtemp(join(tmpdir(), "tbboot-runtime-profile-"));
        try {
            const result = await execFileAsync(definition.command, definition.versionArgs, {
                encoding: "utf8",
                env: {
                    ...process.env,
                    USERPROFILE: temporaryProfile,
                    HOME: temporaryProfile,
                },
                windowsHide: true,
                shell: false,
            });
            versionText = result.stdout;
            file = await resolveExecutable(definition.command);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return classifyRuntime(name, false, null, null, selector);
            }
            throw runnerError("runtime-probe-failed", {
                message: `Runtime probe failed for ${name}`,
                cause: error,
            });
        }
        finally {
            await rm(temporaryProfile, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    return classifyRuntime(name, true, parseVersion(versionText), file, selector);
}
export async function detectRuntime(name, selector) {
    if (selector !== undefined)
        parseRange(selector);
    const key = `${name}\0${selector ?? ""}`;
    const cached = runtimeCache.get(key);
    if (cached !== undefined)
        return cached;
    const detected = detectRuntimeUncached(name, selector);
    runtimeCache.set(key, detected);
    try {
        return await detected;
    }
    catch (error) {
        if (runtimeCache.get(key) === detected)
            runtimeCache.delete(key);
        throw error;
    }
}
function nodeArgs(script, content) {
    const moduleSource = script === undefined
        ? `export default async function handler(request) {\n${content ?? ""}\n}`
        : undefined;
    const moduleUrl = script === undefined
        ? `data:text/javascript,${encodeURIComponent(moduleSource)}`
        : pathToFileURL(script).href;
    const bootstrap = [
        "let input = '';",
        "for await (const chunk of process.stdin) input += chunk;",
        "const request = JSON.parse(input);",
        `const { default: handler } = await import(${JSON.stringify(moduleUrl)});`,
        "const result = await handler(request);",
        "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    return ["--input-type=module", "--eval", bootstrap];
}
function pwshArgs(script, content) {
    const common = ["-NoLogo", "-NoProfile", "-NonInteractive"];
    if (script !== undefined) {
        return [
            ...common,
            "-CommandWithArgs",
            [
                "$requestJson = [Console]::In.ReadToEnd()",
                "$Request = $requestJson | ConvertFrom-Json",
                "$result = & $args[0]",
                "$result | ConvertTo-Json -Compress -Depth 100",
            ].join("\n"),
            script,
        ];
    }
    return [
        ...common,
        "-Command",
        [
            "$requestJson = [Console]::In.ReadToEnd()",
            "$Request = $requestJson | ConvertFrom-Json",
            "$result = & {",
            content ?? "",
            "}",
            "$result | ConvertTo-Json -Compress -Depth 100",
        ].join("\n"),
    ];
}
export function buildInvocation(runtime, options) {
    if ((options.script === undefined) === (options.content === undefined)) {
        throw new TypeError("Provide exactly one handler script or content");
    }
    if (runtime === "node") {
        return {
            file: options.executable ?? process.execPath,
            args: nodeArgs(options.script, options.content),
        };
    }
    return {
        file: options.executable ?? "pwsh",
        args: pwshArgs(options.script, options.content),
    };
}
async function terminateProcessTree(pid) {
    if (pid === undefined)
        return;
    if (process.platform === "win32") {
        try {
            await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
                windowsHide: true,
                shell: false,
                encoding: "utf8",
                timeout: 5_000,
            });
            return;
        }
        catch (cause) {
            throw runnerError("tree-termination-failed", { cause });
        }
    }
    try {
        process.kill(-pid, "SIGTERM");
    }
    catch (cause) {
        if (cause.code !== "ESRCH") {
            throw runnerError("tree-termination-failed", { cause });
        }
        return;
    }
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            process.kill(-pid, 0);
        }
        catch (cause) {
            if (cause.code === "ESRCH")
                return;
            throw runnerError("tree-termination-failed", { cause });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch (cause) {
        if (cause.code !== "ESRCH") {
            throw runnerError("tree-termination-failed", { cause });
        }
    }
}
function waitForClose(child) {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let spawnError;
        child.stdout?.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", (error) => {
            spawnError = error;
        });
        child.once("close", (exitCode, signal) => {
            resolve({
                stdout,
                stderr,
                exitCode,
                signal,
                ...(spawnError === undefined ? {} : { spawnError }),
            });
        });
    });
}
function validateResult(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw runnerError("invalid-result", {
            message: "Handler result must be an object",
        });
    }
    const result = value;
    if (!["ok", "missing", "drift", "error"].includes(String(result.status))) {
        throw runnerError("invalid-result", {
            message: "Handler result has an invalid status",
        });
    }
    if (typeof result.changed !== "boolean") {
        throw runnerError("invalid-result", {
            message: "Handler result changed must be boolean",
        });
    }
    if (result.message !== undefined && typeof result.message !== "string") {
        throw runnerError("invalid-result", {
            message: "Handler result message must be a string",
        });
    }
    return result;
}
async function waitForTermination(outcome, reason) {
    let timer;
    try {
        await Promise.race([
            outcome,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(runnerError(reason)), CLOSE_TIMEOUT_MS);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export async function runHandler(options) {
    if (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > MAX_TIMEOUT_MS)) {
        throw new TypeError(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
    }
    if (options.signal?.aborted)
        throw runnerError("cancelled");
    const requestJson = JSON.stringify(options.request);
    if (requestJson === undefined)
        throw new TypeError("request must be JSON serializable");
    const invocation = buildInvocation(options.runtime, options);
    let child;
    try {
        child = spawn(invocation.file, invocation.args, {
            cwd: options.cwd,
            detached: process.platform !== "win32",
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    catch (cause) {
        throw runnerError("spawn-failed", { cause });
    }
    child.stdin?.on("error", () => undefined);
    let reason;
    let stopPromise;
    let notifyStop;
    const stopped = new Promise((resolveStop) => {
        notifyStop = resolveStop;
    });
    const outcomePromise = waitForClose(child);
    const stop = (nextReason) => {
        if (stopPromise)
            return stopPromise;
        reason = nextReason;
        stopPromise = terminateProcessTree(child.pid)
            .then(() => notifyStop?.({ ok: true }), (error) => notifyStop?.({ ok: false, error }))
            .then(() => undefined);
        return stopPromise;
    };
    const onAbort = () => {
        void stop("cancelled");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timer;
    if (options.timeoutMs !== undefined)
        timer = setTimeout(() => {
            void stop("timeout");
        }, options.timeoutMs);
    child.stdin?.end(requestJson);
    const cleanup = () => {
        if (timer)
            clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
    };
    try {
        const first = await Promise.race([
            outcomePromise.then((value) => ({ type: "close", value })),
            stopped.then((value) => ({ type: "termination", value })),
        ]);
        if (first.type === "termination") {
            if (!first.value.ok)
                throw first.value.error;
            await waitForTermination(outcomePromise, reason ?? "cancelled");
            throw runnerError(reason ?? "cancelled");
        }
        const outcome = first.value;
        if (stopPromise) {
            await stopPromise;
            throw runnerError(reason ?? "cancelled", { ...outcome });
        }
        if (outcome.spawnError) {
            throw runnerError("spawn-failed", {
                cause: outcome.spawnError,
                ...outcome,
            });
        }
        if (outcome.exitCode !== 0) {
            throw runnerError("child-exit", { ...outcome });
        }
        let value;
        try {
            value = JSON.parse(outcome.stdout.trim());
        }
        catch (cause) {
            throw runnerError("invalid-result", {
                cause,
                stdout: outcome.stdout,
                stderr: outcome.stderr,
            });
        }
        return { ...outcome, result: validateResult(value) };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw runnerError("spawn-failed", {
                cause: error,
            });
        }
        throw error;
    }
    finally {
        cleanup();
    }
}
async function scriptPath(sourceRoot, recipeRoot, script) {
    if (isAbsolute(script) ||
        /^[A-Za-z]:[\\/]/.test(script) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(script)) {
        throw runnerError("custom-script-invalid", {
            message: "Custom script must be a relative local path",
        });
    }
    const candidate = resolve(recipeRoot, script);
    let canonical;
    try {
        canonical = await realpath(candidate);
    }
    catch (cause) {
        throw runnerError("custom-script-missing", {
            cause,
            message: "Custom script is not readable",
        });
    }
    const canonicalRoot = await realpath(sourceRoot);
    if (!isInside(canonicalRoot, canonical)) {
        throw runnerError("custom-script-escape", {
            message: "Custom script escapes the canonical Source root",
        });
    }
    if (!(await stat(canonical)).isFile()) {
        throw runnerError("custom-script-not-file", {
            message: "Custom script must resolve to a regular file",
        });
    }
    return canonical;
}
function timeoutMs(name, operation) {
    const seconds = operation.timeoutSeconds ?? DEFAULT_TIMEOUTS[name];
    if (!Number.isSafeInteger(seconds) ||
        seconds < 1 ||
        seconds * 1_000 > MAX_TIMEOUT_MS) {
        throw runnerError("custom-timeout-invalid", {
            message: "Custom timeoutSeconds is outside the supported range",
        });
    }
    return seconds * 1_000;
}
async function prepareOperation(name, operation, context) {
    const hasScript = typeof operation.script === "string";
    const hasContent = typeof operation.content === "string";
    if (hasScript === hasContent) {
        throw runnerError("custom-definition-invalid", {
            message: "Custom operation must define exactly one script or content",
        });
    }
    const script = hasScript
        ? await scriptPath(context.sourceRoot, context.recipeRoot, operation.script)
        : undefined;
    const runtime = operation.runtime;
    if (runtime !== "node" && runtime !== "pwsh") {
        throw runnerError("custom-runtime-invalid");
    }
    const detected = await detectRuntime(runtime, operation.selector);
    if (detected.status === "missing")
        throw runnerError("runtime-missing", {
            message: `${runtime} is not available`,
        });
    if (detected.status === "incompatible")
        throw runnerError("runtime-incompatible", {
            message: `${runtime} does not satisfy its supported version range`,
        });
    return {
        name,
        runtime,
        executable: detected.file,
        ...(script === undefined
            ? { content: operation.content }
            : { script }),
        timeoutMs: timeoutMs(name, operation),
    };
}
async function fingerprintDirectory(root) {
    const hash = createHash("sha256");
    async function visit(current) {
        const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.name === ".git")
                continue;
            const absolute = join(current, entry.name);
            const path = relative(root, absolute).split(sep).join("/");
            if (entry.isSymbolicLink()) {
                hash.update(`l:${path}\0`);
                hash.update(await readlink(absolute));
            }
            else if (entry.isDirectory()) {
                hash.update(`d:${path}\0`);
                await visit(absolute);
            }
            else {
                hash.update(`f:${path}\0`);
                hash.update(await readFile(absolute));
            }
        }
    }
    await visit(root);
    return hash.digest("hex");
}
function profileRoot(options) {
    return options.profileRoot ?? process.env.USERPROFILE ?? process.env.HOME;
}
function sourceKey(source, sourceRoot) {
    const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    return source.provider === "local"
        ? `local:${pathKey(sourceRoot)}`
        : `git:${source.locator.repository.toLowerCase()}/${source.locator.path ?? ""}`;
}
function trustSource(source, sourceRoot) {
    return source.provider === "local"
        ? { provider: "local", locator: { path: sourceRoot } }
        : { provider: "git", locator: source.locator };
}
async function readTrust(options) {
    const root = profileRoot(options);
    if (root === undefined)
        return { schemaVersion: 1, sources: [] };
    try {
        const text = await readFile(join(root, ".tbboot", "trust.yaml"), "utf8");
        const result = validateDocument({
            kind: "trust",
            text,
            document: ".tbboot/trust.yaml",
        });
        if (result.value === undefined)
            throw runnerError("trust-invalid", {
                message: result.diagnostics[0]?.message ?? "Invalid trust document",
            });
        return result.value;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { schemaVersion: 1, sources: [] };
        if (error.code === "trust-invalid")
            throw error;
        throw runnerError("trust-read", { cause: error });
    }
}
async function saveTrust(options, document) {
    const root = profileRoot(options);
    if (root === undefined)
        throw runnerError("trust-write", {
            message: "Unable to determine the user profile",
        });
    const directory = join(root, ".tbboot");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "trust.yaml"), stringify(document), "utf8");
}
async function allowedByArgument(source, sourceRoot, values = []) {
    if (values.length === 0)
        return false;
    for (const value of values) {
        const candidate = resolve(value);
        if (source.provider === "local" &&
            (candidate === sourceRoot ||
                (await realpath(candidate).catch(() => candidate)) === sourceRoot))
            return true;
        if (source.provider === "git" &&
            (value === source.locator.repository ||
                candidate === source.locator.repository ||
                candidate ===
                    resolve(source.locator.repository, source.locator.path ?? "")))
            return true;
    }
    return false;
}
async function authorized(context, options) {
    const key = `${sourceKey(context.source, context.sourceRoot)}:${context.revision ?? context.sourceFingerprint}`;
    if (options.cache?.has(key)) {
        if (!options.cache.get(key))
            throw runnerError("custom-authorization-required");
        return;
    }
    if (await allowedByArgument(context.source, context.sourceRoot, options.allowCustom)) {
        options.cache?.set(key, true);
        return;
    }
    if (context.source.provider === "git" &&
        (context.revision === undefined || context.revision.length === 0))
        throw runnerError("custom-source-revision-missing", {
            message: "Git Source authorization requires a resolved revision",
        });
    const trust = await readTrust(options);
    const entry = trust.sources.find((candidate) => {
        const same = JSON.stringify(candidate.source) ===
            JSON.stringify(trustSource(context.source, context.sourceRoot));
        return (same &&
            (context.source.provider === "git"
                ? candidate.revision === context.revision
                : candidate.fingerprint === context.sourceFingerprint));
    });
    if (entry !== undefined) {
        options.cache?.set(key, true);
        return;
    }
    if (options.interactive) {
        const { createInterface } = await import("node:readline/promises");
        const readline = createInterface({
            input: process.stdin,
            output: process.stderr,
        });
        try {
            const answer = await readline.question(`Allow Custom steps from ${context.sourceRoot}? [y/N] `);
            if (/^y(es)?$/i.test(answer.trim())) {
                trust.sources.push({
                    source: trustSource(context.source, context.sourceRoot),
                    ...(context.source.provider === "git"
                        ? { revision: context.revision }
                        : { fingerprint: context.sourceFingerprint }),
                });
                if (options.persistTrust !== false)
                    await saveTrust(options, trust);
                options.cache?.set(key, true);
                return;
            }
        }
        finally {
            readline.close();
        }
    }
    options.cache?.set(key, false);
    throw runnerError("custom-authorization-required", {
        message: "Custom execution requires Source authorization",
    });
}
export async function prepareCustomStep(step, context, authorization = {}, operations = ALL_CUSTOM_OPERATIONS) {
    const selected = new Set(operations);
    const check = selected.has("check")
        ? await prepareOperation("check", step.check, context)
        : undefined;
    const install = step.install === undefined || !selected.has("install")
        ? undefined
        : await prepareOperation("install", step.install, context);
    const uninstall = step.uninstall === undefined || !selected.has("uninstall")
        ? undefined
        : await prepareOperation("uninstall", step.uninstall, context);
    await authorized(context, authorization);
    return {
        context,
        ...(check === undefined ? {} : { check }),
        ...(install === undefined ? {} : { install }),
        ...(uninstall === undefined ? {} : { uninstall }),
        uninstallSupported: uninstall !== undefined,
    };
}
export async function runPreparedOperation(operation, context, signal) {
    return runHandler({
        runtime: operation.runtime,
        executable: operation.executable,
        ...(operation.script === undefined
            ? { content: operation.content }
            : { script: operation.script }),
        request: {
            operation: operation.name,
            consumerRoot: context.consumerRoot,
            sourceRoot: context.sourceRoot,
            recipe: context.recipe,
            recipeRoot: context.recipeRoot,
            step: context.step,
        },
        cwd: context.consumerRoot,
        timeoutMs: operation.timeoutMs,
        signal,
    });
}
export async function sourceFingerprint(root) {
    return fingerprintDirectory(await realpath(root));
}
export function customDiagnosticCode(error) {
    const code = error.code;
    if (code !== undefined &&
        (code.startsWith("custom-") ||
            [
                "runtime-missing",
                "runtime-incompatible",
                "runtime-probe-failed",
                "trust-invalid",
                "trust-read",
                "trust-write",
            ].includes(code)))
        return code;
    return "custom-error";
}
export function isCancellation(error) {
    return error.code === "cancelled";
}
