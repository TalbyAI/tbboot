const value = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const root = value('--root');
const delay = Number(value('--delay', '0'));
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
process.stderr.write('probe stderr\n');
process.stdout.write(`${JSON.stringify({
  status: 'ok',
  cwdMatchesRoot: process.cwd() === root,
})}\n`);
process.exitCode = Number(value('--exit', '0'));
