import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import type { MappedRecord } from '../mapping.js';
import { assertSchema } from '../schema.js';
import { log } from '../errors.js';
import { connect, rollback } from '../corporate-sync/database.js';
import { SyncError } from '../corporate-sync/errors.js';
import { digest, type Shape } from '../corporate-sync/mapping.js';
import { admissionHash, allocatorState, assertLegacyRemote } from './allocator.js';
import { verifyLegacySequence } from './legacy-sequence.js';
import { CorporateDelivery } from './delivery.js';
import { corporateSchema, deliveryPayload, freeze } from './contract.js';
import { quarantineMembers } from './quarantine.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';

export interface LegacyReversionRequest { source: string; adoptionId: string; requestId: string; evidence: string; maxBatches: number }
interface Admission { source_id: string; source_hash: string; request_id: string; mapped_hash: string; mapped: MappedRecord }
export interface ReversionHooks {
  afterLocks?: () => Promise<void>;
  beforeBatchCommit?: () => Promise<void>;
  afterBatchCommit?: () => Promise<void>;
  beforeCompleteCommit?: () => Promise<void>;
}
export function legacyReversionRequest(args: string[], env: NodeJS.ProcessEnv, source: string): LegacyReversionRequest {
  if (env.OLOS_CORPORATE_LEGACY_REVERSION_CONFIRMATION !== 'AUTHORIZE_CORPORATE_LEGACY_REVERSION') throw new SyncError('ALLOCATOR_REVERSION_NOT_AUTHORIZED');
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (![8,10].includes(args.length) || args[0] !== '--confirm-source' || args[2] !== '--adoption-request'
    || args[4] !== '--request-id' || args[6] !== '--evidence' || !uuid.test(args[3]!) || !uuid.test(args[5]!)
    || !/^[A-Za-z0-9._:-]{1,100}$/.test(args[7]!) || args.length === 10 && (args[8] !== '--max-batches' || !/^[1-9][0-9]{0,4}$/.test(args[9]!) || Number(args[9])>10000)) throw new SyncError('ALLOCATOR_REVERSION_ARGUMENTS_INVALID');
  if (args[1] !== source) throw new SyncError('ALLOCATOR_REVERSION_SOURCE_MISMATCH');
  return { source, adoptionId: args[3]!, requestId: args[5]!, evidence: args[7]!, maxBatches: args.length === 10 ? Number(args[9]) : 1000 };
}
function manifest(entries: Omit<Admission, 'mapped'>[]) {
  return entries.map(e => ({ source_id: e.source_id, source_hash: e.source_hash, request_id: e.request_id, mapped_hash: e.mapped_hash }));
}
function manifestDigest(entries: Omit<Admission, 'mapped'>[]): string {
  return createHash('sha256').update(JSON.stringify(entries.map(e => [e.source_id,e.source_hash,e.request_id,e.mapped_hash]))).digest('hex');
}
function validateAdmissions(entries: Admission[]) {
  for (const e of entries) if (e.mapped.source_id !== e.source_id || e.mapped.source_hash !== e.source_hash || admissionHash(e.mapped) !== e.mapped_hash) throw new SyncError('ALLOCATOR_ADMISSION_CHANGED');
}

// Read-only remote proof, with the original schema contract. Never installs or removes remote objects.
async function remoteLegacy(cfg: Config) {
  const remote = await connect(cfg.corporateDelivery!.connection, 'destination');
  try {
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertLegacyRemote(remote);
    const schema = await corporateSchema(remote, cfg.corporateDelivery!, false);
    await remote.query('COMMIT');
    return schema;
  } catch (error) { await rollback(remote); throw error; }
  finally { await remote.end().catch(() => {}); }
}
async function control(local: PoolClient, cfg: Config, target: string) {
  const row = (await local.query('SELECT * FROM olos_http.corporate_control WHERE singleton FOR UPDATE')).rows[0];
  if (!row?.ready || row.source_key !== cfg.sourceKey || row.target_table !== target || row.binding !== cfg.corporateDelivery!.binding) throw new SyncError('CORPORATE_BINDING_CHANGED');
  if (!row.paused) throw new SyncError('ALLOCATOR_REVERSION_REQUIRES_PAUSE');
  return row;
}
async function locks(local: PoolClient) {
  // Same admission -> materialization -> control order as adoption/delivery; no OLOS ownership lock.
  await local.query('SELECT pg_advisory_xact_lock(17320914,5)');
  await local.query('SELECT pg_advisory_xact_lock(17320914,6)');
  if (!(await local.query('SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_HOMOLOGATION_ACTIVE');
}
async function sequence(local: PoolClient, cfg: Config, target: string) {
  const info = await assertSchema(local, cfg.schema, cfg.table);
  const name = info.sequence!;
  await verifyLegacySequence(local,target,name,cfg.sourceKey);
  return name;
}

export async function revertAllocator(local: PoolClient, cfg: Config, delivery: CorporateDelivery,
  request: LegacyReversionRequest, hooks: ReversionHooks = {}): Promise<{ completed: boolean; alreadyApplied: boolean }> {
  if (request.source !== cfg.sourceKey) throw new SyncError('ALLOCATOR_REVERSION_SOURCE_MISMATCH');
  const dc = cfg.corporateDelivery!;
  const target = delivery.target;
  if (!(await local.query('SELECT pg_try_advisory_lock(17320914,7) AS ok')).rows[0].ok) throw new SyncError('ALLOCATOR_REVERSION_BUSY');
  let committing = false;
  try {
    if (!(await local.query("SELECT to_regclass('olos_http.corporate_id_reversions') IS NOT NULL AS present")).rows[0].present) throw new SyncError('ALLOCATOR_REVERSION_MIGRATION_REQUIRED');
    await local.query('BEGIN'); await locks(local);
    const previous = (await local.query('SELECT * FROM olos_http.corporate_id_reversions WHERE source_key=$1 OR request_id=$2 FOR UPDATE', [cfg.sourceKey,request.requestId])).rows;
    if (previous.length>1) throw new SyncError('ALLOCATOR_REVERSION_REQUEST_REUSED');
    const run = previous[0];
    if (run && (run.request_id !== request.requestId || run.source_key !== cfg.sourceKey || run.target_table !== target
      || run.binding !== dc.binding || run.adoption_request_id !== request.adoptionId || run.evidence_ref !== request.evidence)) throw new SyncError('ALLOCATOR_REVERSION_REQUEST_REUSED');
    if (run && manifestDigest(run.initial_manifest) !== run.initial_digest) throw new SyncError('ALLOCATOR_REVERSION_EVIDENCE_CHANGED');
    if (run?.state === 'completed') {
      const allocator = await allocatorState(local,dc,cfg.sourceKey,target);
      if (allocator?.state !== 'legacy' || allocator.reversion_request_id !== request.requestId) throw new SyncError('ALLOCATOR_REVERSION_EVIDENCE_CHANGED');
      await local.query('ROLLBACK'); return { completed: true, alreadyApplied: true };
    }
    const state = await control(local,cfg,target);
    if (!run && (!state.id_allocator_required || !state.blocked || state.last_code !== 'INTERNAL_ID_COLLISION')) throw new SyncError('ALLOCATOR_REVERSION_STATE_INVALID');
    await assertLocalConsumersCompatible(local,cfg.sourceKey);
    const allocator = await allocatorState(local,dc,cfg.sourceKey,target);
    if (!allocator || allocator.request_id !== request.adoptionId || allocator.state !== (run ? 'reverting' : 'adopting')
      || allocator.contract_hash !== null || allocator.adopted_at !== null) throw new SyncError('ALLOCATOR_REVERSION_STATE_INVALID');
    if ((await local.query('SELECT 1 FROM olos_http.corporate_id_assignments WHERE source_key=$1 LIMIT 1', [cfg.sourceKey])).rowCount) throw new SyncError('ALLOCATOR_REVERSION_ASSIGNMENTS_EXIST');
    const schema = await remoteLegacy(cfg);
    if (schema.hash !== state.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
    await quarantineMembers(local,dc,cfg.sourceKey,target,schema.shape);
    const seq = await sequence(local,cfg,target);
    if (run && run.sequence_name !== seq) throw new SyncError('ALLOCATOR_LEGACY_SEQUENCE_UNSAFE');
    if (!run) {
      const entries: Admission[] = (await local.query(`SELECT source_id,source_hash,request_id,mapped,mapped_hash
        FROM olos_http.corporate_id_admissions WHERE source_key=$1 ORDER BY source_id FOR UPDATE`, [cfg.sourceKey])).rows;
      if ((await local.query('SELECT 1 FROM olos_http.corporate_id_admissions WHERE source_key=$1 AND materialized LIMIT 1', [cfg.sourceKey])).rowCount) throw new SyncError('ALLOCATOR_REVERSION_ALREADY_MATERIALIZED');
      validateAdmissions(entries);
      const initial = manifest(entries);
      await local.query(`INSERT INTO olos_http.corporate_id_reversions
        (request_id,source_key,target_table,binding,adoption_request_id,sequence_name,evidence_ref,state,initial_manifest,initial_digest,initial_count,
          previous_generation,previous_code,previous_blocked,previous_confirmed_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,'materializing',$8,$9,$10,$11,$12,$13,$14)`,
      [request.requestId,cfg.sourceKey,target,dc.binding,request.adoptionId,seq,request.evidence,JSON.stringify(initial),manifestDigest(initial),entries.length,
        state.generation,state.last_code,state.blocked,state.confirmed_count]);
      await local.query("UPDATE olos_http.corporate_id_allocator SET state='reverting' WHERE source_key=$1 AND state='adopting'", [cfg.sourceKey]);
      await local.query('UPDATE olos_http.corporate_control SET id_allocator_required=false,paused=true,generation=generation+1,updated_at=now() WHERE singleton');
    }
    committing = true; await local.query('COMMIT'); committing = false;
    for (let n=0; n<request.maxBatches; n++) {
      await local.query('BEGIN'); await locks(local);
      const current = await control(local,cfg,target);
      const allocation = await allocatorState(local,dc,cfg.sourceKey,target);
      if (allocation?.state !== 'reverting' || allocation.reversion_request_id !== request.requestId) throw new SyncError('ALLOCATOR_REVERSION_STATE_INVALID');
      const progress = (await local.query('SELECT * FROM olos_http.corporate_id_reversions WHERE request_id=$1 FOR UPDATE', [request.requestId])).rows[0];
      if (progress.state !== 'materializing' || manifestDigest(progress.initial_manifest) !== progress.initial_digest) throw new SyncError('ALLOCATOR_REVERSION_EVIDENCE_CHANGED');
      if (current.confirmed_count !== progress.previous_confirmed_count) throw new SyncError('ALLOCATOR_REVERSION_HISTORY_CHANGED');
      const batch: Admission[] = (await local.query(`SELECT source_id,source_hash,request_id,mapped,mapped_hash FROM olos_http.corporate_id_admissions
        WHERE source_key=$1 AND NOT materialized ORDER BY source_id LIMIT $2 FOR UPDATE`, [cfg.sourceKey,dc.connection.batchSize])).rows;
      await hooks.afterLocks?.();
      if (!batch.length) {
        const remote = await remoteLegacy(cfg);
        if (remote.hash !== current.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
        await quarantineMembers(local,dc,cfg.sourceKey,target,remote.shape);
        const missing = await local.query(`SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(source_id text,source_hash text,request_id uuid,mapped_hash text)
          LEFT JOIN olos_http.corporate_id_admissions a ON a.source_key=$1 AND a.source_id=x.source_id
          LEFT JOIN olos_http.records r ON r.source_key=a.source_key AND r.source_id=a.source_id
          LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id
          WHERE a.materialized IS DISTINCT FROM true OR a.source_hash IS DISTINCT FROM x.source_hash OR a.mapped_hash IS DISTINCT FROM x.mapped_hash
            OR a.request_id IS DISTINCT FROM x.request_id OR r.source_hash IS DISTINCT FROM x.source_hash
            OR o.source_hash IS DISTINCT FROM x.source_hash OR o.target_id IS DISTINCT FROM r.target_id LIMIT 1`, [cfg.sourceKey,JSON.stringify(progress.initial_manifest)]);
        if (missing.rowCount) throw new SyncError('ALLOCATOR_REVERSION_INCOMPLETE');
        await local.query("UPDATE olos_http.corporate_id_allocator SET state='legacy' WHERE source_key=$1 AND state='reverting'", [cfg.sourceKey]);
        await local.query("UPDATE olos_http.corporate_id_reversions SET state='completed',completed_at=clock_timestamp() WHERE request_id=$1", [request.requestId]);
        await local.query('UPDATE olos_http.corporate_control SET paused=true,generation=generation+1,updated_at=now() WHERE singleton');
        await hooks.beforeCompleteCommit?.();
        committing = true; await local.query('COMMIT'); committing = false;
        return { completed: true, alreadyApplied: false };
      }
      validateAdmissions(batch);
      if (await sequence(local,cfg,target) !== seq) throw new SyncError('ALLOCATOR_LEGACY_SEQUENCE_UNSAFE');
      await delivery.enqueue(local,seq,batch.map(e=>e.mapped),undefined,request.requestId);
      const shape = new Map(current.destination_shape) as Shape;
      const rows = (await local.query(`SELECT r.source_id,r.target_id::text,r.target_table,r.source_hash,
        o.source_hash AS outbox_hash,o.payload,o.payload_hash,o.state
        FROM olos_http.records r JOIN olos_http.corporate_outbox o USING(source_key,source_id)
        WHERE r.source_key=$1 AND r.source_id=ANY($2::text[])`, [cfg.sourceKey,batch.map(e=>e.source_id)])).rows;
      const bySource = new Map(rows.map(row=>[row.source_id,row]));
      for (const entry of batch) {
        const row=bySource.get(entry.source_id);
        if (!row || row.target_table !== target || row.source_hash !== entry.source_hash || row.outbox_hash !== entry.source_hash) throw new SyncError('ALLOCATOR_REVERSION_MAPPING_CHANGED');
        deliveryPayload(row,shape,dc);
      }
      const expected = await freeze(local,batch.map(entry=>({...entry.mapped,internal_id_olos:bySource.get(entry.source_id)!.target_id})),shape,dc);
      const hashes = new Map(expected.map(row=>[row.internal_id_olos,digest(row)]));
      const members = batch.map(entry=>{
        const row=bySource.get(entry.source_id)!;
        if(hashes.get(row.target_id)!==row.payload_hash) throw new SyncError('ALLOCATOR_REVERSION_MAPPING_CHANGED');
        return {...manifest([entry])[0],target_id:row.target_id,payload_hash:row.payload_hash};
      });
      const updated = await local.query(`UPDATE olos_http.corporate_id_admissions SET materialized=true
        WHERE source_key=$1 AND source_id=ANY($2::text[]) AND NOT materialized`, [cfg.sourceKey,batch.map(e=>e.source_id)]);
      if (updated.rowCount!==batch.length) throw new SyncError('ALLOCATOR_REVERSION_MAPPING_CHANGED');
      await local.query(`INSERT INTO olos_http.corporate_id_reversion_batches(request_id,batch_no,members,member_count)
        VALUES($1,$2,$3,$4)`, [request.requestId,progress.batch_count+1,JSON.stringify(members),batch.length]);
      await local.query(`UPDATE olos_http.corporate_id_reversions SET materialized_count=materialized_count+$2,batch_count=batch_count+1 WHERE request_id=$1`, [request.requestId,batch.length]);
      await hooks.beforeBatchCommit?.();
      committing = true; await local.query('COMMIT'); committing = false;
      log('corporate_legacy_reversion_batch', { request_id:request.requestId,materialized:batch.length,batch:progress.batch_count+1 });
      await hooks.afterBatchCommit?.();
    }
    return { completed: false, alreadyApplied: false };
  } catch (error) {
    await rollback(local);
    if (committing) throw new SyncError('ALLOCATOR_REVERSION_COMMIT_UNKNOWN');
    throw error;
  } finally { await local.query('SELECT pg_advisory_unlock(17320914,7)').catch(()=>{}); }
}
