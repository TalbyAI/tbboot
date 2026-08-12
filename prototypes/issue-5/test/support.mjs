import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixture');

export async function fixtureConsumer() {
  const root = await mkdtemp(join(tmpdir(), 'tbboot-issue-5-'));
  await cp(fixtureRoot, root, { recursive: true });
  return { root, consumerRoot: join(root, 'consumer') };
}
