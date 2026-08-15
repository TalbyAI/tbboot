import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;
const RANGE_RE = /^>=(\d+\.\d+(?:\.\d+)?)\s+<(\d+(?:\.\d+){0,2})$/;

export const RUNTIME_DEFINITIONS = Object.freeze({
  node: { command: 'node', range: '>=24.12 <25', versionArgs: ['--version'] },
  pwsh: { command: 'pwsh', range: '>=7.6 <8', versionArgs: ['--version'] },
  'windows-powershell': {
    command: 'powershell.exe',
    range: null,
    versionArgs: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
});

export function parseVersion(text) {
  const match = String(text).match(VERSION_RE);
  return match ? { major: +match[1], minor: +match[2], patch: +(match[3] ?? 0) } : null;
}

export function parseRange(text) {
  const match = String(text).match(RANGE_RE);
  if (!match) throw new TypeError(`Unsupported runtime range: ${text}`);
  const parseBound = (value) => parseVersion(value) ?? { major: +value, minor: 0, patch: 0 };
  return {
    lower: { ...parseBound(match[1]), inclusive: true },
    upper: { ...parseBound(match[2]), inclusive: false },
  };
}

function compare(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function satisfies(version, rangeText) {
  const range = typeof rangeText === 'string' ? parseRange(rangeText) : rangeText;
  return compare(version, range.lower) >= 0 && compare(version, range.upper) < 0;
}

export function classifyRuntime({ name, available, version }) {
  const definition = RUNTIME_DEFINITIONS[name];
  if (!definition) throw new TypeError(`Unknown runtime: ${name}`);

  const parsedVersion = typeof version === 'string' ? parseVersion(version) : version;
  let status = 'missing';
  if (available) {
    status = name === 'windows-powershell'
      ? 'unsupported'
      : parsedVersion && satisfies(parsedVersion, definition.range) ? 'compatible' : 'incompatible';
  }

  return {
    name,
    command: definition.command,
    version: available ? parsedVersion : null,
    status,
    supported: status === 'compatible',
  };
}

export async function detectRuntime(name) {
  const definition = RUNTIME_DEFINITIONS[name];
  if (!definition) throw new TypeError(`Unknown runtime: ${name}`);

  try {
    const { stdout } = await execFileAsync(definition.command, definition.versionArgs, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    return classifyRuntime({ name, available: true, version: parseVersion(stdout) });
  } catch (error) {
    if (error.code === 'ENOENT') return classifyRuntime({ name, available: false, version: null });
    return classifyRuntime({
      name,
      available: true,
      version: parseVersion(error.stdout ?? ''),
    });
  }
}

export async function detectRuntimes() {
  const names = Object.keys(RUNTIME_DEFINITIONS);
  const detected = await Promise.all(names.map((name) => detectRuntime(name)));
  return Object.fromEntries(names.map((name, index) => [name, detected[index]]));
}
