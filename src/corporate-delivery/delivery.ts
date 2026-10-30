import type { Client, Pool, PoolClient } from 'pg';
import { connect, rollback } from '../corporate-sync/database.js';
import { retryable, safeCode, SyncError } from '../corporate-sync/errors.js';
import { columns, digest, integerValue, mapRow, quote, type Row, type Shape } from '../corporate-sync/mapping.js';
import { log } from '../errors.js';
import type { MappedRecord } from '../mapping.js';
import type { DeliveryConfig } from './config.js';
import { corporateSchema, freeze, matches, uniqueIdentities } from './contract.js';
import { reconcileLegacy } from './reconcile.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';

export interface DeliveryHooks {
  beforeRemoteCommit?: () => Promise<void>;
  afterRemoteCommit?: () => Promise<void>;
  beforeLocalCommit?: () => Promise<void>;
}
export class CorporateDelivery {
  private active: Promise<void> | undefined;
  private admitted = true;
  private closing = false;
  private fatal: unknown;
  constructor(readonly cfg: DeliveryConfig, readonly source: string, readonly target: string,
    private readonly pool: Pool, private readonly ownerAlive: () => boolean, private readonly localFailure: () => void) {}

  async open(local: PoolClient): Promise<void> {
    if (!(await local.query('SELECT pg_try_advisory_lock(17320914,1) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_SYNC_STILL_RUNNING');
    await local.query('SELECT binding FROM olos_http.corporate_control LIMIT 0');
    await local.query('SELECT source_id,state,payload FROM olos_http.corporate_outbox LIMIT 0');
    const state = (await local.query('SELECT source_key,target_table,binding FROM olos_http.corporate_control WHERE singleton')).rows[0];
    if (state && (state.source_key !== this.source || state.target_table !== this.target || state.binding !== this.cfg.binding)) throw new SyncError('CORPORATE_BINDING_CHANGED');
  }
  private async state(local: PoolClient, forUpdate = false) {
    const state = (await local.query(`SELECT *,next_attempt_at>clock_timestamp() AS retry_wait
      FROM olos_http.corporate_control WHERE singleton${forUpdate ? ' FOR UPDATE' : ''}`)).rows[0];
    if (!state?.ready) throw new SyncError('CORPORATE_LEGACY_RECONCILIATION_REQUIRED');
    if (state.binding !== this.cfg.binding || state.source_key !== this.source || state.target_table !== this.target) throw new SyncError('CORPORATE_BINDING_CHANGED');
    return state;
  }
  async captureReady(local: PoolClient): Promise<void> {
    await assertLocalConsumersCompatible(local, this.source);
    await this.state(local);
  }
  reconcile(local: PoolClient, sequence: string) { return reconcileLegacy(local, this.cfg, this.source, this.target, sequence); }
  async status(local: PoolClient) {
    const binding = (await local.query('SELECT binding,source_key FROM olos_http.corporate_control WHERE singleton')).rows[0];
    if (binding && (binding.binding !== this.cfg.binding || binding.source_key !== this.source)) throw new SyncError('CORPORATE_BINDING_CHANGED');
    const state = (await local.query(`SELECT ready,paused,blocked,legacy_count::text,confirmed_count::text,
      failure_count,next_attempt_at,last_code FROM olos_http.corporate_control WHERE singleton`)).rows[0];
    return { ...(state ?? { ready: false }), pending: Number((await local.query("SELECT count(*)::text AS n FROM olos_http.corporate_outbox WHERE state='pending'")).rows[0].n) };
  }
  async check(local: PoolClient): Promise<void> {
    await assertLocalConsumersCompatible(local, this.source);
    const state = await this.state(local);
    const remote = await connect(this.cfg.connection, 'destination');
    try {
      await remote.query('BEGIN READ ONLY');
      const contract = await corporateSchema(remote, this.cfg, false);
      if (contract.hash !== state.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
    } finally { await rollback(remote); await remote.end().catch(() => {}); }
  }
  async pause(local: PoolClient): Promise<void> {
    await this.state(local);
    this.admitted = false;
    await this.settle();
    await local.query('UPDATE olos_http.corporate_control SET paused=true,updated_at=now() WHERE singleton');
  }
  async resume(local: PoolClient): Promise<void> {
    if (!this.cfg.connection.writeEnabled) throw new SyncError('CORPORATE_WRITE_NOT_AUTHORIZED');
    await assertLocalConsumersCompatible(local, this.source);
    await local.query('BEGIN');
    try {
      // Lock before checking: a concurrently finishing delivery may have just discovered a conflict.
      const state = await this.state(local, true);
      if (state.blocked && !['DATABASE_TRANSIENT_FAILURE','CORPORATE_COMMIT_UNKNOWN'].includes(state.last_code)) throw new SyncError('CORPORATE_DELIVERY_BLOCKED');
      await local.query(`UPDATE olos_http.corporate_control SET paused=false,blocked=false,failure_count=0,
        next_attempt_at=NULL,updated_at=now() WHERE singleton`);
      await local.query('COMMIT');
    } catch (error) { await rollback(local); throw error; }
    this.admitted = true;
  }
  suspend(): void { this.admitted = false; }
  allow(): void { if (!this.closing) this.admitted = true; }
  async settle(): Promise<void> { await this.active; if (this.fatal) throw this.fatal; }
  async close(): Promise<void> { this.closing = true; this.suspend(); await this.settle(); }
  kick(): void {
    if (!this.admitted || this.closing || this.active || !this.cfg.connection.writeEnabled || !this.ownerAlive()) return;
    this.active = this.tick().catch(error => { this.fatal = error; this.localFailure(); })
      .finally(() => { this.active = undefined; });
  }
  private fence(): void {
    if (!this.ownerAlive()) throw new SyncError('CORPORATE_OWNER_LOST');
  }

  async enqueue(local: PoolClient, sequence: string, input: MappedRecord[]): Promise<{ queued: number; duplicates: number }> {
    const state = await this.state(local);
    const shape = new Map(state.destination_shape) as Shape;
    let queued = 0, duplicates = 0;
    for (const record of input) {
      const previous = (await local.query(`SELECT r.source_hash,r.target_table,r.target_id::text,o.payload_hash
        FROM olos_http.records r LEFT JOIN olos_http.corporate_outbox o USING(source_key,source_id)
        WHERE r.source_key=$1 AND r.source_id=$2`, [this.source, record.source_id])).rows[0];
      if (previous) {
        if (previous.source_hash !== record.source_hash || previous.target_table !== this.target) throw new SyncError('SOURCE_ID_CONTENT_CONFLICT');
        if (!previous.payload_hash) throw new SyncError('LEGACY_RECORD_RECONCILIATION_REQUIRED');
        duplicates++; continue;
      }
      const id = integerValue((await local.query('SELECT nextval($1::regclass)::text AS id', [sequence])).rows[0].id, 32);
      const payload = (await freeze(local, [{ ...record, internal_id_olos: id }], shape, this.cfg))[0]!;
      await local.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,campaign_id,disposition_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [this.source, record.source_id, this.target, id, record.source_hash, record.agent_id, record.campaign_id, record.disposition_id]);
      await local.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,origin)
        VALUES($1,$2,$3,$4,$5,$6,'capture')`, [this.source, record.source_id, id, record.source_hash, JSON.stringify(payload), digest(payload)]);
      queued++;
    }
    return { queued, duplicates };
  }

  // One bounded attempt per existing scheduler cycle/manual command. No timer, retry loop or scheduler here.
  async tick(hooks: DeliveryHooks = {}): Promise<void> {
    if (!this.cfg.connection.writeEnabled || !this.admitted) return;
    this.fence();
    const local = await this.pool.connect();
    const lostLocalSession = () => this.localFailure();
    local.on('error', lostLocalSession);
    let remote: Client | undefined;
    let remoteFailure = false;
    try {
      await local.query('BEGIN');
      await assertLocalConsumersCompatible(local, this.source);
      const state = await this.state(local, true);
      if (state.paused || state.blocked || state.retry_wait) { await local.query('COMMIT'); return; }
      const entries = (await local.query(`SELECT source_id,target_id::text,payload,payload_hash FROM olos_http.corporate_outbox
        WHERE source_key=$1 AND state='pending' ORDER BY target_id LIMIT $2 FOR UPDATE`, [this.source, this.cfg.connection.batchSize])).rows;
      if (!entries.length) { await local.query('COMMIT'); return; }
      let found: Map<string, string>;
      let commitIssued = false;
      try {
        this.fence();
        remote = await connect(this.cfg.connection, 'destination');
        await remote.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await remote.query('LOCK TABLE raw.olos_calls IN ROW EXCLUSIVE MODE');
        const { shape, hash } = await corporateSchema(remote, this.cfg, true);
        if (hash !== state.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
        const rows = entries.map(entry => {
          const row = mapRow(entry.payload, shape, this.cfg.connection);
          if (digest(row) !== entry.payload_hash || row.internal_id_olos !== entry.target_id) throw new SyncError('CORPORATE_PAYLOAD_CHANGED');
          return row;
        });
        uniqueIdentities(rows);
        found = await matches(remote, rows, shape, this.cfg);
        for (const row of rows) {
          this.fence();
          // Exact existing rows are never INSERTed again; even their corporate trigger is not invoked.
          if (found.has(row.internal_id_olos!)) continue;
          await remote.query(`INSERT INTO raw.olos_calls (${columns.map(quote).join(',')})
            VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})
            ON CONFLICT (internal_id_olos) WHERE internal_id_olos IS NOT NULL DO NOTHING`, columns.map(name => row[name]));
        }
        found = await matches(remote, rows, shape, this.cfg);
        if (found.size !== rows.length) throw new SyncError('CORPORATE_VERIFICATION_FAILED');
        await hooks.beforeRemoteCommit?.();
        this.fence();
        commitIssued = true;
        await remote.query('COMMIT');
        await hooks.afterRemoteCommit?.();
      } catch (error) {
        remoteFailure = true;
        if (remote) await rollback(remote);
        const failures = state.failure_count + 1;
        // Network termination during COMMIT does not always carry a PostgreSQL/Node error code.
        const code = commitIssued ? 'CORPORATE_COMMIT_UNKNOWN' : safeCode(error);
        const terminal = !(commitIssued || retryable(error)) || failures >= this.cfg.connection.maxRetries;
        const delay = Math.min(60000, this.cfg.connection.backoffMs * 2 ** Math.min(failures - 1, 16));
        await local.query(`UPDATE olos_http.corporate_control SET failure_count=$1,blocked=$2,last_code=$3,
          next_attempt_at=now()+($4::integer*interval '1 millisecond'),updated_at=now() WHERE singleton`,
        [failures, terminal, code, delay]);
        await local.query('COMMIT');
        log('corporate_delivery_deferred', { error: code, retry_ms: delay, blocked: terminal });
        return;
      }
      this.fence();
      for (const entry of entries) {
        const updated = await local.query(`UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=$3,confirmed_at=now()
          WHERE source_key=$1 AND source_id=$2 AND state='pending' AND payload_hash=$4`,
        [this.source, entry.source_id, found.get(entry.target_id), entry.payload_hash]);
        if (updated.rowCount !== 1) throw new SyncError('CORPORATE_RECEIPT_FENCE_LOST');
      }
      await local.query(`UPDATE olos_http.corporate_control SET confirmed_count=confirmed_count+$1,generation=generation+1,
        failure_count=0,next_attempt_at=NULL,last_code=NULL,updated_at=now() WHERE singleton`, [entries.length]);
      await hooks.beforeLocalCommit?.();
      await local.query('COMMIT');
      log('corporate_delivery_confirmed', { confirmed: entries.length });
    } catch (error) {
      await rollback(local);
      // A local/fencing failure cannot be hidden as a corporate outage: stop the owning consumer.
      if (!remoteFailure) this.localFailure();
      throw error;
    } finally {
      if (remote) await remote.end().catch(() => {});
      local.removeListener('error', lostLocalSession);
      local.release(true);
    }
  }
}
