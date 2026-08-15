import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureRepo, removeFixtureRepo } from './fixture.mjs';
import { GitSelectorError, intersectSelectors, resolveSelector } from '../proposed/git-source.mjs';

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

test('resolves inclusive ranges and equal bounds by ancestry', () => withFixture(({ repoPath, revisions }) => {
  assert.equal(resolveSelector(repoPath, { from: 'v1', to: 'v2' }).revision, revisions.x);
  assert.equal(resolveSelector(repoPath, { from: 'v2', to: 'v2' }).revision, revisions.x);
  assert.equal(
    resolveSelector(repoPath, { from: 'refs/tags/v1', to: 'refs/heads/line-x' }).revision,
    revisions.x,
  );
}));

test('rejects a range whose lower bound is not an ancestor', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => resolveSelector(repoPath, { from: 'v2', to: 'v1' }),
    (error) => error instanceof GitSelectorError && error.code === 'git-range-invalid',
  );
}));

test('reports an empty selector intersection', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => intersectSelectors(repoPath, [{ ref: 'v1' }, { ref: 'v2' }]),
    (error) => error instanceof GitSelectorError && error.code === 'git-selector-incompatible',
  );
}));

test('intersects refs that identify the same revision', () => withFixture(({ repoPath, revisions }) => {
  const result = intersectSelectors(repoPath, [
    { ref: 'v2' },
    { ref: 'refs/heads/line-x' },
  ]);
  assert.equal(result.revision, revisions.x);
}));

test('reports an empty intersection between ranges', () => withFixture(({ repoPath }) => {
  assert.throws(
    () => intersectSelectors(repoPath, [
      { from: 'line-x', to: 'range-a' },
      { from: 'line-y', to: 'range-b' },
    ]),
    (error) => error instanceof GitSelectorError && error.code === 'git-selector-incompatible',
  );
}));

test('reports several incomparable maximal revisions', () => withFixture(({ repoPath, revisions }) => {
  assert.throws(
    () => intersectSelectors(repoPath, [
      { from: 'v1', to: 'range-a' },
      { from: 'v1', to: 'range-b' },
    ]),
    (error) => error instanceof GitSelectorError
      && error.code === 'git-selector-ambiguous'
      && error.details.revisions.includes(revisions.x)
      && error.details.revisions.includes(revisions.y),
  );
}));
