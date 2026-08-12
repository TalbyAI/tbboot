import { applyInstall, planInstall } from './core.mjs';
import { basename } from 'node:path';

function usage(message) {
  console.error(`error: ${message}`);
  console.error('usage: node proposed/cli.mjs <doctor|install> [--dry-run] --root <path>');
  process.exitCode = 2;
}

function parseArgs(args) {
  const command = args.shift();
  if (!['doctor', 'install'].includes(command)) {
    usage('command must be doctor or install');
    return null;
  }

  let root;
  let dryRun = false;
  while (args.length) {
    const argument = args.shift();
    if (argument === '--dry-run' && command === 'install') {
      dryRun = true;
    } else if (argument === '--root' && args.length) {
      root = args.shift();
    } else {
      usage(`unknown or misplaced argument: ${argument}`);
      return null;
    }
  }
  if (!root) {
    usage('--root is required');
    return null;
  }
  return { command, dryRun, root };
}

function printPlan(plan) {
  for (const { severity, code, message } of plan.diagnostics) {
    console.log(`${severity} [${code}] ${message}`);
  }
  for (const { action, target } of plan.writes) {
    console.log(`${action} ${target}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  try {
    const plan = await planInstall(options.root);
    printPlan(plan);
    if (plan.diagnostics.some(({ severity }) => severity === 'error')) {
      process.exitCode = 1;
      return;
    }
    if (options.command === 'install' && !options.dryRun) await applyInstall(plan);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'cli.mjs') main();
