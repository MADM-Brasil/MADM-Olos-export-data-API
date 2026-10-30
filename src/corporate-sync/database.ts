import { readFileSync } from 'node:fs';
import pg, { type Client } from 'pg';
import type { Config } from './config.js';
import { SyncError } from './errors.js';

export async function connect(cfg: Config, side: 'source' | 'destination'): Promise<Client> {
  const tls = side === 'source' ? cfg.sourceTls : cfg.destinationTls;
  const caFile = side === 'source' ? cfg.sourceCa : cfg.destinationCa;
  const db = new pg.Client({
    connectionString: side === 'source' ? cfg.sourceUrl : cfg.destinationUrl,
    application_name: 'corporate-sync',
    ssl: tls ? { rejectUnauthorized: true, ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {}) } : false,
    connectionTimeoutMillis: cfg.timeoutMs,
    statement_timeout: cfg.timeoutMs,
    lock_timeout: cfg.timeoutMs,
    // No idle-in-transaction timeout: source row lock fences the entire remote retry window.
    options: '-c timezone=UTC -c datestyle=ISO,YMD',
  });
  // pg otherwise emits an unhandled error containing connection details on idle disconnect.
  db.on('error', () => {});
  try { await db.connect(); return db; }
  catch (error) { await db.end().catch(() => {}); throw error; }
}

export async function rollback(db: Client): Promise<void> { await db.query('ROLLBACK').catch(() => {}); }
export async function lock(db: Client): Promise<void> {
  const result = await db.query('SELECT pg_try_advisory_lock(17320914, 1) AS acquired');
  if (result.rows[0]?.acquired !== true) throw new SyncError('SYNC_ALREADY_RUNNING');
}

export async function migrate(db: Client): Promise<void> {
  const sql = readFileSync(new URL('../../migrations/corporate-sync/001_control.sql', import.meta.url), 'utf8');
  await db.query(sql);
}
