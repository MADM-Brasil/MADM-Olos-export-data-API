import { parse } from 'lossless-json';
import { OlosAuthManager } from './auth.js';
import { AuthUnavailable, HttpError, WorkerError } from './errors.js';
import { sleep, type Transport } from './http.js';

export function json(raw: string): unknown {
  try { return parse(raw, undefined, value => value); } catch { throw new WorkerError('JSON_INVALID'); }
}
export function rows(raw: string): Record<string, unknown>[] {
  const value = json(raw);
  if (!Array.isArray(value) || value.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new WorkerError('ARRAY_RESPONSE_REQUIRED');
  return value as Record<string, unknown>[];
}
export type ReadSpec = { kind: 'current' | 'previous' } | { kind: 'reread'; date: string; start: string; end: string };
export function readFields(spec: ReadSpec) {
  if (spec.kind !== 'reread') return { TableName: 'AttemptsRawData' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.date) || !Number.isFinite(Date.parse(spec.date)) || new Date(spec.date).toISOString().slice(0,10) !== spec.date ||
    !/^\d{1,19}$/.test(spec.start) || !/^\d{1,19}$/.test(spec.end) || BigInt(spec.start) > BigInt(spec.end) || BigInt(spec.end) > 9223372036854775807n) throw new WorkerError('INVALID_RECOVERY_RANGE');
  return { TableName: 'AttemptsRawData', DateExport: spec.date, PKIDStart: spec.start, PKIDEnd: spec.end };
}
export class OlosApi {
  constructor(private readonly request: Transport, readonly auth: OlosAuthManager,
    private readonly wait: (ms: number) => Promise<unknown> = sleep) {}
  async call(path: string, fields?: Record<string, string>, consuming = false): Promise<string> {
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try { token = await this.auth.getToken(); } catch (error) { throw new AuthUnavailable(error); }
      try { return await this.request(path, fields, token); }
      catch (error) {
        if (error instanceof HttpError && error.status === 401 && !authRetried) {
          authRetried = true; this.auth.invalidate(token); continue;
        }
        // 429 is an explicit rejection. A network failure/500 on consuming reads is ambiguous.
        const retryable = error instanceof HttpError ? error.status === 429 || (!consuming && error.status >= 500) : !consuming && error instanceof WorkerError && error.retryable;
        if (!retryable || attempt >= 2) throw error;
        await this.wait(Math.max(error instanceof HttpError ? error.retryAfterMs : 0, 1000 * 2 ** attempt));
      }
    }
  }
  read(spec: ReadSpec) {
    const path = spec.kind === 'current' ? 'read-data-current-day' : spec.kind === 'previous' ? 'read-data-previous-days' : 're-read-data';
    return this.call(`/api/export-data/${path}`, readFields(spec), true);
  }
  // Capture is evidence gathering: never replay even an explicitly rejected POST.
  async captureRereadOnce(spec: Extract<ReadSpec, { kind: 'reread' }>) {
    const token = await this.auth.getToken();
    return this.request('/api/export-data/re-read-data', readFields(spec), token);
  }

  async captureCurrentDayOnce() {
    const token = await this.auth.getToken();
    return this.request('/api/export-data/read-data-current-day', readFields({ kind: 'current' }), token);
  }
  async available() {
    this.validateCatalog(await this.call('/api/export-data/available-tables'));
  }
  async validateCaptureCatalog() {
    const token = await this.auth.getToken();
    this.validateCatalog(await this.request('/api/export-data/available-tables', undefined, token));
  }
  private validateCatalog(body: string) {
    const data = rows(body);
    // Candidate catalog formats; HTTP documentation/real samples must confirm the deployed envelope.
    const catalog = new Map<string, Set<string>>();
    for (const entry of data) {
      const name = entry.TableName;
      if (typeof name !== 'string') throw new WorkerError('CATALOG_FORMAT_UNCONFIRMED');
      const columns = catalog.get(name) ?? new Set<string>();
      const values = Array.isArray(entry.Columns) ? entry.Columns : [entry.ColumnName];
      for (const value of values) {
        const col = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>).ColumnName : undefined;
        if (typeof col !== 'string') throw new WorkerError('CATALOG_COLUMNS_UNCONFIRMED');
        columns.add(col);
      }
      catalog.set(name, columns);
    }
    const required: Record<string, string[]> = {
      AttemptsRawData: ['AttemptsRawDataID', 'CallId', 'StartDate', 'OriginalPhoneNumber', 'AgentId', 'CampaignId', 'DispositionId'],
      Users: ['AgentId', 'UserName'], Campaign: ['CampaignId', 'Description'], Disposition: ['DispositionId', 'Description'],
    };
    for (const [table, cols] of Object.entries(required)) {
      if (cols.some(col => !catalog.get(table)?.has(col))) throw new WorkerError(`CATALOG_MISSING_${table}`);
    }
  }
}
