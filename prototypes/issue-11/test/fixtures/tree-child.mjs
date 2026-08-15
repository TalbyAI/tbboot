import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pidFile = process.argv[2];
const grandchild = spawn(process.execPath, [
  fileURLToPath(new URL('./tree-grandchild.mjs', import.meta.url)),
], { stdio: 'ignore', windowsHide: true, shell: false });
await writeFile(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
await new Promise(() => {});
