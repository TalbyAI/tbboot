import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHandler } from './runner.mjs';

const valueFlags = new Map([
  ['--runtime', 'runtime'],
  ['--script', 'script'],
  ['--request', 'request'],
  ['--timeout-ms', 'timeoutMs'],
  ['--cancel-after-ms', 'cancelAfterMs'],
  ['--cancel-when-file', 'cancelWhenFile'],
]);

function positiveInteger(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const name = valueFlags.get(flag);
    if (!name) throw new Error(`Unknown or misplaced argument: ${flag}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--timeout-ms' || flag === '--cancel-after-ms') options[name] = positiveInteger(value, flag);
    else options[name] = value;
  }

  if (!['node', 'pwsh'].includes(options.runtime)) throw new Error('--runtime must be node or pwsh');
  if (!options.script) throw new Error('--script is required');
  if (options.request == null) throw new Error('--request is required');
  if (options.timeoutMs == null) throw new Error('--timeout-ms is required');
  if (options.cancelAfterMs && options.cancelWhenFile) throw new Error('Use only one cancellation hook');

  try {
    options.request = JSON.parse(options.request);
  } catch (cause) {
    throw new Error('--request must be valid JSON', { cause });
  }
  options.script = resolve(options.script);
  if (options.cancelWhenFile) options.cancelWhenFile = resolve(options.cancelWhenFile);
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
  if (options.cancelAfterMs) cancelTimer = setTimeout(cancel, options.cancelAfterMs);
  if (options.cancelWhenFile) {
    cancelWatcher = setInterval(async () => {
      try {
        await access(options.cancelWhenFile);
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
      timeoutMs: options.timeoutMs,
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
