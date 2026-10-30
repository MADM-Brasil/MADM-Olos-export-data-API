import pg from 'pg';
import type { Config } from '../config.js';
import { log, WorkerError } from '../errors.js';
import { quote } from '../schema.js';
import { CorporateDelivery } from './delivery.js';

// Existing CLI control operations may run while the ingestion owner holds the source lock.
// They never capture OLOS, acquire its lock or admit an independent delivery loop.
export async function corporateControl(cfg: Config, command: string): Promise<void> {
  if (!cfg.corporateDelivery) throw new WorkerError('CORPORATE_MODE_REQUIRED');
  if (!['corporate-status','corporate-check','corporate-pause','corporate-resume'].includes(command)) throw new WorkerError('COMMAND_INVALID');
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  pool.on('error', () => {});
  try {
    const local = await pool.connect();
    local.on('error', () => {});
    try {
      const delivery = new CorporateDelivery(cfg.corporateDelivery, cfg.sourceKey, `${quote(cfg.schema)}.${quote(cfg.table)}`, pool, () => false, () => {});
      if (command === 'corporate-check') { await delivery.check(local); log('corporate_schema_checked'); }
      if (command === 'corporate-status') {
        const state = await delivery.status(local);
        log('corporate_delivery_status', { ready: !!state.ready, paused: !!state.paused, blocked: !!state.blocked,
          pending: state.pending, confirmed: Number(state.confirmed_count ?? 0), legacy: Number(state.legacy_count ?? 0), error: state.last_code ?? null });
      }
      if (command === 'corporate-pause') { await delivery.pause(local); log('corporate_delivery_paused'); }
      if (command === 'corporate-resume') { await delivery.resume(local); log('corporate_delivery_resumed'); }
    } finally { local.release(true); }
  } finally { await pool.end(); }
}
