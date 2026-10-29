import pg from 'pg';
import { WorkerError, errorCode } from '../errors.js';
import { assertSchema } from '../schema.js';
import type { CycleReport } from '../worker.js';

export type Mode = 'RUNNING' | 'PAUSED' | 'STOPPED';
export type State = Mode | 'PAUSING' | 'STOPPING' | 'ERROR';
export type Settings = { enabled: boolean; interval_ms: number; desired_state: Mode; runtime_state: State; last_error: string | null; updated_at: string; updated_by: string };
export type CredentialRow = { revision: number; encrypted_payload: string; last_test_at: string | null; last_test_ok: boolean | null; last_test_code: string | null; last_test_ms: number | null };
export function interval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 60000 || value > 3600000) throw new WorkerError('SCHEDULER_INTERVAL_INVALID');
  return value;
}
export interface SchedulerRepository {
  settings(): Promise<Settings>;
  change(actor: string, patch: { interval_ms?: number; mode?: Mode }): Promise<void>;
  state(state: State, error?: string): Promise<void>;
}

export class AdminRepository implements SchedulerRepository {
  readonly pool: pg.Pool;
  private owner: pg.PoolClient | undefined;
  private alive = false;
  constructor(url: string, readonly source: string, private readonly destination = { schema: 'raw', table: 'olos_calls' }) {
    this.pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
    this.pool.on('error', () => { this.alive = false; });
  }
  async open(fallback: number, initial: Mode) {
    this.owner = await this.pool.connect();
    this.owner.on('error', () => { this.alive = false; });
    const lock = await this.owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`olos-admin:${this.source}`]);
    if (!lock.rows[0].acquired) throw new WorkerError('SCHEDULER_ALREADY_ACTIVE');
    this.alive = true;
    const existing = await this.pool.query('SELECT 1 FROM olos_http.worker_settings WHERE source_key=$1', [this.source]);
    if (!existing.rowCount) {
      await this.pool.query(`INSERT INTO olos_http.worker_settings(source_key,enabled,interval_ms,desired_state,updated_by)
        VALUES ($1,$2,$3,$4,'system:bootstrap') ON CONFLICT(source_key) DO NOTHING`, [this.source, initial === 'RUNNING', interval(fallback), initial]);
    }
    // A previous live state without its owning process is a failure, never a voluntary stop.
    const saved = await this.settings();
    if (['RUNNING','PAUSING','STOPPING'].includes(saved.runtime_state)) await this.state('ERROR', 'UNCLEAN_SCHEDULER_EXIT');
  }
  private check() { if (!this.alive) throw new WorkerError('ADMIN_DATABASE_SESSION_LOST'); }
  async settings(): Promise<Settings> {
    this.check();
    const row = (await this.pool.query('SELECT enabled,interval_ms,desired_state,runtime_state,last_error,updated_at,updated_by FROM olos_http.worker_settings WHERE source_key=$1', [this.source])).rows[0];
    if (!row) throw new WorkerError('SCHEDULER_CONFIGURATION_MISSING');
    interval(row.interval_ms); return row;
  }
  async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>) {
    this.check(); const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); this.check(); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { db.release(); }
  }
  async audit(db: pg.PoolClient, actor: string, action: string, metadata: Record<string, unknown> = {}) {
    await db.query('INSERT INTO olos_http.admin_audit(source_key,actor,action,metadata) VALUES($1,$2,$3,$4)', [this.source, actor, action, JSON.stringify(metadata)]);
  }
  async change(actor: string, patch: { interval_ms?: number; mode?: Mode }) {
    if (patch.interval_ms !== undefined) interval(patch.interval_ms);
    if (patch.mode !== undefined && !['RUNNING','PAUSED','STOPPED'].includes(patch.mode)) throw new WorkerError('SCHEDULER_MODE_INVALID');
    await this.transaction(async db => {
      await db.query(`UPDATE olos_http.worker_settings SET interval_ms=COALESCE($2,interval_ms),
        desired_state=COALESCE($3,desired_state),enabled=CASE WHEN $3::text IS NULL THEN enabled ELSE $3='RUNNING' END,
        updated_at=clock_timestamp(),updated_by=$4 WHERE source_key=$1`, [this.source, patch.interval_ms ?? null, patch.mode ?? null, actor]);
      await this.audit(db, actor, patch.mode ? `scheduler_request_${patch.mode.toLowerCase()}` : 'scheduler_interval_changed', patch);
    });
  }
  async state(state: State, error?: string) {
    await this.transaction(async db => {
      await db.query('UPDATE olos_http.worker_settings SET runtime_state=$2,last_error=$3 WHERE source_key=$1', [this.source, state, error ?? null]);
      await this.audit(db, 'system:scheduler', 'scheduler_state', { state, error: error ?? null });
    });
  }
  async credentials(): Promise<CredentialRow | undefined> {
    this.check(); return (await this.pool.query('SELECT revision,encrypted_payload,last_test_at,last_test_ok,last_test_code,last_test_ms FROM olos_http.admin_credentials WHERE source_key=$1', [this.source])).rows[0];
  }
  async saveCredentials(actor: string, expected: number, encrypted: string) {
    await this.transaction(async db => {
      // Lock the settings row also serializes the first credentials insert.
      await db.query('SELECT source_key FROM olos_http.worker_settings WHERE source_key=$1 FOR UPDATE', [this.source]);
      const current = (await db.query('SELECT revision FROM olos_http.admin_credentials WHERE source_key=$1', [this.source])).rows[0];
      if ((current?.revision ?? 0) !== expected) throw new WorkerError('CREDENTIAL_REVISION_CONFLICT');
      await db.query(`INSERT INTO olos_http.admin_credentials(source_key,revision,encrypted_payload,updated_by) VALUES($1,1,$2,$3)
        ON CONFLICT(source_key) DO UPDATE SET revision=admin_credentials.revision+1,encrypted_payload=$2,updated_by=$3,
        updated_at=clock_timestamp(),last_test_at=NULL,last_test_ok=NULL,last_test_code=NULL,last_test_ms=NULL`, [this.source, encrypted, actor]);
      await this.audit(db, actor, 'credentials_updated', { revision: expected + 1 });
    });
  }
  async tested(actor: string, revision: number, ok: boolean, code: string, ms: number) {
    await this.transaction(async db => {
      await db.query(`UPDATE olos_http.admin_credentials SET last_test_at=clock_timestamp(),last_test_ok=$3,last_test_code=$4,last_test_ms=$5
        WHERE source_key=$1 AND revision=$2`, [this.source, revision, ok, code, ms]);
      await this.audit(db, actor, 'credentials_tested', { revision, ok, code, duration_ms: ms });
    });
  }
  async lastEnvironmentTest() {
    this.check();
    const row = (await this.pool.query(`SELECT occurred_at,metadata FROM olos_http.admin_audit
      WHERE source_key=$1 AND action='credentials_tested' AND metadata->>'revision'='0' ORDER BY id DESC LIMIT 1`, [this.source])).rows[0];
    return row ? { at: row.occurred_at, ok: row.metadata.ok, code: row.metadata.code, duration_ms: row.metadata.duration_ms } : null;
  }
  async authEvent(actor: string, result: 'accepted' | 'denied' | 'failed') {
    await this.transaction(db => this.audit(db, actor, 'web_olos_login', { result }));
  }
  async cycleCompleted(report: CycleReport) {
    await this.transaction(async db => {
      const confirmed = await db.query(`SELECT 1 FROM olos_http.reads WHERE id=$1 AND source_key=$2
        AND state='done' AND processed_count=received_count AND received_count=$3`, [report.read_id, this.source, report.received]);
      if (confirmed.rowCount !== 1) throw new WorkerError('CYCLE_PERSISTENCE_UNCONFIRMED');
      await this.audit(db, 'system:scheduler', 'ingestion_cycle_completed', report);
    });
  }
  async observation() {
    let reachable = false, schemaValid = false, dbError: string | null = null;
    let db: pg.PoolClient | undefined;
    try {
      this.check(); db = await this.pool.connect();
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query('SELECT 1'); reachable = true;
      // A separate read-only preflight; never acquires the consumer lock or requires starting it.
      await db.query('SAVEPOINT schema_check');
      try {
        await assertSchema(db, this.destination.schema, this.destination.table);
        await db.query('SELECT id,state,processed_count,received_count FROM olos_http.reads LIMIT 0');
        await db.query('SELECT source_key,source_id,target_id FROM olos_http.records LIMIT 0');
        schemaValid = true;
      } catch (error) { dbError = errorCode(error); await db.query('ROLLBACK TO SAVEPOINT schema_check'); }
      const pending = (await db.query(`SELECT state,count(*)::int AS count FROM olos_http.reads
        WHERE source_key=$1 AND state IN ('reading','received') GROUP BY state`, [this.source])).rows;
      const latest = (await db.query(`SELECT id,state,started_at,finished_at,received_count,processed_count,request_ms,error_code
        FROM olos_http.reads WHERE source_key=$1 ORDER BY started_at DESC,id DESC LIMIT 1`, [this.source])).rows[0] ?? null;
      const completed = (await db.query(`SELECT r.id,r.finished_at,r.received_count,
        a.metadata->'inserted' AS inserted,a.metadata->'duplicates' AS duplicates,a.metadata->'duration_ms' AS duration_ms,
        a.id IS NOT NULL AS measured
        FROM olos_http.reads r LEFT JOIN LATERAL (
          SELECT id,metadata FROM olos_http.admin_audit WHERE source_key=$1 AND action='ingestion_cycle_completed'
          AND metadata->>'read_id'=r.id::text ORDER BY id DESC LIMIT 1
        ) a ON true WHERE r.source_key=$1 AND r.state='done' AND r.processed_count=r.received_count
        ORDER BY r.finished_at DESC NULLS LAST,r.id DESC LIMIT 1`, [this.source])).rows[0] ?? null;
      const lastError = (await db.query(`SELECT code,at FROM (
        SELECT metadata->>'error' AS code,occurred_at AS at FROM olos_http.admin_audit
          WHERE source_key=$1 AND action='scheduler_state' AND metadata->>'state'='ERROR'
        UNION ALL SELECT error_code,started_at FROM olos_http.reads WHERE source_key=$1 AND error_code IS NOT NULL
      ) errors WHERE code IS NOT NULL ORDER BY at DESC LIMIT 1`, [this.source])).rows[0] ?? null;
      await db.query('ROLLBACK');
      return { database: { reachable, schema_valid: schemaValid, error: dbError }, ingestion: {
        status: pending.length ? 'PENDING' : completed ? 'CONFIRMED' : 'NOT_OBSERVED', latest, last_completed: completed, pending, last_error: lastError,
      } };
    } catch (error) {
      await db?.query('ROLLBACK').catch(() => {});
      return { database: { reachable, schema_valid: schemaValid, error: errorCode(error) }, ingestion: {
        status: 'UNKNOWN', latest: null, last_completed: null, pending: null, last_error: null,
      } };
    } finally { db?.release(); }
  }
  async logs() {
    this.check();
    return (await this.pool.query(`SELECT id,state,started_at,finished_at,processed_count,received_count,request_ms,error_code,
      octet_length(response_body) AS response_bytes FROM olos_http.reads WHERE source_key=$1 ORDER BY started_at DESC LIMIT 100`, [this.source])).rows;
  }
  async auditLog() {
    this.check(); return (await this.pool.query('SELECT id,actor,action,occurred_at,metadata FROM olos_http.admin_audit WHERE source_key=$1 ORDER BY id DESC LIMIT 100', [this.source])).rows;
  }
  async close() { this.alive = false; this.owner?.release(true); this.owner = undefined; await this.pool.end(); }
}
