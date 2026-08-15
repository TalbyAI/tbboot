export default async function handler(request) {
  console.error(`js-log:${request.operation}`);
  return { status: 'ok', changed: false, details: { language: 'javascript' } };
}
