import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureRepo, removeFixtureRepo } from './fixture.mjs';
import { GitSelectorError, resolveSelector } from '../proposed/git-source.mjs';

async function withFixture(callback) {
  const fixture = await createFixtureRepo();
  try {
    return await callback(fixture);
  } finally {
    await removeFixtureRepo(fixture.repoPath);
  }
}

test('resolves short and fully qualified tag and branch refs', () => withFixture(({ repoPath, revisions }) => {
  assert.equal(resolveSelector(repoPath, { ref: 'v1' }).revision, revisions.base);
  assert.equal(resolveSelector(repoPath, { ref: 'refs/tags/v2' }).revision, revisions.x);
  assert.equal(resolveSelector(repoPath, { ref: 'line-y' }).revision, revisions.y);
  assert.equal(resolveSelector(repoPath, { ref: 'refs/heads/line-x' }).revision, revisions.x);
}));

test('rejects a short name shared by a tag and branch', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => resolveSelector(repoPath, { ref: 'same' }),
    (error) => error instanceof GitSelectorError && error.code === 'git-ref-ambiguous',
  );
}));

test('rejects a missing ref', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => resolveSelector(repoPath, { ref: 'missing' }),
    (error) => error instanceof GitSelectorError && error.code === 'git-ref-not-found',
  );
}));
