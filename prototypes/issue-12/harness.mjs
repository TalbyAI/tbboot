import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, 'fixture');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'tbboot-issue-12-'));
  await cp(fixtureRoot, root, { recursive: true });
  let cleanupPromise;
  return {
    root,
    consumerRoot: join(root, 'consumer'),
    sourceRoot: join(root, 'source'),
    cleanup: () => {
      if (!cleanupPromise) {
        cleanupPromise = rm(root, { recursive: true, force: true }).catch((error) => {
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

export function runCommand({ file, args = [], cwd, env, timeoutMs = 30_000 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
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
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (!timedOut) finish(reject, error);
    });
    child.on('close', (exitCode) => {
      if (timedOut) {
        finish(reject, timeoutError);
      } else {
        finish(resolve, { exitCode, stdout, stderr });
      }
    });
    timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutError = Object.assign(
        new Error(`command timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT', timeoutMs },
      );
      child.kill();
    }, timeoutMs);
  });
}

export function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (text.length === 0) throw new Error('stdout did not contain a JSON document');
  return JSON.parse(text);
}
