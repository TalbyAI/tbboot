import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function commit(repoPath, file, content, message) {
  await writeFile(join(repoPath, file), content, 'utf8');
  git(repoPath, ['add', '--', file]);
  git(repoPath, ['commit', '--quiet', '-m', message]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

export async function createFixtureRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), 'tbboot-issue-10-'));
  try {
    git(repoPath, ['init', '--quiet', '--initial-branch=main']);
    git(repoPath, ['config', 'user.name', 'tbboot fixture']);
    git(repoPath, ['config', 'user.email', 'fixture@example.test']);

    const base = await commit(repoPath, 'base.txt', 'base\n', 'base');
    git(repoPath, ['branch', 'line-x']);
    git(repoPath, ['checkout', '--quiet', 'line-x']);
    const x = await commit(repoPath, 'x.txt', 'x\n', 'x');
    git(repoPath, ['checkout', '--quiet', 'main']);
    git(repoPath, ['branch', 'line-y']);
    git(repoPath, ['checkout', '--quiet', 'line-y']);
    const y = await commit(repoPath, 'y.txt', 'y\n', 'y');

    git(repoPath, ['checkout', '--quiet', '-b', 'upper-a', 'line-x']);
    git(repoPath, ['merge', '--quiet', '--no-ff', '--no-edit', 'line-y']);
    const upperA = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['checkout', '--quiet', '-b', 'upper-b', 'line-y']);
    git(repoPath, ['merge', '--quiet', '--no-ff', '--no-edit', 'line-x']);
    const upperB = git(repoPath, ['rev-parse', 'HEAD']);

    git(repoPath, ['tag', 'v1', base]);
    git(repoPath, ['tag', 'v2', x]);
    git(repoPath, ['tag', 'same', x]);
    git(repoPath, ['tag', 'range-a', upperA]);
    git(repoPath, ['tag', 'range-b', upperB]);
    git(repoPath, ['branch', 'same', y]);
    return { repoPath, revisions: { base, x, y, upperA, upperB } };
  } catch (error) {
    await rm(repoPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function removeFixtureRepo(repoPath) {
  return rm(repoPath, { recursive: true, force: true });
}
