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

function isAncestor(repoPath, ancestor, descendant) {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function candidateRevisions(repoPath) {
  const refs = git(repoPath, [
    'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags',
  ]).split('\n').filter(Boolean);
  const byRevision = new Map();
  for (const ref of refs) {
    const revision = git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    const entry = byRevision.get(revision) ?? { revision, refs: [] };
    entry.refs.push(ref);
    byRevision.set(revision, entry);
  }
  return [...byRevision.values()];
}

function rangeCandidates(repoPath, selector) {
  const lower = resolveRef(repoPath, selector.from);
  const upper = resolveRef(repoPath, selector.to);
  if (!isAncestor(repoPath, lower.revision, upper.revision)) {
    throw new GitSelectorError(
      'git-range-invalid',
      'Range lower bound is not an ancestor of its upper bound',
      { from: selector.from, to: selector.to },
    );
  }
  return candidateRevisions(repoPath).filter(({ revision }) =>
    isAncestor(repoPath, lower.revision, revision)
    && isAncestor(repoPath, revision, upper.revision));
}

function chooseCandidate(repoPath, candidates) {
  if (candidates.length === 0) {
    throw new GitSelectorError('git-selector-incompatible', 'Selector has no candidate revision');
  }
  // ponytail: O(n²) ancestry checks, replace with one graph walk if candidate sets grow.
  const maxima = candidates.filter((candidate, index) => candidates.every((other, otherIndex) =>
    index === otherIndex || !isAncestor(repoPath, candidate.revision, other.revision)));
  if (maxima.length > 1) {
    throw new GitSelectorError('git-selector-ambiguous', 'Selector has incomparable maximal revisions', {
      revisions: maxima.map(({ revision }) => revision),
    });
  }
  return maxima[0];
}

export function resolveSelector(repoPath, selector) {
  if (selector && typeof selector === 'object' && 'ref' in selector) {
    const resolved = resolveRef(repoPath, selector.ref);
    return { revision: resolved.revision, refs: [resolved.ref] };
  }
  if (selector && typeof selector === 'object' && 'from' in selector && 'to' in selector) {
    return chooseCandidate(repoPath, rangeCandidates(repoPath, selector));
  }
  throw new TypeError('Git selector must contain ref or from/to');
}

function selectorCandidates(repoPath, selector) {
  if (selector && typeof selector === 'object' && 'ref' in selector) {
    const resolved = resolveRef(repoPath, selector.ref);
    return [{ revision: resolved.revision, refs: [resolved.ref] }];
  }
  if (selector && typeof selector === 'object' && 'from' in selector && 'to' in selector) {
    return rangeCandidates(repoPath, selector);
  }
  throw new TypeError('Git selector must contain ref or from/to');
}

export function intersectSelectors(repoPath, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new TypeError('At least one Git selector is required');
  }
  let common = selectorCandidates(repoPath, selectors[0]);
  for (const selector of selectors.slice(1)) {
    const allowed = new Set(selectorCandidates(repoPath, selector).map(({ revision }) => revision));
    common = common.filter(({ revision }) => allowed.has(revision));
  }
  return chooseCandidate(repoPath, common);
}
