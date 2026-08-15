import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, 'fixture');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export async function createFixture({ copy = cp, remove = rm } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tbboot-issue-12-'));
  try {
    await copy(fixtureRoot, root, { recursive: true });
  } catch (error) {
    try {
      await remove(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture copy and cleanup failed');
    }
    throw error;
  }
  let cleanupPromise;
  return {
    root,
    consumerRoot: join(root, 'consumer'),
    sourceRoot: join(root, 'source'),
    cleanup: () => {
      if (!cleanupPromise) {
        cleanupPromise = remove(root, { recursive: true, force: true }).catch((error) => {
          cleanupPromise = undefined;
          throw error;
        });
      }
      return cleanupPromise;
    },
  };
}

export async function snapshotFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          path: relative(root, absolute).split(sep).join('/'),
          bytes: await readFile(absolute),
        });
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => compare(left.path, right.path));
}

export function runCommand({
  file,
  args = [],
  cwd,
  env,
  timeoutMs = 30_000,
  ready,
  readyTimeoutMs = timeoutMs,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new RangeError('readyTimeoutMs must be a positive finite number');
  }
  if (ready !== undefined && (typeof ready !== 'string' || ready.length === 0)) {
    throw new TypeError('ready must be a non-empty string');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutError;
    let timeoutId;
    let readyTimeoutId;
    let forceKillId;
    let exited = false;
    let childExitCode;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(readyTimeoutId);
      clearTimeout(forceKillId);
      callback(value);
    };
    const startTimeout = () => {
      if (settled || exited || timeoutId !== undefined) return;
      timeoutId = setTimeout(() => terminate(timeoutMs), timeoutMs);
    };
    const terminate = (limit) => {
      if (settled || exited || timedOut) return;
      timedOut = true;
      timeoutError = Object.assign(
        new Error(`command timed out after ${limit}ms`),
        { code: 'ETIMEDOUT', timeoutMs: limit },
      );
      clearTimeout(readyTimeoutId);
      if (process.platform === 'win32') {
        child.kill();
      } else {
        forceKillId = setTimeout(() => child.kill('SIGKILL'), 100);
        child.kill('SIGTERM');
      }
    };
    let readySeen = ready === undefined;
    const checkReady = () => {
      if (readySeen || !(stdout.includes(ready) || stderr.includes(ready))) return;
      readySeen = true;
      clearTimeout(readyTimeoutId);
      startTimeout();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdout.on('data', checkReady);
    child.stderr.on('data', (chunk) => { stderr += chunk; checkReady(); });
    child.on('error', (error) => {
      if (!timedOut) finish(reject, error);
    });
    child.on('exit', (exitCode) => {
      exited = true;
      childExitCode = exitCode;
      clearTimeout(timeoutId);
      clearTimeout(readyTimeoutId);
      clearTimeout(forceKillId);
    });
    child.on('close', (exitCode) => {
      if (timedOut) {
        finish(reject, timeoutError);
      } else {
        finish(resolve, { exitCode: childExitCode ?? exitCode, stdout, stderr });
      }
    });
    if (readySeen) {
      startTimeout();
    } else {
      readyTimeoutId = setTimeout(() => terminate(readyTimeoutMs), readyTimeoutMs);
    }
  });
}

export function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (text.length === 0) throw new Error('stdout did not contain a JSON document');
  return JSON.parse(text);
}
