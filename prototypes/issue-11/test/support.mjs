import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

export async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for predicate');
}

export async function isProcessRunning(pid) {
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`], {
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
  });
  return stdout.includes(String(pid));
}

export const prototypeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function collectChild(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
