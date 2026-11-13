import { createHash } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import type { MappedRecord } from '../mapping.js';
import { SyncError } from '../corporate-sync/errors.js';
import { connect, rollback } from '../corporate-sync/database.js';
import { integerValue } from '../corporate-sync/mapping.js';
import type { DeliveryConfig } from './config.js';
import { corporateSchema, deliveryPayload, matches } from './contract.js';
import { allocatorContract } from './allocator-contract.js';
import {assertAllocationSchema} from './allocation-policy.js';
import {quarantineMembers} from './quarantine.js';

export interface IdAssignment { id: string; token: string | null }
export function admissionHash(mapped: MappedRecord): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(mapped).sort().map(key => [key, mapped[key as keyof MappedRecord]]))).digest('hex');
}
export interface AllocatorStatus {
 state:'adopting'|'active'|'reverting'|'legacy';request_id:string;binding:string;target_table:string;contract_hash:string|null;adopted_at:Date|null;
 reversion_request_id?:string;reversion_validated?:boolean;generation_request_id?:string;expected_contract_hash?:string;
}
export async function allocatorState(local: PoolClient, cfg: DeliveryConfig, source: string, target: string, fence = true) {
  if (fence) await local.query('SELECT pg_advisory_xact_lock_shared(17320914,5)');
  const authority=(await local.query<{required:boolean|null;generation:string|null}>("SELECT (to_jsonb(c)->>'id_allocator_required')::boolean AS required,to_jsonb(c)->>'id_allocator_generation' AS generation FROM olos_http.corporate_control c WHERE singleton")).rows[0];
  const required=authority?.required;
  if (!(await local.query("SELECT to_regclass('olos_http.corporate_id_allocator') IS NOT NULL AS present")).rows[0].present) {
    if (required) throw new SyncError('ALLOCATOR_LOCAL_STATE_MISSING');
    return undefined;
  }
  // The existing authority fence serializes admission with generation transitions.
  const state = (await local.query<AllocatorStatus>('SELECT * FROM olos_http.corporate_id_allocator WHERE source_key=$1', [source])).rows[0];
  if (required && !state) throw new SyncError('ALLOCATOR_LOCAL_STATE_MISSING');
  if (state && (state.binding !== cfg.binding || state.target_table !== target)) throw new SyncError('CORPORATE_BINDING_CHANGED');
  if(state&&['adopting','active'].includes(state.state)&&!required)throw new SyncError('ALLOCATOR_LOCAL_STATE_MISSING');
  if(authority?.generation){
    const generation=(await local.query<{request_id:string;state:string;binding:string;target_table:string;previous_adoption_id:string;remote_contract_hash:string;validation_digest:string|null}>(
      'SELECT request_id,state,binding,target_table,previous_adoption_id,remote_contract_hash,validation_digest FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1 AND source_key=$2',[authority.generation,source])).rows[0];
    if(!required||!state||!generation||!generation.validation_digest||generation.binding!==cfg.binding||generation.target_table!==target
      ||generation.previous_adoption_id!==state.request_id||!['activating','active'].includes(generation.state)
      ||(generation.state==='activating'&&(state.contract_hash!==null||state.adopted_at!==null))
      ||state.state!==(generation.state==='active'?'active':'adopting')||(generation.state==='active'&&state.contract_hash!==generation.remote_contract_hash))throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
    state.generation_request_id=generation.request_id;state.expected_contract_hash=generation.remote_contract_hash;
    return state;
  }
  if (state && ['reverting','legacy'].includes(state.state)) {
    const proof = (await local.query(`SELECT request_id,state,adoption_request_id,binding,target_table,validated_at
      FROM olos_http.corporate_id_reversions WHERE source_key=$1`, [source])).rows[0];
    if (required || state.contract_hash !== null || state.adopted_at !== null || !proof || proof.binding !== cfg.binding
      || proof.target_table !== target || proof.adoption_request_id !== state.request_id
      || proof.state !== (state.state === 'legacy' ? 'completed' : 'materializing')) throw new SyncError('ALLOCATOR_REVERSION_EVIDENCE_CHANGED');
    // New admissions may wait without IDs after a completed reversion. Its frozen
    // original membership is still checked by predecessorProof before re-adoption.
    state.reversion_request_id = proof.request_id;
    state.reversion_validated = proof.validated_at !== null;
  }
  return state;
}
// Historical read-only proof. Namespace absence does not authorize new legacy IDs.
// Uncertain or partially installed remote authority is never discarded automatically.
export async function assertLegacyRemote(remote: Client): Promise<void> {
  if ((await remote.query(`SELECT to_regnamespace('olos_delivery_ids') IS NOT NULL OR EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='raw.olos_calls'::regclass AND tgname='trg_olos_calls_reserve_internal_id'
  ) AS present`)).rows[0].present) throw new SyncError('ALLOCATOR_REVERSION_REMOTE_PRESENT');
}
export function allocatorError(error: unknown): unknown {
  const codes: Record<string, string> = { P3101: 'ALLOCATOR_INT32_EXHAUSTED', P3102: 'ALLOCATOR_REQUEST_CONFLICT',
    P3103: 'ALLOCATOR_ID_NOT_OWNED', P3104: 'ALLOCATOR_LEGACY_ID_RESERVED', P3105: 'ALLOCATOR_REGISTRY_DIVERGES', P3106: 'ALLOCATOR_REQUEST_INVALID', P3107:'LOGICAL_CALL_AT_DIFFERENT_ID', P3108:'ALLOCATOR_IDENTITY_IMMUTABLE', P3109:'INTERNAL_ID_COLLISION', P3110:'AMBIGUOUS_LOGICAL_IDENTITY' };
  const code = (error as { code?: string } | null)?.code;
  return code && codes[code] ? new SyncError(codes[code]) : error;
}
export async function reserveIds(remote: Client, cfg: DeliveryConfig, items: Record<string, unknown>[], legacy: boolean): Promise<IdAssignment[]> {
  try {
    const result = (await remote.query(`SELECT id::text,reservation_token::text AS token,reserved_source_id,reserved_source_hash
      FROM olos_delivery_ids.reserve($1,$2,$3)`, [cfg.binding, JSON.stringify(items), legacy])).rows;
    const bySource = new Map(result.map(row => [row.reserved_source_id, row]));
    if (result.length !== items.length || bySource.size !== items.length) throw new SyncError('ALLOCATOR_RESERVATION_INVALID');
    return items.map(item => {
      const row = bySource.get(item.source_id);
      if (!row || row.reserved_source_hash !== item.source_hash) throw new SyncError('ALLOCATOR_RESERVATION_INVALID');
      const id=integerValue(row.id,32),token:unknown=row.token;
      if((!legacy&&(BigInt(id)<1n||token===null))||(token!==null&&(typeof token!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(token))))throw new SyncError('ALLOCATOR_RESERVATION_INVALID');
      return {id,token:token as string|null};
    });
  } catch (error) { throw allocatorError(error); }
}

export interface AllocatorHooks { afterReserveCommit?: () => Promise<void>; beforeMaterializeCommit?: () => Promise<void> }
export interface AdoptionRequest { source: string; requestId: string; evidence: string }
export function adoptionRequest(args: string[], env: NodeJS.ProcessEnv, source: string): AdoptionRequest {
  if (env.OLOS_CORPORATE_ID_ALLOCATOR_CONFIRMATION !== 'AUTHORIZE_CORPORATE_ID_ALLOCATOR') throw new SyncError('ALLOCATOR_ADOPTION_NOT_AUTHORIZED');
  if (args.length !== 6 || args[0] !== '--confirm-source' || args[2] !== '--request-id' || args[4] !== '--evidence'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(args[3]!) || !/^[A-Za-z0-9._:-]{1,100}$/.test(args[5]!)) throw new SyncError('ALLOCATOR_ADOPTION_ARGUMENTS_INVALID');
  if (args[1] !== source) throw new SyncError('ALLOCATOR_ADOPTION_SOURCE_MISMATCH');
  return { source, requestId: args[3]!, evidence: args[5]! };
}

// Durable adoption intent is committed BEFORE any remote allocation. While adopting,
// capture writes only the local admission queue; a lost session cannot restart nextval().
export async function adoptAllocator(local: PoolClient, cfg: DeliveryConfig, source: string, target: string,
  request: AdoptionRequest, hooks: AllocatorHooks = {}, prepareOnly = false): Promise<void> {
  if (request.source !== source) throw new SyncError('ALLOCATOR_ADOPTION_SOURCE_MISMATCH');
  let remote: Client | undefined;
  let committing = false;
  try {
    if(!prepareOnly)await assertAllocationSchema(local);
    await local.query('BEGIN');
    await local.query('SELECT pg_advisory_xact_lock(17320914,5)');
    const control = (await local.query('SELECT * FROM olos_http.corporate_control WHERE singleton FOR UPDATE')).rows[0];
    if (!control?.ready || control.source_key !== source || control.target_table !== target || control.binding !== cfg.binding) throw new SyncError('CORPORATE_BINDING_CHANGED');
    const previous = (await local.query('SELECT * FROM olos_http.corporate_id_allocator WHERE source_key=$1', [source])).rows[0];
    if (control.id_allocator_generation) throw new SyncError('ALLOCATOR_ADOPTION_REVERTED');
    if (previous && (previous.request_id !== request.requestId || previous.evidence_ref !== request.evidence || previous.binding !== cfg.binding || previous.target_table !== target)) throw new SyncError('ALLOCATOR_ADOPTION_REQUEST_REUSED');
    if (previous && ['reverting','legacy'].includes(previous.state)) throw new SyncError('ALLOCATOR_ADOPTION_REVERTED');
    if (previous?.state === 'active') { await local.query('ROLLBACK'); return; }
    if (!control.paused) throw new SyncError('ALLOCATOR_ADOPTION_REQUIRES_PAUSE');
    if (!(await local.query('SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_HOMOLOGATION_ACTIVE');
    await local.query(`INSERT INTO olos_http.corporate_id_allocator(source_key,binding,target_table,request_id,evidence_ref,state)
      VALUES($1,$2,$3,$4,$5,'adopting') ON CONFLICT(source_key) DO NOTHING`, [source, cfg.binding, target, request.requestId, request.evidence]);
    await local.query('UPDATE olos_http.corporate_control SET id_allocator_required=true WHERE singleton');
    committing = true; await local.query('COMMIT'); committing = false;
    if (prepareOnly) return;
    await local.query('BEGIN');
    await local.query('SELECT pg_advisory_xact_lock(17320914,6)');
    const plan = (await local.query('SELECT * FROM olos_http.corporate_id_allocator WHERE source_key=$1 FOR NO KEY UPDATE', [source])).rows[0];
    if (plan.state === 'active') { await local.query('ROLLBACK'); return; }
    if (plan.state !== 'adopting') throw new SyncError('ALLOCATOR_ADOPTION_REVERTED');
    await local.query('LOCK TABLE olos_http.records,olos_http.corporate_outbox IN SHARE MODE');
    remote = await connect(cfg.connection, 'destination');
    await remote.query('BEGIN');
    const contract = await allocatorContract(remote);
    const schema = await corporateSchema(remote, cfg, false);
    if (schema.hash !== control.schema_hash) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
    const isolated=new Set((await quarantineMembers(local,cfg,source,target,schema.shape)).map(row=>row.source_id));
    let cursor: string | null = null;
    for (;;) {
      const rows: { source_id: string; source_hash: string; id: string; target_id: string; payload: Record<string, unknown>; payload_hash: string; outbox_hash: string;state:string;remote_raw_id:string|null }[] = (await local.query(`SELECT r.source_id,r.source_hash,r.target_id::text AS id,o.target_id::text,o.payload,o.payload_hash,o.source_hash AS outbox_hash,o.state,o.remote_raw_id::text
        FROM olos_http.records r LEFT JOIN olos_http.corporate_outbox o USING(source_key,source_id)
        WHERE r.source_key=$1 AND r.target_table=$2 AND ($3::bigint IS NULL OR r.target_id>$3)
        ORDER BY r.target_id LIMIT $4`, [source, target, cursor, cfg.connection.batchSize])).rows;
      if (!rows.length) break;
      for (const row of rows) {
        if (row.id !== row.target_id || row.source_hash !== row.outbox_hash) throw new SyncError('ALLOCATOR_LEGACY_MAPPING_CHANGED');
        deliveryPayload(row, schema.shape, cfg);
      }
      const eligible=rows.filter(row=>!isolated.has(row.source_id)&&row.state!=='skipped');
      const found=await matches(remote,eligible.map(row=>deliveryPayload(row,schema.shape,cfg)),schema.shape,cfg);
      for(const row of eligible)if(row.state==='confirmed'&&found.get(row.id)!==row.remote_raw_id)throw new SyncError('CORPORATE_RECEIPT_CHANGED');
      const reserved = await reserveIds(remote, cfg, rows.map(r => ({ source_key:source,source_id:r.source_id,source_hash:r.source_hash,id:r.id,payload:r.payload,isolated:isolated.has(r.source_id) })), true);
      const assignments = rows.map((row, i) => {
        const reservation = reserved[i]!;
        if (row.id !== reservation.id) throw new SyncError('ALLOCATOR_RESERVATION_INVALID');
        return { source_id: row.source_id, id: row.id, source_hash: row.source_hash, token: reservation.token };
      });
      await local.query(`INSERT INTO olos_http.corporate_id_assignments(source_key,source_id,target_id,source_hash,binding,token,legacy)
        SELECT $1,x.source_id,x.id,x.source_hash,$2,x.token,true
        FROM jsonb_to_recordset($3::jsonb) AS x(source_id text,id integer,source_hash text,token uuid)`,
      [source, cfg.binding, JSON.stringify(assignments)]);
      cursor = rows.at(-1)!.id;
    }
    await remote.query('COMMIT');
    await hooks.afterReserveCommit?.();
    await local.query(`UPDATE olos_http.corporate_id_allocator SET state='active',contract_hash=$2,adopted_at=clock_timestamp()
      WHERE source_key=$1 AND state='adopting'`, [source, contract]);
    await hooks.beforeMaterializeCommit?.();
    committing = true; await local.query('COMMIT'); committing = false;
  } catch (error) {
    await rollback(local); if (remote) await rollback(remote);
    if (committing) throw new SyncError('ALLOCATOR_ADOPTION_LOCAL_COMMIT_UNKNOWN');
    throw error;
  } finally { if (remote) await remote.end().catch(() => {}); }
}
