import type { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { assertWriteAuthorized, type Config } from './config.js';
import { connect, lock, rollback } from './database.js';
import { log, retryable, SyncError } from './errors.js';
import { columns, compare, digest, identityColumns, mapRow, projection, quote, type Row, type Shape } from './mapping.js';
import { schema } from './schema.js';

function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw new SyncError('STOP_REQUESTED');
}
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }); }
  catch { stopped(signal); }
}
async function controlsExist(db: Client): Promise<boolean> {
  return (await db.query("SELECT to_regclass('corporate_sync.control') IS NOT NULL AND to_regclass('corporate_sync.receipts') IS NOT NULL AS present")).rows[0].present;
}
async function assertBinding(db: Client, cfg: Config): Promise<void> {
  const state = (await db.query('SELECT version, binding FROM corporate_sync.control WHERE singleton')).rows[0];
  if (state && (state.version !== 1 || state.binding !== cfg.binding)) throw new SyncError('CHECKPOINT_BINDING_MISMATCH');
}
async function selectBatch(db: Client, shape: Shape, cfg: Config, controls: boolean): Promise<Row[]> {
  const p = projection(shape, 's', true, cfg);
  const result = await db.query(`SELECT ${p.sql} FROM raw.olos_calls s
    ${controls ? 'LEFT JOIN corporate_sync.receipts r ON r.internal_id_olos=s.internal_id_olos' : ''}
    ${controls ? 'WHERE r.internal_id_olos IS NULL' : ''}
    ORDER BY s.internal_id_olos LIMIT $${p.parameters.length + 1}`, [...p.parameters, cfg.batchSize]);
  return result.rows.map(row => mapRow(row, shape, cfg));
}
function pendingRows(value: unknown, shape: Shape, cfg: Config): Row[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) throw new SyncError('PENDING_BATCH_INVALID');
  const rows = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyncError('PENDING_BATCH_INVALID');
    return mapRow(raw as Record<string, unknown>, shape, cfg);
  });
  if (new Set(rows.map(row => row.internal_id_olos)).size !== rows.length) throw new SyncError('PENDING_BATCH_INVALID');
  return rows;
}

async function destinationMatches(db: Client, rows: Row[], shape: Shape, cfg: Config): Promise<Map<string, Row>> {
  const p = projection(shape, 'd', false, cfg);
  const declarations = columns.map(name => `${quote(name)} ${shape.get(name)!.type}`).join(',');
  // Compare full logical identity, including time, phone and campaign, never CallId alone.
  const identity = identityColumns.map(name => `d.${quote(name)} IS NOT DISTINCT FROM x.${quote(name)}`).join(' AND ');
  const result = await db.query(`SELECT DISTINCT ${p.sql} FROM raw.olos_calls d
    JOIN jsonb_to_recordset($1::jsonb) AS x(${declarations})
    ON d.internal_id_olos=x.internal_id_olos OR (${identity})`, [JSON.stringify(rows)]);
  const byId = new Map(rows.map(row => [row.internal_id_olos, row]));
  const matches = new Map<string, Row>();
  for (const raw of result.rows) {
    const existing = mapRow(raw, shape, cfg);
    const expected = byId.get(existing.internal_id_olos);
    if (!expected) throw new SyncError('LOGICAL_CALL_AT_DIFFERENT_ID');
    compare(existing, expected);
    matches.set(existing.internal_id_olos!, existing);
  }
  return matches;
}

export async function deliver(db: Client, rows: Row[], shape: Shape, cfg: Config, signal: AbortSignal): Promise<{ inserted: number; existing: number }> {
  assertWriteAuthorized(cfg);
  stopped(signal);
  // Reject duplicates within the source batch as well as pre-existing destination calls.
  const identities = rows.map(row => JSON.stringify(identityColumns.map(name => row[name])));
  if (new Set(identities).size !== identities.length) throw new SyncError('DUPLICATE_LOGICAL_IDENTITY');
  await destinationMatches(db, rows, shape, cfg);
  let inserted = 0;
  const names = columns.map(quote).join(',');
  for (const row of rows) {
    stopped(signal);
    const result = await db.query(`INSERT INTO raw.olos_calls (${names}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})
      ON CONFLICT (internal_id_olos) WHERE internal_id_olos IS NOT NULL DO NOTHING`, columns.map(name => row[name]));
    inserted += result.rowCount ?? 0;
  }
  // A competing PK writer may have won after the first read. Always re-read and compare.
  const after = await destinationMatches(db, rows, shape, cfg);
  if (after.size !== rows.length) throw new SyncError('DESTINATION_VERIFICATION_FAILED');
  return { inserted, existing: rows.length - inserted };
}

export interface Hooks {
  // Fault injection only; CLI never supplies hooks.
  beforeRemoteCommit?: () => Promise<void>;
  afterRemoteCommit?: () => Promise<void>;
  beforeLocalCommit?: () => Promise<void>;
}
async function remoteBatch(rows: Row[], cfg: Config, signal: AbortSignal, hooks: Hooks): Promise<{ inserted: number; existing: number }> {
  for (let attempt = 0; ; attempt++) {
    stopped(signal);
    let remote: Client | undefined;
    try {
      remote = await connect(cfg, 'destination');
      await remote.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await remote.query('LOCK TABLE raw.olos_calls IN ROW EXCLUSIVE MODE');
      const shape = await schema(remote, 'destination', cfg, true);
      const validated = rows.map(row => mapRow(row, shape, cfg));
      const result = await deliver(remote, validated, shape, cfg, signal);
      await hooks.beforeRemoteCommit?.();
      stopped(signal);
      await remote.query('COMMIT');
      await hooks.afterRemoteCommit?.();
      return result;
    } catch (error) {
      if (remote) await rollback(remote);
      if (!retryable(error) || attempt >= cfg.maxRetries || signal.aborted) throw error;
      log('retry', { attempt: attempt + 1 });
    } finally { if (remote) await remote.end().catch(() => {}); }
    // Ambiguous COMMIT is retried from the same durable batch; existing rows must match exactly.
    await pause(Math.min(60000, cfg.backoffMs * 2 ** attempt) + Math.floor(Math.random() * cfg.backoffMs), signal);
  }
}

export async function preflight(local: Client, cfg: Config): Promise<Shape> {
  const remote = await connect(cfg, 'destination');
  try {
    await local.query('BEGIN READ ONLY');
    await remote.query('BEGIN READ ONLY');
    await local.query('SELECT 1 FROM raw.olos_calls LIMIT 0');
    await remote.query('SELECT 1 FROM raw.olos_calls LIMIT 0');
    const localId = (await local.query('SELECT inet_server_addr()::text AS host, inet_server_port() AS port, current_database() AS db')).rows[0];
    const remoteId = (await remote.query('SELECT inet_server_addr()::text AS host, inet_server_port() AS port, current_database() AS db')).rows[0];
    if (JSON.stringify(localId) === JSON.stringify(remoteId)) throw new SyncError('SOURCE_EQUALS_DESTINATION');
    await schema(local, 'source', cfg);
    const shape = await schema(remote, 'destination', cfg, cfg.mode === 'once' || cfg.mode === 'start');
    if (await controlsExist(local)) await assertBinding(local, cfg);
    return shape;
  } finally {
    await rollback(local);
    await rollback(remote);
    await remote.end().catch(() => {});
  }
}

export async function preview(local: Client, cfg: Config, shape: Shape): Promise<{ count: number; existing: number }> {
  const remote = await connect(cfg, 'destination');
  try {
    await local.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const controls = await controlsExist(local);
    const state = controls ? (await local.query('SELECT pending FROM corporate_sync.control WHERE singleton')).rows[0] : undefined;
    const rows = state?.pending ? pendingRows(state.pending, shape, cfg) : await selectBatch(local, shape, cfg, controls);
    const identities = rows.map(row => JSON.stringify(identityColumns.map(name => row[name])));
    if (new Set(identities).size !== identities.length) throw new SyncError('DUPLICATE_LOGICAL_IDENTITY');
    const matches = rows.length ? await destinationMatches(remote, rows, shape, cfg) : new Map();
    return { count: rows.length, existing: matches.size };
  } finally { await rollback(local); await rollback(remote); await remote.end().catch(() => {}); }
}

export async function runBatch(local: Client, cfg: Config, shape: Shape, signal: AbortSignal, hooks: Hooks = {}): Promise<number> {
  assertWriteAuthorized(cfg);
  stopped(signal);
  // Freeze the projection locally before any remote write. A source update after a crash cannot change replay.
  await local.query('BEGIN');
  try {
    await assertBinding(local, cfg);
    const state = (await local.query('SELECT pending FROM corporate_sync.control WHERE singleton FOR UPDATE')).rows[0];
    if (!state) throw new SyncError('CHECKPOINT_MISSING');
    if (!state.pending) {
      await schema(local, 'source', cfg);
      const rows = await selectBatch(local, shape, cfg, true);
      if (!rows.length) { await local.query('COMMIT'); return 0; }
      await local.query('UPDATE corporate_sync.control SET pending=$1::jsonb, updated_at=now() WHERE singleton', [JSON.stringify(rows)]);
    }
    await local.query('COMMIT');
  } catch (error) { await rollback(local); throw error; }

  await local.query('BEGIN');
  try {
    const state = (await local.query('SELECT generation::text, pending FROM corporate_sync.control WHERE singleton FOR UPDATE')).rows[0];
    const rows = pendingRows(state?.pending, shape, cfg);
    const result = await remoteBatch(rows, cfg, signal, hooks);
    // Once COMMIT is acknowledged, complete the local acknowledgement even on SIGTERM.
    for (const row of rows) {
      await local.query('INSERT INTO corporate_sync.receipts(internal_id_olos,payload_hash) VALUES($1,$2)', [row.internal_id_olos, digest(row)]);
    }
    const saved = await local.query(`UPDATE corporate_sync.control SET generation=generation+1,
      last_confirmed_id=$1, confirmed_count=confirmed_count+$2, pending=NULL, updated_at=now()
      WHERE singleton AND generation=$3`, [rows.at(-1)!.internal_id_olos, rows.length, state.generation]);
    if (saved.rowCount !== 1) throw new SyncError('CHECKPOINT_FENCE_LOST');
    await hooks.beforeLocalCommit?.();
    await local.query('COMMIT');
    log('batch_committed', { count: rows.length, ...result });
    return rows.length;
  } catch (error) { await rollback(local); throw error; }
}

export async function run(cfg: Config, signal: AbortSignal, hooks: Hooks = {}): Promise<void> {
  if (cfg.mode === 'once' || cfg.mode === 'start') assertWriteAuthorized(cfg);
  const local = await connect(cfg, 'source');
  try {
    const shape = await preflight(local, cfg);
    if (cfg.mode === 'check') { log('checked'); return; }
    if (cfg.mode === 'dry-run') { log('preview', await preview(local, cfg, shape)); return; }
    await lock(local);
    if (!(await controlsExist(local))) throw new SyncError('LOCAL_MIGRATION_REQUIRED');
    await local.query('INSERT INTO corporate_sync.control(singleton,binding) VALUES(true,$1) ON CONFLICT(singleton) DO NOTHING', [cfg.binding]);
    await assertBinding(local, cfg);
    do {
      const count = await runBatch(local, cfg, shape, signal, hooks);
      if (cfg.mode === 'once') return;
      if (!count) { log('idle'); await pause(cfg.intervalMs, signal); }
    } while (!signal.aborted);
  } finally { await local.end().catch(() => {}); }
}
