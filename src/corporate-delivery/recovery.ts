import { createHash } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { connect, rollback } from '../corporate-sync/database.js';
import { SyncError, safeCode } from '../corporate-sync/errors.js';
import { columns, compare, identityColumns, mapRow, RowFieldError, type Row } from '../corporate-sync/mapping.js';
import { log } from '../errors.js';
import type { DeliveryConfig } from './config.js';
import { corporateSchema, deliveryPayload, matchCandidates } from './contract.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';
import { pendingAdmission } from './selection.js';
import { notQuarantined, quarantineMembers } from './quarantine.js';

interface PendingEntry {
  source_id: string; target_id: string; payload: Record<string, unknown>; payload_hash: string;
  source_hash: string; agent_id: string | null; record_target_id: string | null;
  target_table: string | null; record_hash: string | null; eligible: boolean;
}
export interface PendingIssue {
  target_id: string;
  remote_id?: string;
  related_target_id?: string;
  code: string;
  fields: string[];
}
export interface PendingVerification {
  pending: number; quarantined: number; eligible: number; existing: number;
  schema_hash: string; verification_digest: string; issues: PendingIssue[];
}
export interface RecoveryRequest {
  source: string; verification: string; requestId: string; evidence: string; action: 'release' | 'quarantine';
}
export function recoveryRequest(args: string[], env: NodeJS.ProcessEnv, source: string, quarantine = false): RecoveryRequest {
  if (quarantine ? env.OLOS_CORPORATE_QUARANTINE_CONFIRMATION !== 'AUTHORIZE_CORPORATE_COLLISION_QUARANTINE'
    : env.OLOS_CORPORATE_RECOVERY_CONFIRMATION !== 'AUTHORIZE_CORPORATE_COLLISION_RECOVERY') throw new SyncError('CORPORATE_RECOVERY_NOT_AUTHORIZED');
  if (args.length !== 8 || args[0] !== '--confirm-source' || args[2] !== '--verification' || args[4] !== '--request-id' || args[6] !== '--evidence') throw new SyncError('CORPORATE_RECOVERY_ARGUMENTS_REQUIRED');
  if (args[1] !== source) throw new SyncError('CORPORATE_RECOVERY_SOURCE_MISMATCH');
  if (!/^[0-9a-f]{64}$/.test(args[3]!) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(args[5]!) || !/^[A-Za-z0-9._:-]{1,100}$/.test(args[7]!)) throw new SyncError('CORPORATE_RECOVERY_ARGUMENTS_INVALID');
  return { source, action: quarantine ? 'quarantine' : 'release', verification: args[3]!, requestId: args[5]!, evidence: args[7]! };
}

async function state(local: PoolClient, cfg: DeliveryConfig, source: string, target: string, lock = false) {
  await assertLocalConsumersCompatible(local, source);
  const row = (await local.query(`SELECT * FROM olos_http.corporate_control WHERE singleton${lock ? ' FOR UPDATE' : ''}`)).rows[0];
  if (!row?.ready) throw new SyncError('CORPORATE_LEGACY_RECONCILIATION_REQUIRED');
  if (row.source_key !== source || row.target_table !== target || row.binding !== cfg.binding) throw new SyncError('CORPORATE_BINDING_CHANGED');
  return row;
}

// Both callers establish their own snapshots/locks. All pending rows are checked, including
// those not currently admitted by the automatic policy; absence remotely is a normal pending insert.
async function inspect(local: PoolClient, remote: Client, cfg: DeliveryConfig, source: string, target: string, control: Record<string, unknown>): Promise<PendingVerification> {
  const { shape, hash } = await corporateSchema(remote, cfg, false);
  if (hash !== control.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
  const quarantined = await quarantineMembers(local, cfg, source, target, shape);
  const proof = createHash('sha256').update(JSON.stringify(['corporate-pending-verification-v2', source, target, cfg.binding,
    control.generation, control.blocked, control.last_code, hash, quarantined]));
  const report: PendingVerification = { pending: quarantined.length, quarantined: quarantined.length, eligible: 0, existing: 0, schema_hash: hash, verification_digest: '', issues: [] };
  const identities = new Map<string, string>();
  const admission = pendingAdmission(4);
  let cursor: string | null = null;
  for (;;) {
    const batch: PendingEntry[] = (await local.query(`SELECT o.source_id,o.target_id::text,o.payload,o.payload_hash,o.source_hash,
      r.agent_id,r.target_id::text AS record_target_id,r.target_table,r.source_hash AS record_hash,
      (${admission.sql}) IS TRUE AS eligible
      FROM olos_http.corporate_outbox o LEFT JOIN olos_http.records r USING(source_key,source_id)
      WHERE o.source_key=$1 AND o.state='pending' AND ${notQuarantined} AND ($2::bigint IS NULL OR o.target_id>$2)
      ORDER BY o.target_id LIMIT $3`, [source, cursor, cfg.connection.batchSize, ...admission.parameters])).rows;
    if (!batch.length) break;
    const rows: Row[] = [];
    for (const entry of batch) {
      report.pending++; if (entry.eligible) report.eligible++;
      proof.update(JSON.stringify([entry.source_id, entry.agent_id, entry.target_id, entry.payload_hash, entry.source_hash, entry.record_target_id, entry.target_table, entry.record_hash, entry.eligible]));
      const fields = [];
      if (entry.target_id !== entry.record_target_id) fields.push('target_id');
      if (entry.target_table !== target) fields.push('target_table');
      if (entry.source_hash !== entry.record_hash) fields.push('source_hash');
      if (fields.length) report.issues.push({ target_id: entry.target_id, code: 'CORPORATE_RECORD_MAPPING_CHANGED', fields });
      try {
        const row = deliveryPayload(entry, shape, cfg);
        const identity = JSON.stringify(identityColumns.map(name => row[name]));
        const previous = identities.get(identity);
        if (previous) report.issues.push({ target_id: entry.target_id, related_target_id: previous, code: 'DUPLICATE_LOGICAL_IDENTITY', fields: [...identityColumns] });
        identities.set(identity, entry.target_id);
        rows.push(row);
      } catch (error) {
        report.issues.push({ target_id: entry.target_id, code: safeCode(error), fields: error instanceof RowFieldError ? [error.field]
          : ['payload_hash', ...(entry.payload?.internal_id_olos !== entry.target_id ? ['internal_id_olos'] : [])] });
      }
    }
    if (rows.length) {
      const expected = new Map(rows.map(row => [row.internal_id_olos, row]));
      const byIdentity = new Map(rows.map(row => [JSON.stringify(identityColumns.map(name => row[name])), row]));
      const candidates = await matchCandidates(remote, rows, shape, cfg);
      // Stable proof across PostgreSQL query plans.
      candidates.rows.sort((a, b) => BigInt(a.remote_id) < BigInt(b.remote_id) ? -1 : 1);
      for (const raw of candidates.rows) {
        proof.update(JSON.stringify([raw.remote_id, ...columns.map(name => raw[name])]));
        const wanted = expected.get(raw.internal_id_olos);
        if (!wanted) {
          const logical = byIdentity.get(JSON.stringify(identityColumns.map(name => raw[name])));
          // Only numeric database IDs and field names reach logs; never include values or payloads.
          report.issues.push({ target_id: logical!.internal_id_olos!, remote_id: raw.remote_id,
            code: 'LOGICAL_CALL_AT_DIFFERENT_ID', fields: ['internal_id_olos'] });
          continue;
        }
        try {
          const normalized = mapRow(raw, shape, cfg.connection);
          compare(normalized, wanted);
          report.existing++;
        } catch (error) {
          report.issues.push({ target_id: wanted.internal_id_olos!, remote_id: raw.remote_id, code: safeCode(error),
            fields: error instanceof RowFieldError ? [error.field] : columns.filter(name => raw[name] !== wanted[name]) });
        }
      }
    }
    cursor = batch.at(-1)!.target_id;
  }
  report.verification_digest = proof.digest('hex');
  return report;
}

export function logVerification(report: PendingVerification): void {
  for (const issue of report.issues) log('corporate_pending_divergence', { target_id: issue.target_id, remote_id: issue.remote_id ?? null,
    related_target_id: issue.related_target_id ?? null, error: issue.code, fields: issue.fields.join(',') });
  log('corporate_pending_verified', { valid: report.issues.length === 0, pending: report.pending, quarantined: report.quarantined, eligible: report.eligible,
    existing: report.existing, divergences: report.issues.length, verification_digest: report.verification_digest });
}

export async function verifyPending(local: PoolClient, cfg: DeliveryConfig, source: string, target: string): Promise<PendingVerification> {
  let remote: Client | undefined;
  try {
    await local.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const control = await state(local, cfg, source, target);
    remote = await connect(cfg.connection, 'destination');
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await inspect(local, remote, cfg, source, target, control);
    await remote.query('COMMIT');
    await local.query('COMMIT');
    return report;
  } catch (error) { await rollback(local); if (remote) await rollback(remote); throw error; }
  finally { if (remote) await remote.end().catch(() => {}); }
}

export interface RecoveryHooks { afterLocks?: () => Promise<void>; beforeLocalCommit?: () => Promise<void> }
export async function recoverCollision(local: PoolClient, cfg: DeliveryConfig, source: string, target: string,
  request: RecoveryRequest, hooks: RecoveryHooks = {}, quarantine = false): Promise<{ alreadyApplied: boolean }> {
  if (request.source !== source) throw new SyncError('CORPORATE_RECOVERY_SOURCE_MISMATCH');
  if (request.action !== (quarantine ? 'quarantine' : 'release')) throw new SyncError('CORPORATE_RECOVERY_NOT_AUTHORIZED');
  let remote: Client | undefined;
  let commitIssued = false;
  try {
    await local.query('BEGIN');
    if (!(await local.query('SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_HOMOLOGATION_ACTIVE');
    const control = await state(local, cfg, source, target, true);
    // Excludes capture admission and edits to the frozen queue while retaining the OLOS owner.
    await local.query('LOCK TABLE olos_http.records,olos_http.corporate_outbox IN SHARE MODE');
    if (!(await local.query("SELECT to_regclass('olos_http.corporate_collision_recoveries') IS NOT NULL AS present")).rows[0].present) throw new SyncError('CORPORATE_RECOVERY_MIGRATION_REQUIRED');
    // Control row serializes administrative operations; table locks also stabilize membership evidence.
    await quarantineMembers(local, cfg, source, target, new Map(control.destination_shape));
    await local.query('LOCK TABLE olos_http.corporate_collision_quarantine_runs,olos_http.corporate_collision_quarantine IN SHARE MODE');
    const auditTable = quarantine ? 'olos_http.corporate_collision_quarantine_runs' : 'olos_http.corporate_collision_recoveries';
    const applied = (await local.query(`SELECT * FROM ${auditTable} WHERE request_id=$1`, [request.requestId])).rows[0];
    if (applied) {
      if (applied.source_key !== source || applied.target_table !== target || applied.binding !== cfg.binding || applied.verification_digest !== request.verification || applied.evidence_ref !== request.evidence) throw new SyncError('CORPORATE_RECOVERY_REQUEST_REUSED');
      await local.query('ROLLBACK');
      return { alreadyApplied: true };
    }
    if (!control.blocked || control.last_code !== 'INTERNAL_ID_COLLISION') throw new SyncError('CORPORATE_RECOVERY_BLOCK_MISMATCH');
    remote = await connect(cfg.connection, 'destination');
    // PostgreSQL disallows SHARE locks in READ ONLY transactions. This transaction performs
    // no DML/DDL and is always rolled back; SHARE excludes remote INSERT/UPDATE/DELETE/DDL.
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await remote.query('LOCK TABLE raw.olos_calls IN SHARE MODE');
    await hooks.afterLocks?.();
    const report = await inspect(local, remote, cfg, source, target, control);
    logVerification(report);
    if (!quarantine && report.issues.length) throw new SyncError('CORPORATE_PENDING_DIVERGES');
    if (report.verification_digest !== request.verification) throw new SyncError('CORPORATE_VERIFICATION_STALE');
    if (quarantine) {
      await isolateCollisions(local, cfg, source, target, request, control, report);
      const next = await state(local, cfg, source, target);
      // This second pass validates every remaining pending row. Any remaining issue keeps the block.
      logVerification(await inspect(local, remote, cfg, source, target, next));
    } else {
      await local.query(`INSERT INTO olos_http.corporate_collision_recoveries
        (request_id,source_key,target_table,binding,verification_digest,evidence_ref,previous_generation,previous_code,pending_count,eligible_count,existing_count,schema_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [request.requestId, source, target, cfg.binding, request.verification, request.evidence, control.generation, control.last_code,
        report.pending, report.eligible, report.existing, report.schema_hash]);
      await local.query(`UPDATE olos_http.corporate_control SET blocked=false,paused=true,last_code=NULL,failure_count=0,
        next_attempt_at=NULL,generation=generation+1,updated_at=now() WHERE singleton`);
    }
    await hooks.beforeLocalCommit?.();
    // Keep remote exclusion through local COMMIT. A later divergence still encounters the original delivery guards.
    await remote.query('SELECT 1');
    commitIssued = true;
    await local.query('COMMIT');
    return { alreadyApplied: false };
  } catch (error) {
    await rollback(local);
    if (commitIssued) throw new SyncError(quarantine ? 'CORPORATE_QUARANTINE_COMMIT_UNKNOWN' : 'CORPORATE_RECOVERY_COMMIT_UNKNOWN');
    throw error;
  } finally { if (remote) { await rollback(remote); await remote.end().catch(() => {}); } }
}


// Only rows whose complete diagnosis consists of confirmed INTERNAL_ID_COLLISION issues qualify.
// Hash, mapping, schema, normalization, logical-other-ID and content-only errors are never quarantined here.
async function isolateCollisions(local: PoolClient, cfg: DeliveryConfig, source: string, target: string,
  request: RecoveryRequest, control: Record<string, unknown>, report: PendingVerification) {
  const grouped = new Map<string, PendingIssue[]>();
  for (const issue of report.issues) grouped.set(issue.target_id, [...(grouped.get(issue.target_id) ?? []), issue]);
  const collisions = [...grouped].filter(([, issues]) => issues.every(issue => issue.code === 'INTERNAL_ID_COLLISION' && issue.remote_id
    && issue.fields.some(field => (identityColumns as readonly string[]).includes(field))));
  if (!collisions.length) throw new SyncError('CORPORATE_NO_CONFIRMED_COLLISIONS');
  await local.query(`INSERT INTO olos_http.corporate_collision_quarantine_runs
    (request_id,source_key,target_table,binding,verification_digest,evidence_ref,previous_generation,previous_code,pending_count,member_count,schema_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [request.requestId, source, target, cfg.binding, request.verification, request.evidence, control.generation, control.last_code,
    report.pending, collisions.length, report.schema_hash]);
  for (const [id, issues] of collisions) {
    const inserted = await local.query(`INSERT INTO olos_http.corporate_collision_quarantine
      (source_key,source_id,target_id,source_hash,payload_hash,request_id,code,remote_ids,fields)
      SELECT source_key,source_id,target_id,source_hash,payload_hash,$3,'INTERNAL_ID_COLLISION',$4,$5
      FROM olos_http.corporate_outbox o WHERE source_key=$1 AND target_id=$2 AND state='pending' AND ${notQuarantined}`,
    [source, id, request.requestId, [...new Set(issues.map(issue => issue.remote_id!))], [...new Set(issues.flatMap(issue => issue.fields))]]);
    if (inserted.rowCount !== 1) throw new SyncError('CORPORATE_QUARANTINE_CHANGED');
    log('corporate_collision_quarantine_member_prepared', { target_id: id, request_id: request.requestId });
  }
  await local.query('UPDATE olos_http.corporate_control SET generation=generation+1,updated_at=now() WHERE singleton');
}
