import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHandler } from './runner.mjs';

const valueFlags = new Set(['--runtime', '--script', '--request', '--timeout-ms', '--cancel-after-ms', '--cancel-when-file']);

function positiveInteger(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag)) throw new Error(`Unknown or misplaced argument: ${flag}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--timeout-ms' || flag === '--cancel-after-ms') options[flag.slice(2).replaceAll('-', '')] = positiveInteger(value, flag);
    else options[flag.slice(2).replaceAll('-', '')] = value;
  }

  if (!['node', 'pwsh'].includes(options.runtime)) throw new Error('--runtime must be node or pwsh');
  if (!options.script) throw new Error('--script is required');
  if (options.request == null) throw new Error('--request is required');
  if (options.timeoutms == null) throw new Error('--timeout-ms is required');
  if (options.cancelafterm && options.cancelwhenfile) throw new Error('Use only one cancellation hook');

  try {
    options.request = JSON.parse(options.request);
  } catch (cause) {
    throw new Error('--request must be valid JSON', { cause });
  }
  options.script = resolve(options.script);
  if (options.cancelwhenfile) options.cancelwhenfile = resolve(options.cancelwhenfile);
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  let cancelTimer;
  let cancelWatcher;
  process.once('SIGINT', cancel);
  if (options.cancelafterm) cancelTimer = setTimeout(cancel, options.cancelafterm);
  if (options.cancelwhenfile) {
    cancelWatcher = setInterval(async () => {
      try {
        await access(options.cancelwhenfile);
        cancel();
      } catch {}
    }, 25);
    cancelWatcher.unref();
  }

  try {
    const outcome = await runHandler({
      runtime: options.runtime,
      script: options.script,
      request: options.request,
      timeoutMs: options.timeoutms,
      signal: controller.signal,
    });
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    return 0;
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr);
    console.error(error.code === 'cancelled' ? 'Handler cancelled' : error.message);
    return error.code === 'cancelled' ? 130 : 1;
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    if (cancelWatcher) clearInterval(cancelWatcher);
    process.removeListener('SIGINT', cancel);
  }
}

process.exitCode = await main(process.argv.slice(2));
