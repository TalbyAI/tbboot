import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { terminateProcessTree } from './process-tree.mjs';

export const MAX_TIMEOUT_MS = 2_147_483_647;
const CLOSE_TIMEOUT_MS = 5000;

function runnerError(code, details = {}) {
  const error = new Error(details.message ?? code, { cause: details.cause });
  error.code = code;
  Object.assign(error, details);
  return error;
}

function waitForClose(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let spawnError;
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal, spawnError }));
  });
}

function validateResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw runnerError('invalid-result', { message: 'Handler result must be an object' });
  }
  if (!['ok', 'missing', 'drift', 'error'].includes(value.status)) {
    throw runnerError('invalid-result', { message: 'Handler result has an invalid status' });
  }
  if (typeof value.changed !== 'boolean') {
    throw runnerError('invalid-result', { message: 'Handler result changed must be boolean' });
  }
  return value;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Child did not close after termination')), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function runHandler({ runtime, executable, script, content, request, cwd, timeoutMs, signal, terminate = terminateProcessTree }) {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new TypeError(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  }
  if (signal?.aborted) throw runnerError('cancelled');
  const requestJson = JSON.stringify(request);
  if (requestJson === undefined) throw new TypeError('request must be JSON serializable');

  const { file, args } = buildInvocation(runtime, { executable, script, content });
  let child;
  try {
    child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw runnerError('spawn-failed', { cause, originalCode: cause.code });
  }

  child.stdin.on('error', () => {});
  const outcomePromise = waitForClose(child);
  let reason;
  let stopPromise;
  let notifyStop;
  const stopNotification = new Promise((resolve) => { notifyStop = resolve; });
  let timer;
  const stop = (nextReason) => {
    if (reason) return stopPromise;
    reason = nextReason;
    stopPromise = Promise.resolve().then(() => terminate(child.pid));
    stopPromise.then(
      () => notifyStop({ ok: true }),
      (error) => notifyStop({ ok: false, error }),
    );
    void stopPromise.catch(() => {});
    return stopPromise;
  };
  const onAbort = () => { void stop('cancelled'); };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  if (timeoutMs !== undefined) timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
  child.stdin.end(requestJson);

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };

  try {
    const first = await Promise.race([
      outcomePromise.then((value) => ({ type: 'close', value })),
      stopNotification.then((value) => ({ type: 'termination', value })),
    ]);
    let outcome;
    if (first.type === 'termination') {
      if (!first.value.ok) throw first.value.error;
      try {
        outcome = await withTimeout(outcomePromise, CLOSE_TIMEOUT_MS);
      } catch (cause) {
        throw runnerError(reason, { cause });
      }
    } else {
      outcome = first.value;
      if (stopPromise) await stopPromise;
    }
    cleanup();
    if (stopPromise) {
      throw runnerError(reason, outcome);
    }
    if (outcome.spawnError) {
      throw runnerError('spawn-failed', {
        cause: outcome.spawnError,
        originalCode: outcome.spawnError.code,
        ...outcome,
      });
    }
    if (outcome.exitCode !== 0) throw runnerError('child-exit', outcome);

    let value;
    try {
      const text = outcome.stdout.trim();
      if (!text) throw new SyntaxError('Handler produced no result');
      value = JSON.parse(text);
    } catch (cause) {
      throw runnerError('invalid-result', { cause, stdout: outcome.stdout, stderr: outcome.stderr });
    }
    return { ...outcome, result: validateResult(value) };
  } finally {
    cleanup();
  }
}
