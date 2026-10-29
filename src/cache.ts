import { OlosApi, rows } from './api.js';
import { type Cache, textValue } from './mapping.js';
import { WorkerError } from './errors.js';

export class StaticCache {
  value: Cache = { users: new Map(), campaigns: new Map(), dispositions: new Map() };
  private loadedAt = -Infinity;
  constructor(private readonly api: OlosApi, private readonly ttlMs: number, private readonly now = Date.now) {}
  async refresh(force = false): Promise<boolean> {
    if (!force && this.now() - this.loadedAt < this.ttlMs) return false;
    const next: Cache = { users: new Map(), campaigns: new Map(), dispositions: new Map() };
    for (const [table, key, name, target] of [
      ['Users', 'AgentId', 'UserName', next.users], ['Campaign', 'CampaignId', 'Description', next.campaigns],
      ['Disposition', 'DispositionId', 'Description', next.dispositions],
    ] as const) {
      // No original Users object survives this mapping. Password is never persisted or logged.
      for (const row of rows(await this.api.call('/api/export-data/read-data', { TableName: table }))) {
        const id = textValue(row[key]), label = textValue(row[name]);
        if (id !== null && label !== null) {
          if (target.has(id) && target.get(id) !== label) throw new WorkerError(`REFERENCE_AMBIGUOUS_${table}`);
          target.set(id, label);
        }
      }
    }
    this.value = next; this.loadedAt = this.now();
    return true;
  }
}
