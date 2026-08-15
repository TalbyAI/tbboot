import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';

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

export async function runHandler({ runtime, script, content, request, cwd, timeoutMs, signal }) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  const requestJson = JSON.stringify(request);
  if (requestJson === undefined) throw new TypeError('request must be JSON serializable');

  const { file, args } = buildInvocation(runtime, { script, content });
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
  child.stdin.end(requestJson);
  const outcome = await outcomePromise;

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
}
