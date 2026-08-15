import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default async function handler(request) {
  const pidFile = request.pidFile;
  spawn(process.execPath, [
    fileURLToPath(new URL('./tree-child.mjs', import.meta.url)), pidFile,
  ], { stdio: 'ignore', windowsHide: true, shell: false });
  for (;;) {
    try {
      const descendants = JSON.parse(await readFile(pidFile, 'utf8'));
      await writeFile(pidFile, JSON.stringify([process.pid, descendants.child, descendants.grandchild]));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
