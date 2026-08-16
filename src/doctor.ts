import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDocument } from './contract.ts';

function diagnostic(code, message, context = {}) {
  return {
    code,
    severity: 'error',
    message,
    ...(context.document === undefined ? {} : { document: context.document }),
    ...(context.path === undefined ? {} : { path: context.path }),
    ...(context.source === undefined ? {} : { source: context.source }),
    ...(context.recipe === undefined ? {} : { recipe: context.recipe }),
    ...(context.step === undefined ? {} : { step: context.step }),
  };
}

function finish(envelope) {
  const hasError = envelope.diagnostics.some(({ severity }) => severity === 'error');
  const hasWarning = envelope.diagnostics.some(({ severity }) => severity === 'warning');
  envelope.status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  return { envelope, exitCode: hasError ? 1 : 0 };
}

export async function runDoctor(root) {
  const envelope = {
    schemaVersion: 1,
    command: 'doctor',
    status: 'ok',
    changed: false,
    actions: [],
    diagnostics: [],
  };

  let manifestText;
  try {
    manifestText = await readFile(join(root, 'tbboot.yaml'), 'utf8');
  } catch (error) {
    envelope.diagnostics.push(diagnostic(
      'manifest-read',
      `Unable to read tbboot.yaml: ${error.message}`,
      { document: 'tbboot.yaml' },
    ));
    return finish(envelope);
  }

  const result = validateDocument({
    kind: 'manifest',
    text: manifestText,
    document: 'tbboot.yaml',
  });
  envelope.diagnostics.push(...result.diagnostics);
  if (result.value === undefined) return finish(envelope);

  return finish(envelope);
}
