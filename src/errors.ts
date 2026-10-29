export class WorkerError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) { super(code); }
}
export class HttpError extends WorkerError {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) {
    super(`HTTP_${status}`, status === 429 || status >= 500);
  }
}
export class AuthUnavailable extends WorkerError {
  constructor(readonly original: unknown) { super('AUTH_UNAVAILABLE', !(original instanceof HttpError) || ![400,403].includes(original.status)); }
}
// Never emit provider response bodies, pg error details, URLs or arbitrary exception messages.
export function errorCode(error: unknown): string {
  return error instanceof WorkerError ? error.code : 'LOCAL_OR_DATABASE_FAILURE';
}
export type LogEntry = Readonly<Record<string, string | number | boolean | null>>;
const observers = new Set<(entry: LogEntry) => void>();
export function observeLogs(observer: (entry: LogEntry) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  const entry = Object.freeze({ ...fields, time: new Date().toISOString(), event, table: 'AttemptsRawData' });
  process.stdout.write(JSON.stringify(entry) + '\n');
  // Administrative observation must never change ingestion success/failure semantics.
  for (const observer of observers) { try { observer(entry); } catch { /* best-effort display only */ } }
}
