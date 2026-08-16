#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runDoctor } from './doctor.ts';

const usage = 'usage: tbboot doctor [--root <consumer-root>] [--json]';

function parseArgs(argv, cwd) {
  if (argv[0] !== 'doctor') return { ok: false, message: 'Expected the doctor command' };

  let root;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--root') {
      if (root !== undefined || index + 1 >= argv.length
        || argv[index + 1].length === 0 || argv[index + 1].startsWith('--')) {
        return { ok: false, message: 'Missing or duplicate --root value' };
      }
      root = resolve(cwd, argv[++index]);
      continue;
    }
    return { ok: false, message: `Unknown argument: ${arg}` };
  }
  return { ok: true, root: root ?? resolve(cwd), json };
}

function renderHuman(envelope) {
  const lines = [`status: ${envelope.status}`];
  for (const action of envelope.actions) {
    lines.push(`${action.state}: ${action.type} ${action.target} (${action.source}/${action.recipe} step ${action.step})`);
  }
  for (const diagnostic of envelope.diagnostics) {
    const context = [diagnostic.document, diagnostic.path, diagnostic.source, diagnostic.recipe,
      diagnostic.step === undefined ? undefined : `step ${diagnostic.step}`]
      .filter((value) => value !== undefined)
      .join(' ');
    lines.push(`${diagnostic.severity}: ${diagnostic.code}${context ? ` [${context}]` : ''}: ${diagnostic.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, process.cwd());
  if (!options.ok) {
    process.stderr.write(`${options.message}\n${usage}\n`);
    return 2;
  }
  const result = await runDoctor(options.root);
  process.stdout.write(options.json
    ? `${JSON.stringify(result.envelope)}\n`
    : renderHuman(result.envelope));
  return result.exitCode;
}

if (process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; });
}
