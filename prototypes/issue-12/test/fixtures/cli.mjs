import { spawn } from 'node:child_process';

const value = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const root = value('--root');
const delay = Number(value('--delay', '0'));
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
if (process.argv.includes('--handle-sigterm')) {
  process.on('SIGTERM', () => {});
  const readyDelay = Number(value('--ready-delay', '0'));
  if (readyDelay > 0) await new Promise((resolve) => setTimeout(resolve, readyDelay));
  process.stderr.write('READY\n');
}
if (process.argv.includes('--hold-after-ready')) {
  setTimeout(() => process.exit(99), 500);
  await new Promise(() => {});
}
if (process.argv.includes('--hold-stdout')) {
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  holder.unref();
}
process.stderr.write('probe stderr\n');
const output = `${JSON.stringify({
  status: 'ok',
  cwdMatchesRoot: process.cwd() === root,
})}\n`;
if (process.argv.includes('--hold-stdout')) {
  process.stdout.write(output, () => process.exit(0));
} else {
  process.stdout.write(output);
  process.exitCode = Number(value('--exit', '0'));
}
