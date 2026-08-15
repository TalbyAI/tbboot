import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const nodeBootstrap = (moduleUrl) => `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const { default: handler } = await import(${JSON.stringify(moduleUrl)});
const result = await handler(request);
process.stdout.write(JSON.stringify(result));
`;

function nodeArgs({ script, content }) {
  const moduleSource = script == null
    ? `export default async function handler(request) {\n${content}\n}`
    : null;
  const moduleUrl = script == null
    ? `data:text/javascript,${encodeURIComponent(moduleSource)}`
    : pathToFileURL(resolve(script)).href;
  return ['--input-type=module', '--eval', nodeBootstrap(moduleUrl)];
}

function pwshArgs({ script, content }) {
  const common = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (script != null) return [...common, '-File', script];
  const wrapper = [
    '$requestJson = [Console]::In.ReadToEnd()',
    '$Request = $requestJson | ConvertFrom-Json',
    content,
  ].join('\n');
  return [...common, '-Command', wrapper];
}

export function buildInvocation(runtime, { script, content }) {
  if ((script == null) === (content == null)) throw new TypeError('Provide exactly one handler script or content');
  if (runtime === 'node') return { file: process.execPath, args: nodeArgs({ script, content }) };
  if (runtime === 'pwsh') return { file: 'pwsh', args: pwshArgs({ script, content }) };
  throw new TypeError(`Unsupported runtime: ${runtime}`);
}
