import { writeFile } from 'node:fs/promises';

export default async function handler(request) {
  await writeFile(request.completedFile, 'completed\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
