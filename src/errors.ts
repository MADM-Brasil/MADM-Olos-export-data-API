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
  return error instanceof WorkerError || error instanceof SyncError ? error.code : 'LOCAL_OR_DATABASE_FAILURE';
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
import { SyncError } from './corporate-sync/errors.js';

// Only connectivity/transaction failures are eligible for bounded local revalidation.
export function recoverableFailure(error: unknown): boolean {
  if (error instanceof AuthUnavailable) return error.retryable;
  if (error instanceof WorkerError) return error.retryable || [
    'RECOVERY_REQUIRED', 'UNCLEAN_SCHEDULER_EXIT', 'DATABASE_SESSION_LOST', 'ADMIN_DATABASE_SESSION_LOST',
    'DATABASE_RECOVERY_REQUIRED', 'ADMIN_COMMIT_UNKNOWN', 'AUTH_UNAVAILABLE', 'NETWORK_OR_RESPONSE_FAILURE',
  ].includes(error.code);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (code.startsWith('08') || [
    '57P01', '57P02', '57P03', '40001', '40P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  ].includes(code));
}
