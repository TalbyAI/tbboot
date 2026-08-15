import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const TERMINATION_TIMEOUT_MS = 5000;

function terminationError(pid, cause) {
  const error = new Error(`Failed to terminate process tree for PID ${pid}`, { cause });
  error.code = 'tree-termination-failed';
  error.pid = pid;
  error.stderr = cause.stderr ?? '';
  return error;
}

export async function terminateProcessTree(pid) {
  if (process.platform !== 'win32') {
    throw terminationError(pid, new Error('Process-tree termination is only supported on Windows'));
  }
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      timeout: TERMINATION_TIMEOUT_MS,
    });
  } catch (cause) {
    throw terminationError(pid, cause);
  }
}
