export default async function handler() {
  console.error('failure-log');
  process.exitCode = 7;
  return { status: 'ok', changed: false };
}
