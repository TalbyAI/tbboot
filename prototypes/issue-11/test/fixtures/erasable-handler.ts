export default async function handler(request: { operation: string }) {
  const language: string = 'typescript';
  return { status: 'ok', changed: false, details: { language, operation: request.operation } };
}
