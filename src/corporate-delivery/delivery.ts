import type { Client, Pool, PoolClient } from 'pg';
import { connect, rollback } from '../corporate-sync/database.js';
import { retryable, safeCode, SyncError } from '../corporate-sync/errors.js';
import { integerValue, quote, type Shape } from '../corporate-sync/mapping.js';
import { deliveryColumns, deliveryDigest as digest, mapDeliveryRow as mapRow, hasOperator, operatorColumn } from './payload.js';
import { log } from '../errors.js';
import type { MappedRecord } from '../mapping.js';
import type { DeliveryConfig } from './config.js';
import { corporateSchema, freeze, matches, uniqueIdentities } from './contract.js';
import { reconcileLegacy } from './reconcile.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';
import { validateSelection, type DeliverySelection, type ReconciliationSelection } from './selection.js';

import { assertPreservedHistory } from './preserved-history.js';
import { assertEvidence, evidence, lockRemoteSelection, lockSelection, prepareCommit, resolveCommit,
  selectEntries, selectedRows, selectiveCommitBlock } from './selective-commit.js';

export interface DeliveryHooks {
  beforeRemoteCommit?: () => Promise<void>;
  afterRemoteCommit?: () => Promise<void>;
  beforeLocalCommit?: () => Promise<void>;
  afterSelectiveIntent?: () => Promise<void>;
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
  private async state(local: PoolClient, forUpdate = false, nowait = false) {
    const state = (await local.query(`SELECT *,next_attempt_at>clock_timestamp() AS retry_wait
      FROM olos_http.corporate_control WHERE singleton${forUpdate ? ` FOR UPDATE${nowait ? ' NOWAIT' : ''}` : ''}`)).rows[0];
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
      // A historical capture/recovery holds the exclusive session lock until Store.close().
      if (!(await local.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS ok',
        [`olos-http:history:${this.source}`])).rows[0].ok) throw new SyncError('HISTORY_CAPTURE_ACTIVE');
      if ((await local.query("SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND spec->>'kind'='history' AND state IN ('reading','received') LIMIT 1",
        [this.source])).rowCount) throw new SyncError('HISTORY_RECOVERY_REQUIRED');
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
    await this.attempt(hooks);
  }

  async deliverSelected(selection: DeliverySelection, hooks: DeliveryHooks = {}): Promise<void> {
    const ids = validateSelection(this.cfg, selection);
    if (!this.admitted || this.closing) throw new SyncError('CORPORATE_DELIVERY_NOT_ADMITTED');
    if (this.active) throw new SyncError('CORPORATE_DELIVERY_BUSY');
    this.active = this.attempt(hooks, ids, selection.historyReadId, selection.contract ?? 'v2');
    try { await this.active; }
    finally { this.active = undefined; }
  }

  async reconcileSelected(selection: ReconciliationSelection, hooks: DeliveryHooks = {}): Promise<void> {
    const ids = validateSelection(this.cfg, selection, 'reconciliation', selection.attemptId);
    if (!this.admitted || this.closing) throw new SyncError('CORPORATE_DELIVERY_NOT_ADMITTED');
    if (this.active) throw new SyncError('CORPORATE_DELIVERY_BUSY');
    this.active = this.reconcileSelectedAttempt(selection.attemptId, ids, hooks, selection.historyReadId, selection.contract ?? 'v2');
    try { await this.active; }
    finally { this.active = undefined; }
  }

  private async reconcileSelectedAttempt(attemptId: string, ids: string[], hooks: DeliveryHooks, historyReadId?: string, contract: 'v1' | 'v2' = 'v2'): Promise<void> {
    this.fence();
    const local = await this.pool.connect();
    const lostLocalSession = () => this.localFailure();
    local.on('error', lostLocalSession);
    let remote: Client | undefined;
    try {
      await local.query('BEGIN');
      await lockSelection(local, this.source, historyReadId, contract);
      await assertLocalConsumersCompatible(local, this.source);
      const state = await this.state(local, true, true);
      if (!state.paused) throw new SyncError('SELECTIVE_REQUIRES_PAUSED');
      if (!state.blocked || state.last_code !== selectiveCommitBlock) throw new SyncError('SELECTIVE_RECONCILIATION_NOT_PENDING');
      const attempt = (await local.query(`SELECT * FROM olos_http.corporate_selective_commits
        WHERE attempt_id=$1 AND state='unresolved' FOR UPDATE NOWAIT`, [attemptId])).rows[0];
      if (!attempt || attempt.source_key !== this.source || attempt.target_table !== this.target ||
        attempt.binding !== this.cfg.binding || attempt.schema_hash !== state.schema_hash) throw new SyncError('SELECTIVE_ATTEMPT_MISMATCH');
      const entries = await selectEntries(local, this.source, this.target, ids, historyReadId, contract);
      assertEvidence(entries, attempt.evidence);
      this.fence();
      remote = await connect(this.cfg.connection, 'destination');
      // READ COMMITTED takes the data snapshot AFTER the original transaction's
      // advisory lock is released; absence cannot be inferred from an old snapshot.
      await remote.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await lockRemoteSelection(remote);
      await remote.query('LOCK TABLE raw.olos_calls IN ACCESS SHARE MODE');
      const { shape, hash } = await corporateSchema(remote, this.cfg, false);
      if (hash !== state.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
      const rows = selectedRows(entries, shape, this.cfg);
      const found = await matches(remote, rows, shape, this.cfg);
      for (const entry of entries) {
        if (entry.state === 'confirmed' && found.get(entry.target_id) !== entry.remote_raw_id) {
          throw new SyncError('SELECTIVE_CONFIRMED_RECEIPT_DIVERGES');
        }
      }
      await hooks.beforeRemoteCommit?.();
      this.fence();
      await remote.query('COMMIT');
      await hooks.afterRemoteCommit?.();
      this.fence();
      let confirmed = 0;
      for (const entry of entries) {
        if (entry.state === 'confirmed' || !found.has(entry.target_id)) continue;
        const updated = await local.query(`UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=$3,confirmed_at=now()
          WHERE source_key=$1 AND source_id=$2 AND state='pending' AND payload_hash=$4`,
        [this.source, entry.source_id, found.get(entry.target_id), entry.payload_hash]);
        if (updated.rowCount !== 1) throw new SyncError('CORPORATE_RECEIPT_FENCE_LOST');
        confirmed++;
      }
      await resolveCommit(local, attemptId, 'reconciled', entries, found);
      await local.query(`UPDATE olos_http.corporate_control SET confirmed_count=confirmed_count+$1,generation=generation+1,
        paused=true,blocked=false,last_code=NULL,failure_count=0,next_attempt_at=NULL,updated_at=now() WHERE singleton`, [confirmed]);
      await hooks.beforeLocalCommit?.();
      await local.query('COMMIT');
      log('corporate_selected_commit_reconciled', { attempt_id: attemptId, confirmed,
        absent: entries.length - found.size, source_ids: ids.join(',') });
    } catch (error) {
      await rollback(local);
      throw error; // All failures preserve the previously committed block/evidence.
    } finally {
      if (remote) { await rollback(remote); await remote.end().catch(() => {}); }
      local.removeListener('error', lostLocalSession);
      local.release(true);
    }
  }

  // Both entry points share the remote transaction, contract and receipt protocol.
  private async attempt(hooks: DeliveryHooks, ids?: string[], historyReadId?: string, contract: 'v1' | 'v2' = 'v2'): Promise<void> {
    this.fence();
    const local = await this.pool.connect();
    const lostLocalSession = () => this.localFailure();
    local.on('error', lostLocalSession);
    let remote: Client | undefined;
    let remoteFailure = false;
    try {
      await local.query('BEGIN');
      // Source and Corporate Sync session locks remain owned by Store.
      if (ids) await lockSelection(local, this.source, historyReadId, contract);
      else if (!(await local.query('SELECT pg_try_advisory_xact_lock(17320914,4) AS ok')).rows[0].ok) {
        await local.query('ROLLBACK'); return;
      }
      await assertLocalConsumersCompatible(local, this.source);
      const state = await this.state(local, true, !!ids);
      if (ids && !state.paused) throw new SyncError('SELECTIVE_REQUIRES_PAUSED');
      if (ids && state.blocked) throw new SyncError('CORPORATE_DELIVERY_BLOCKED');
      if (ids && state.last_code === 'CORPORATE_COMMIT_UNKNOWN') throw new SyncError('SELECTIVE_UNTRACKED_COMMIT_UNKNOWN');
      if (!ids && (state.paused || state.blocked || state.retry_wait)) { await local.query('COMMIT'); return; }
      if (ids && (await local.query("SELECT 1 FROM olos_http.corporate_selective_commits WHERE state='unresolved'")).rowCount) {
        throw new SyncError(selectiveCommitBlock);
      }
      const entries = ids ? await selectEntries(local, this.source, this.target, ids, historyReadId, contract) : (await local.query(`SELECT source_id,target_id::text,payload,payload_hash FROM olos_http.corporate_outbox
        WHERE source_key=$1 AND state='pending' ORDER BY target_id LIMIT $2 FOR UPDATE`, [this.source, this.cfg.connection.batchSize])).rows;
      if (new Map(state.destination_shape).has(operatorColumn) && entries.some(entry =>
        entry.state !== 'confirmed' && !hasOperator(entry.payload))) throw new SyncError('OPERATOR_PAYLOAD_UPGRADE_REQUIRED');
      if (!entries.length) { await local.query('COMMIT'); return; }
      let found: Map<string, string>;
      let commitIssued = false;
      let commitAttempt: string | undefined;
      try {
        this.fence();
        remote = await connect(this.cfg.connection, 'destination');
        await remote.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        if (ids) await lockRemoteSelection(remote);
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
        // A previously confirmed receipt must still have its exact remote row.
        // Missing/changed remote evidence is a conflict, never permission to reinsert.
        for (const entry of entries) {
          if (entry.state === 'confirmed' && found.get(entry.target_id) !== entry.remote_raw_id) {
            throw new SyncError('SELECTIVE_CONFIRMED_RECEIPT_DIVERGES');
          }
        }
        for (const row of rows) {
          this.fence();
          // Exact existing rows are never INSERTed again; even their corporate trigger is not invoked.
          if (found.has(row.internal_id_olos!)) continue;
          const columns = deliveryColumns(row);
          await remote.query(`INSERT INTO raw.olos_calls (${columns.map(quote).join(',')})
            VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})
            ON CONFLICT (internal_id_olos) WHERE internal_id_olos IS NOT NULL DO NOTHING`, columns.map(name => (row as Record<string, string | null>)[name]));
        }
        found = await matches(remote, rows, shape, this.cfg);
        if (found.size !== rows.length) throw new SyncError('CORPORATE_VERIFICATION_FAILED');
        await hooks.beforeRemoteCommit?.();
        this.fence();
        if (ids) {
          commitAttempt = await prepareCommit(local, this.cfg, this.source, this.target, state.schema_hash, entries);
          await local.query('COMMIT');
          log('corporate_selected_commit_intent', { attempt_id: commitAttempt, source_ids: ids.join(',') });
          await hooks.afterSelectiveIntent?.();
          await local.query('BEGIN');
          const guarded = await this.state(local, true, true);
          if (!guarded.paused || !guarded.blocked || guarded.last_code !== selectiveCommitBlock) throw new SyncError('SELECTIVE_COMMIT_FENCE_LOST');
          if (historyReadId !== undefined) await assertPreservedHistory(local, this.source, historyReadId, contract);
          const refreshed = await selectEntries(local, this.source, this.target, ids, historyReadId, contract);
          assertEvidence(refreshed, evidence(entries));
          selectedRows(refreshed, shape, this.cfg);
          this.fence();
        }
        commitIssued = true;
        await remote.query('COMMIT');
        await hooks.afterRemoteCommit?.();
      } catch (error) {
        remoteFailure = true;
        if (remote) await rollback(remote);
        if (commitAttempt) {
          // The intent/block already committed independently. Never clear it on
          // uncertain remote COMMIT, local failure, restart or a delivery retry.
          await rollback(local);
          log('corporate_delivery_deferred', { error: 'CORPORATE_COMMIT_UNKNOWN', blocked: true,
            attempt_id: commitAttempt, source_ids: ids!.join(',') });
          throw new SyncError('CORPORATE_COMMIT_UNKNOWN');
        }
        const failures = state.failure_count + 1;
        // Network termination during COMMIT does not always carry a PostgreSQL/Node error code.
        const code = commitIssued ? 'CORPORATE_COMMIT_UNKNOWN' : safeCode(error);
        const terminal = !(commitIssued || retryable(error)) || failures >= this.cfg.connection.maxRetries;
        const delay = Math.min(60000, this.cfg.connection.backoffMs * 2 ** Math.min(failures - 1, 16));
        await local.query(`UPDATE olos_http.corporate_control SET failure_count=$1,blocked=$2,last_code=$3,
          next_attempt_at=now()+($4::integer*interval '1 millisecond'),updated_at=now() WHERE singleton`,
        [failures, terminal, code, delay]);
        await local.query('COMMIT');
        log('corporate_delivery_deferred', { error: code, retry_ms: delay, blocked: terminal,
          ...(ids ? { source_ids: ids.join(',') } : {}) });
        if (ids) throw new SyncError(code);
        return;
      }
      this.fence();
      const pending = entries.filter(entry => entry.state !== 'confirmed');
      for (const entry of pending) {
        const updated = await local.query(`UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=$3,confirmed_at=now()
          WHERE source_key=$1 AND source_id=$2 AND state='pending' AND payload_hash=$4`,
        [this.source, entry.source_id, found.get(entry.target_id), entry.payload_hash]);
        if (updated.rowCount !== 1) throw new SyncError('CORPORATE_RECEIPT_FENCE_LOST');
      }
      if (pending.length) await local.query(`UPDATE olos_http.corporate_control SET confirmed_count=confirmed_count+$1,generation=generation+1,
        failure_count=0,next_attempt_at=NULL,last_code=NULL,updated_at=now() WHERE singleton`, [pending.length]);
      if (commitAttempt) {
        await resolveCommit(local, commitAttempt, 'acknowledged', entries, found);
        await local.query(`UPDATE olos_http.corporate_control SET blocked=false,last_code=NULL,
          failure_count=0,next_attempt_at=NULL,updated_at=now() WHERE singleton`);
      }
      await hooks.beforeLocalCommit?.();
      await local.query('COMMIT');
      if (ids) log('corporate_selected_delivery_confirmed',
        { confirmed: pending.length, already_confirmed: entries.length - pending.length, source_ids: ids.join(',') });
      else log('corporate_delivery_confirmed', { confirmed: pending.length });
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
