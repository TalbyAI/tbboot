import { spawn } from "node:child_process";

export type RunCommandOptions = {
	file: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	ready?: string;
	readyTimeoutMs?: number;
};

export type CommandResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

export function runCommand({
	file,
	args = [],
	cwd,
	env,
	timeoutMs = 30_000,
	ready,
	readyTimeoutMs = timeoutMs,
}: RunCommandOptions): Promise<CommandResult> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new RangeError("timeoutMs must be a positive finite number");
	}
	if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
		throw new RangeError("readyTimeoutMs must be a positive finite number");
	}
	if (
		ready !== undefined &&
		(typeof ready !== "string" || ready.length === 0)
	) {
		throw new TypeError("ready must be a non-empty string");
	}

	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timeoutError: Error & { code: "ETIMEDOUT"; timeoutMs: number };
		let timeoutId: NodeJS.Timeout | undefined;
		let readyTimeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		let exited = false;
		let childExitCode: number | null | undefined;

		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			clearTimeout(readyTimeoutId);
			clearTimeout(forceKillId);
			callback();
		};
		const startTimeout = (): void => {
			if (settled || exited || timeoutId !== undefined) return;
			timeoutId = setTimeout(() => terminate(timeoutMs), timeoutMs);
		};
		const terminate = (limit: number): void => {
			if (settled || exited || timedOut) return;
			timedOut = true;
			timeoutError = Object.assign(
				new Error(`command timed out after ${limit}ms`),
				{ code: "ETIMEDOUT" as const, timeoutMs: limit },
			);
			clearTimeout(readyTimeoutId);
			if (process.platform === "win32") {
				child.kill();
			} else {
				forceKillId = setTimeout(() => child.kill("SIGKILL"), 100);
				child.kill("SIGTERM");
			}
		};
		let readySeen = ready === undefined;
		const checkReady = (): void => {
			if (
				readySeen ||
				ready === undefined ||
				!(stdout.includes(ready) || stderr.includes(ready))
			) {
				return;
			}
			readySeen = true;
			clearTimeout(readyTimeoutId);
			startTimeout();
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stdout.on("data", checkReady);
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			checkReady();
		});
		child.on("error", (error) => {
			if (!timedOut) finish(() => reject(error));
		});
		child.on("exit", (exitCode) => {
			exited = true;
			childExitCode = exitCode;
			clearTimeout(timeoutId);
			clearTimeout(readyTimeoutId);
			clearTimeout(forceKillId);
		});
		child.on("close", (exitCode) => {
			if (timedOut) {
				finish(() => reject(timeoutError));
			} else if (!readySeen) {
				finish(() =>
					reject(new Error("command exited before the readiness marker")),
				);
			} else {
				finish(() =>
					resolve({ exitCode: childExitCode ?? exitCode, stdout, stderr }),
				);
			}
		});
		if (readySeen) {
			startTimeout();
		} else {
			readyTimeoutId = setTimeout(
				() => terminate(readyTimeoutMs),
				readyTimeoutMs,
			);
		}
	});
}

export function parseJsonOutput<T = unknown>(stdout: string): T {
	const text = stdout.trim();
	if (text.length === 0) {
		throw new Error("stdout did not contain a JSON document");
	}
	return JSON.parse(text) as T;
}
