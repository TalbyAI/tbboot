import { execFileSync } from 'node:child_process';

export class GitSelectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitSelectorError';
    this.code = code;
    this.details = details;
  }
}

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function refNames(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new TypeError('Git ref must be a non-empty string');
  }
  if (name.startsWith('refs/tags/') || name.startsWith('refs/heads/')) return [name];
  if (name.startsWith('refs/')) return [];
  return [`refs/tags/${name}`, `refs/heads/${name}`];
}

function existingRef(repoPath, ref) {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function resolveRef(repoPath, name) {
  const refs = refNames(name).filter((ref) => existingRef(repoPath, ref));
  if (refs.length === 0) {
    throw new GitSelectorError('git-ref-not-found', `Git ref not found: ${name}`, { name });
  }
  if (refs.length > 1) {
    throw new GitSelectorError('git-ref-ambiguous', `Git ref is ambiguous: ${name}`, { name, refs });
  }
  return { revision: git(repoPath, ['rev-parse', '--verify', `${refs[0]}^{commit}`]), ref: refs[0] };
}

export function resolveSelector(repoPath, selector) {
  if (!selector || typeof selector !== 'object' || !('ref' in selector)) {
    throw new TypeError('Exact selector must contain ref');
  }
  const resolved = resolveRef(repoPath, selector.ref);
  return { revision: resolved.revision, refs: [resolved.ref] };
}
