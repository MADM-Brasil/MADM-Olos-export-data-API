export class SyncError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function retryable(error: unknown): boolean {
  if (error instanceof SyncError) return false;
  const code = (error as { code?: string } | null)?.code ?? '';
  return /^(08|40)/.test(code) || ['55P03', '57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code);
}

// Never forward PostgreSQL messages, detail, queries, URLs, payloads or stack traces.
export function safeCode(error: unknown): string {
  return error instanceof SyncError ? error.code : retryable(error) ? 'DATABASE_TRANSIENT_FAILURE' : 'DATABASE_OR_RUNTIME_FAILURE';
}

export function log(event: 'checked' | 'preview' | 'batch_committed' | 'idle' | 'retry' | 'stopped' | 'failed' | 'migrated', fields: {
  count?: number; inserted?: number; existing?: number; attempt?: number; code?: string;
} = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), module: 'corporate-sync', event, ...fields }));
}
