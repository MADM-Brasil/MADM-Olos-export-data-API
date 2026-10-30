import type { LogEntry } from '../errors.js';

const allowedEvents = new Set(['admin_listening', 'scheduler_started', 'scheduler_interval_changed',
  'scheduler_paused', 'scheduler_resumed', 'scheduler_next_run', 'scheduler_error', 'poll_retry',
  'batch_completed', 'recovery_required', 'reference_cache_refreshed', 'local_recovery_completed',
  'olos_tls_verification_disabled', 'corporate_delivery_confirmed', 'corporate_delivery_deferred']);
const numericFields = new Set(['received', 'inserted', 'updated', 'duplicates', 'duration_ms',
  'request_ms', 'persistence_ms', 'interval_ms', 'retry_ms', 'port', 'queued', 'confirmed']);

// Bounded display of this process's real events; durable read/audit history remains in PostgreSQL.
export class OperationalEvents {
  private readonly entries: LogEntry[] = [];
  record(entry: LogEntry) {
    if (typeof entry.event !== 'string' || !allowedEvents.has(entry.event)) return;
    const safe: Record<string, string | number | boolean | null> = { time: entry.time ?? null, event: entry.event };
    for (const [key, value] of Object.entries(entry)) {
      if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      if (key === 'enabled' && typeof value === 'boolean') safe[key] = value;
      if (key === 'blocked' && typeof value === 'boolean') safe[key] = value;
      if (key === 'error' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value)) safe[key] = value;
      if (key === 'read_id' && typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) safe[key] = value;
      if (key === 'next_run_at' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) safe[key] = value;
    }
    this.entries.push(Object.freeze(safe));
    if (this.entries.length > 200) this.entries.shift();
  }
  snapshot() { return [...this.entries]; }
}
