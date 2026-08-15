export default async function handler() {
  process.stdout.write('not-json');
  return { status: 'ok', changed: false };
}
