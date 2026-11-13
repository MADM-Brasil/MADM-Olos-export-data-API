import type { Client, PoolClient } from 'pg';
import { SyncError, safeCode } from '../corporate-sync/errors.js';
import { connect, rollback } from '../corporate-sync/database.js';
import { digest, type Shape } from '../corporate-sync/mapping.js';
import { log } from '../errors.js';
import type { DeliveryConfig } from './config.js';
import { reserveIds, allocatorError } from './allocator.js';
import { allocatorContract } from './allocator-contract.js';
import { corporateSchema, deliveryPayload, matches } from './contract.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';
import { assertReadoptionSchema, predecessorProof, readoptionDigest, readoptionQuarantine } from './readoption-proof.js';
import { isReadoptionState } from './readoption-contract.js';
import {assertAllocationSchema} from './allocation-policy.js';
import type { ReadoptionRequest, ReadoptionActivation, ReadoptionHooks, ReadoptionProgress, ReadoptionResult } from './readoption-contract.js';

interface Control {ready:boolean;paused:boolean;id_allocator_required:boolean;id_allocator_generation:string|null;source_key:string;target_table:string;binding:string;schema_hash:string;destination_shape:ShapeEntries}
type ShapeEntries=Array<[string,NonNullable<ReturnType<Shape['get']>>]>;
interface HistoricalEntry {
 source_id:string;source_hash:string;id:string;target_id:string;payload:Record<string,unknown>;payload_hash:string;
 outbox_hash:string;state:string;remote_raw_id:string|null;confirmed_at:Date|null;
}
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function requestValid(request:ReadoptionRequest,source:string) {
 if(request.source!==source||!uuid.test(request.requestId)||!/^[A-Za-z0-9._:-]{1,100}$/.test(request.evidence))throw new SyncError('READOPTION_REQUEST_INVALID');
}
async function begin(db:PoolClient) {
 await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s'");await db.query("SET LOCAL statement_timeout='30s'");
}
async function intentLocks(db:PoolClient) {
 if(!(await db.query('SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok')).rows[0].ok)throw new SyncError('READOPTION_HOMOLOGATION_ACTIVE');
 await db.query('SELECT pg_advisory_xact_lock(17320914,5)');
}
async function load(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionRequest,lock=false):Promise<ReadoptionProgress> {
 const run=(await db.query<ReadoptionProgress>(`SELECT * FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1${lock?' FOR NO KEY UPDATE':''}`,[request.requestId])).rows[0];
 if(run&&!isReadoptionState(run.state))throw new SyncError('READOPTION_TRANSITION_INVALID');
 if(!run||run.source_key!==request.source||run.binding!==cfg.binding||run.target_table!==target||run.evidence_ref!==request.evidence)throw new SyncError('READOPTION_REQUEST_CONFLICT');
 return run;
}
async function control(db:PoolClient,cfg:DeliveryConfig,target:string,run:ReadoptionProgress,update=false):Promise<Control> {
 const c=(await db.query<Control>(`SELECT * FROM olos_http.corporate_control WHERE singleton${update?' FOR UPDATE':''}`)).rows[0];
 if(!c?.ready||c.binding!==cfg.binding||c.source_key!==run.source_key||c.target_table!==target||(run.state!=='active'&&!c.paused))throw new SyncError('READOPTION_CONTROL_INVALID');
 const fenced=run.state==='activating'||run.state==='active';
 const allocator=(await db.query<{state:string;request_id:string;contract_hash:string|null;adopted_at:Date|null}>('SELECT state,request_id,contract_hash,adopted_at FROM olos_http.corporate_id_allocator WHERE source_key=$1',[run.source_key])).rows[0];
 if(!allocator||c.id_allocator_required!==fenced||(fenced?c.id_allocator_generation!==run.request_id:c.id_allocator_generation!==null)
   ||allocator.state!==(run.state==='active'?'active':fenced?'adopting':'legacy')||
   (run.previous_adoption_id!==null&&allocator.request_id!==run.previous_adoption_id))throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
 if(run.state==='activating'&&(allocator.contract_hash!==null||allocator.adopted_at!==null))throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
 if(!fenced&&(allocator.contract_hash!==null||allocator.adopted_at!==null))throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
 if(run.state==='active'&&(allocator.contract_hash!==run.remote_contract_hash||allocator.adopted_at?.getTime()!==run.activated_at?.getTime()))throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
 return c;
}
async function remoteAuthority(cfg:DeliveryConfig) {
 const db=await connect(cfg.connection,'destination');
 try{
  await db.query('BEGIN READ ONLY');
  if(!(await db.query("SELECT to_regnamespace('olos_delivery_ids') IS NOT NULL AS present")).rows[0].present)throw new SyncError('READOPTION_REMOTE_AUTHORITY_ABSENT');
  const contract=await allocatorContract(db),schema=await corporateSchema(db,cfg,true);
  if(!(await db.query(`SELECT has_function_privilege(current_user,'olos_delivery_ids.reserve(text,jsonb,boolean)','EXECUTE')
    AND has_function_privilege(current_user,'olos_delivery_ids.assert_unambiguous(jsonb)','EXECUTE') AS ok`)).rows[0].ok)throw new SyncError('READOPTION_REMOTE_AUTHORITY_UNAUTHORIZED');
  await db.query('COMMIT');return {contract,...schema};
 }finally{await rollback(db);await db.end().catch(()=>{});}
}
function result(run:ReadoptionProgress,alreadyApplied=false):ReadoptionResult {
 return {requestId:run.request_id,state:run.state,completed:run.state==='active',alreadyApplied,registered:run.registered_count,batches:run.batch_count};
}
function validationDigest(run:ReadoptionProgress,predecessor:string,quarantine:unknown,contract:string,schema:string) {
 return readoptionDigest(['corporate-readoption-v1',run.request_id,run.source_key,run.target_table,run.binding,run.previous_reversion_id,run.evidence_ref,predecessor,quarantine,contract,schema]);
}
function preactivationProgress(run:ReadoptionProgress) {
 if(run.registered_count!=='0'||run.batch_count!==0||run.registration_cursor!==null||run.registration_end!==null||run.registration_digest!==null||run.barrier_at!==null||run.activated_at!==null)throw new SyncError('READOPTION_REGISTRATION_CHANGED');
}
function validSeal(run:ReadoptionProgress) {
 if(run.state==='ready')preactivationProgress(run);
 if(!run.predecessor_digest||!run.remote_contract_hash||!run.remote_schema_hash||run.quarantine_manifest===null||
  validationDigest(run,run.predecessor_digest,run.quarantine_manifest,run.remote_contract_hash,run.remote_schema_hash)!==run.validation_digest)throw new SyncError('READOPTION_VALIDATION_CHANGED');
}
async function owned<T>(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionRequest,fn:()=>Promise<T>):Promise<T> {
 requestValid(request,request.source);await assertReadoptionSchema(db);await assertAllocationSchema(db);
 if(!(await db.query('SELECT pg_try_advisory_lock(17320914,8) AS ok')).rows[0].ok)throw new SyncError('READOPTION_BUSY');
 try{return await fn();}
 catch(error){
  await rollback(db);const code=safeCode(allocatorError(error));
  // Never rewrite state after an uncertain COMMIT. Read the operation by UUID.
  if(!code.includes('COMMIT_UNKNOWN'))await db.query(`UPDATE olos_http.corporate_allocator_readoptions SET last_error=$2,last_attempt_at=clock_timestamp()
    WHERE request_id=$1 AND source_key=$3 AND binding=$4 AND target_table=$5 AND state NOT IN ('active','aborted')`,[request.requestId,code,request.source,cfg.binding,target]).catch(()=>{});
  if(code==='INTERNAL_ID_COLLISION')await db.query(`UPDATE olos_http.corporate_control SET blocked=true,paused=true,last_code='INTERNAL_ID_COLLISION',updated_at=clock_timestamp()
    WHERE singleton AND id_allocator_generation=$1`,[request.requestId]).catch(()=>{});
  log('corporate_readoption_blocked',{request_id:request.requestId,error:code});throw error;
 }finally{await db.query('SELECT pg_advisory_unlock(17320914,8)').catch(()=>{});}
}
async function commit(db:PoolClient) {
 try{await db.query('COMMIT');}catch{throw new SyncError('READOPTION_COMMIT_UNKNOWN');}
}
export async function validateReadoption(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionRequest,hooks:ReadoptionHooks={}):Promise<ReadoptionResult> {
 return owned(db,cfg,target,request,async()=>{
  await begin(db);await intentLocks(db);
  let run=await load(db,cfg,target,request,true);
  if(['ready','activating','active'].includes(run.state)){validSeal(run);await control(db,cfg,target,run);await db.query('ROLLBACK');log('corporate_readoption_idempotent',{request_id:run.request_id});return result(run,true);}
  if(!['prepared','validating'].includes(run.state))throw new SyncError('READOPTION_TRANSITION_INVALID');
  preactivationProgress(run);
  await control(db,cfg,target,run,true);await assertLocalConsumersCompatible(db,request.source);
  await db.query("UPDATE olos_http.corporate_allocator_readoptions SET state='validating',last_error=NULL,last_attempt_at=clock_timestamp() WHERE request_id=$1",[request.requestId]);
  await commit(db);log('corporate_readoption_validation_started',{request_id:request.requestId});await hooks.afterValidationIntent?.();
  const authority=await remoteAuthority(cfg);
  await begin(db);await intentLocks(db);run=await load(db,cfg,target,request,true);
  const c=await control(db,cfg,target,run,true);
  if(authority.hash!==c.schema_hash)throw new SyncError('CORPORATE_SCHEMA_CHANGED');
  const predecessor=await predecessorProof(db,cfg,run,true),quarantine=await readoptionQuarantine(db,cfg,run,authority.shape);
  const seal=validationDigest(run,predecessor.digest,quarantine,authority.contract,authority.hash);
  await db.query(`UPDATE olos_http.corporate_allocator_readoptions SET state='ready',previous_adoption_id=$2,
    predecessor_digest=$3,predecessor_snapshot=$4,quarantine_manifest=$5,remote_contract_hash=$6,remote_schema_hash=$7,
    validated_at=clock_timestamp(),validation_digest=$8,last_error=NULL WHERE request_id=$1`,
    [request.requestId,predecessor.adoptionId,predecessor.digest,JSON.stringify(predecessor.snapshot),JSON.stringify(quarantine),authority.contract,authority.hash,seal]);
  await hooks.beforeValidationCommit?.();await commit(db);
  log('corporate_readoption_validation_completed',{request_id:request.requestId,validation_digest:seal});
  return result(await load(db,cfg,target,request));
 });
}
async function establishBarrier(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionActivation,hooks:ReadoptionHooks) {
 const authority=await remoteAuthority(cfg);
 await begin(db);await intentLocks(db);
 const run=await load(db,cfg,target,request,true);validSeal(run);
 if(run.state!=='ready')throw new SyncError('READOPTION_TRANSITION_INVALID');
 await assertLocalConsumersCompatible(db,request.source);
 const c=await control(db,cfg,target,run,true),predecessor=await predecessorProof(db,cfg,run,true);
 if(predecessor.digest!==run.predecessor_digest)throw new SyncError('READOPTION_PREDECESSOR_CHANGED');
 if(authority.contract!==run.remote_contract_hash||authority.hash!==run.remote_schema_hash||c.schema_hash!==authority.hash)throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
 const quarantine=await readoptionQuarantine(db,cfg,run,authority.shape);
 if(readoptionDigest(quarantine)!==readoptionDigest(run.quarantine_manifest))throw new SyncError('CORPORATE_QUARANTINE_CHANGED');
 // No COUNT/full manifest scan under the global fence. Existing indexed IDs
 // become immutable; all later captures go to admissions, never to nextval().
 const end=(await db.query<{id:string|null}>('SELECT target_id::text AS id FROM olos_http.records WHERE source_key=$1 AND target_table=$2 ORDER BY target_id DESC LIMIT 1',[request.source,target])).rows[0]?.id??null;
 await db.query("UPDATE olos_http.corporate_id_allocator SET state='adopting' WHERE source_key=$1 AND state='legacy'",[request.source]);
 await db.query(`UPDATE olos_http.corporate_allocator_readoptions SET state='activating',registration_end=$2,registration_digest=$3,
   barrier_at=clock_timestamp(),last_error=NULL WHERE request_id=$1`,[request.requestId,end,readoptionDigest(['corporate-readoption-registration-v1',request.requestId,run.validation_digest,end])]);
 await db.query('UPDATE olos_http.corporate_control SET id_allocator_required=true,id_allocator_generation=$1,paused=true,updated_at=clock_timestamp() WHERE singleton',[request.requestId]);
 await hooks.beforeBarrierCommit?.();await commit(db);
 log('corporate_readoption_barrier_activated',{request_id:request.requestId});await hooks.afterBarrierCommit?.();
}
async function registerBatch(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionActivation,hooks:ReadoptionHooks):Promise<boolean> {
 await begin(db);
 await db.query('SELECT pg_advisory_xact_lock_shared(17320914,5)');await db.query('SELECT pg_advisory_xact_lock(17320914,6)');
 if(!(await db.query('SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok')).rows[0].ok)throw new SyncError('READOPTION_HOMOLOGATION_ACTIVE');
 const run=await load(db,cfg,target,request,true);validSeal(run);
 const c=await control(db,cfg,target,run);await predecessorProof(db,cfg,run,false);
 if(run.state!=='activating')throw new SyncError('READOPTION_TRANSITION_INVALID');
 const quarantine=await readoptionQuarantine(db,cfg,run,new Map(c.destination_shape)),isolated=new Set(quarantine.map(m=>m.source_id));
 const batch=(await db.query<HistoricalEntry>(`SELECT r.source_id,r.source_hash,r.target_id::text AS id,o.target_id::text,o.payload,o.payload_hash,
   o.source_hash AS outbox_hash,o.state,o.remote_raw_id::text,o.confirmed_at FROM olos_http.records r
   LEFT JOIN olos_http.corporate_outbox o USING(source_key,source_id) WHERE r.source_key=$1 AND r.target_table=$2
    AND ($3::bigint IS NULL OR r.target_id>$3) AND r.target_id<=$4::bigint ORDER BY r.target_id LIMIT $5`,
  [request.source,target,run.registration_cursor,run.registration_end,cfg.connection.batchSize])).rows;
 if(!batch.length){await db.query('ROLLBACK');return false;}
 let remote:Client|undefined;
 try{
  remote=await connect(cfg.connection,'destination');await remote.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const contract=await allocatorContract(remote),schema=await corporateSchema(remote,cfg,false);
  if(contract!==run.remote_contract_hash||schema.hash!==run.remote_schema_hash||schema.hash!==c.schema_hash)throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  const rows=batch.map(row=>{
   if(row.target_id!==row.id||row.source_hash!==row.outbox_hash||!['confirmed','pending','skipped'].includes(row.state))throw new SyncError('ALLOCATOR_LEGACY_MAPPING_CHANGED');
   if(row.state==='confirmed'?row.remote_raw_id===null||row.confirmed_at===null:row.remote_raw_id!==null||row.confirmed_at!==null)throw new SyncError('CORPORATE_RECEIPT_CHANGED');
   return deliveryPayload(row,schema.shape,cfg);
  });
  const reserved=await reserveIds(remote,cfg,batch.map(r=>({source_key:request.source,source_id:r.source_id,source_hash:r.source_hash,id:r.id,payload:r.payload,isolated:isolated.has(r.source_id)})),true);
  const eligible=batch.filter(r=>!isolated.has(r.source_id)&&r.state!=='skipped');
  const byId=new Map(rows.map(row=>[row.internal_id_olos!,row]));
  const existing=await matches(remote,eligible.map(r=>byId.get(r.id)!),schema.shape,cfg);
  for(const row of eligible)if(row.state==='confirmed'&&existing.get(row.id)!==row.remote_raw_id)throw new SyncError('CORPORATE_RECEIPT_CHANGED');
  for(let i=0;i<batch.length;i++)if(batch[i]!.id!==reserved[i]!.id)throw new SyncError('ALLOCATOR_RESERVATION_INVALID');
  try{await remote.query('COMMIT');}catch{throw new SyncError('READOPTION_RESERVATION_COMMIT_UNKNOWN');}
  log('corporate_readoption_reservation_completed',{request_id:request.requestId,registered:batch.length});
  await hooks.afterReserveCommit?.();
  const members=batch.map((row,i)=>({state:row.state,quarantined:isolated.has(row.source_id),remote_raw_id:row.remote_raw_id,source_id:row.source_id,target_id:row.id,source_hash:row.source_hash,payload_hash:row.payload_hash,token_hash:readoptionDigest(reserved[i]!.token)}));
  const assigned=batch.map((row,i)=>({source_id:row.source_id,target_id:row.id,source_hash:row.source_hash,token:reserved[i]!.token}));
  await db.query(`INSERT INTO olos_http.corporate_id_assignments(source_key,source_id,target_id,source_hash,binding,token,legacy)
   SELECT $1,x.source_id,x.target_id,x.source_hash,$2,x.token,true FROM jsonb_to_recordset($3::jsonb)
    AS x(source_id text,target_id integer,source_hash text,token uuid)`,[request.source,cfg.binding,JSON.stringify(assigned)]);
  const chain=readoptionDigest([run.registration_digest,members]),qDigest=readoptionDigest(quarantine),end=batch.at(-1)!.id;
  await db.query(`INSERT INTO olos_http.corporate_readoption_batches(request_id,batch_no,first_id,last_id,member_count,members,chain_hash,quarantine_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[request.requestId,run.batch_count+1,batch[0]!.id,end,batch.length,JSON.stringify(members),chain,qDigest]);
  await db.query(`UPDATE olos_http.corporate_allocator_readoptions SET registration_cursor=$2,registration_digest=$3,
    registered_count=registered_count+$4,batch_count=batch_count+1,last_error=NULL,last_attempt_at=clock_timestamp() WHERE request_id=$1`,[request.requestId,end,chain,batch.length]);
  await hooks.beforeBatchCommit?.();await commit(db);
  log('corporate_readoption_batch_completed',{request_id:request.requestId,registered:batch.length,batch:run.batch_count+1});await hooks.afterBatchCommit?.();return true;
 }catch(error){if(remote)await rollback(remote);throw allocatorError(error);}
 finally{if(remote)await remote.end().catch(()=>{});}
}
async function finish(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionActivation,hooks:ReadoptionHooks) {
 const authority=await remoteAuthority(cfg);
 await begin(db);await intentLocks(db);await db.query('SELECT pg_advisory_xact_lock(17320914,6)');
 const run=await load(db,cfg,target,request,true);validSeal(run);await control(db,cfg,target,run,true);
 await predecessorProof(db,cfg,run,false);await readoptionQuarantine(db,cfg,run,authority.shape);
 if(authority.contract!==run.remote_contract_hash||authority.hash!==run.remote_schema_hash)throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
 if(run.registration_cursor!==run.registration_end)throw new SyncError('READOPTION_REGISTRATION_INCOMPLETE');
 const tail=(await db.query<{batch_no:number;chain_hash:string;last_id:string}>('SELECT batch_no,chain_hash,last_id::text FROM olos_http.corporate_readoption_batches WHERE request_id=$1 ORDER BY batch_no DESC LIMIT 1',[request.requestId])).rows[0];
 if(run.batch_count>0&&(!tail||tail.batch_no!==run.batch_count||tail.chain_hash!==run.registration_digest||tail.last_id!==run.registration_cursor))throw new SyncError('READOPTION_REGISTRATION_CHANGED');
 await db.query("UPDATE olos_http.corporate_allocator_readoptions SET state='active',activated_at=clock_timestamp(),last_error=NULL WHERE request_id=$1",[request.requestId]);
 await db.query(`UPDATE olos_http.corporate_id_allocator SET state='active',contract_hash=$2,
   adopted_at=(SELECT activated_at FROM olos_http.corporate_allocator_readoptions WHERE request_id=$3) WHERE source_key=$1 AND state='adopting'`,[request.source,run.remote_contract_hash,request.requestId]);
 await hooks.beforeActiveCommit?.();await commit(db);log('corporate_readoption_active',{request_id:request.requestId,registered:run.registered_count});
}
export async function activateReadoption(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionActivation,hooks:ReadoptionHooks={},recoverOnly=false):Promise<ReadoptionResult> {
 return owned(db,cfg,target,request,async()=>{
  if(!/^[0-9a-f]{64}$/.test(request.validation)||!Number.isInteger(request.maxBatches)||request.maxBatches<1||request.maxBatches>10000)throw new SyncError('READOPTION_REQUEST_INVALID');
  let run=await load(db,cfg,target,request);validSeal(run);
  if(request.validation!==run.validation_digest)throw new SyncError('READOPTION_VALIDATION_CHANGED');
  if(run.state==='active'){
   await begin(db);await control(db,cfg,target,run);await predecessorProof(db,cfg,run,false);await readoptionQuarantine(db,cfg,run,new Map((await db.query<Control>('SELECT * FROM olos_http.corporate_control WHERE singleton')).rows[0]!.destination_shape));
   await db.query('ROLLBACK');log('corporate_readoption_idempotent',{request_id:run.request_id});return result(run,true);
  }
  if(run.state==='ready'){
   if(recoverOnly)return result(run,true);
   await establishBarrier(db,cfg,target,request,hooks);
  }else if(run.state!=='activating')throw new SyncError('READOPTION_TRANSITION_INVALID');
  for(let i=0;i<request.maxBatches;i++)if(!await registerBatch(db,cfg,target,request,hooks)){await finish(db,cfg,target,request,hooks);return result(await load(db,cfg,target,request));}
  run=await load(db,cfg,target,request);
  if(run.registration_cursor===run.registration_end){await finish(db,cfg,target,request,hooks);return result(await load(db,cfg,target,request));}
  log('corporate_readoption_recovery_required',{request_id:run.request_id,registered:run.registered_count});return result(run);
 });
}
export async function abortReadoption(db:PoolClient,cfg:DeliveryConfig,target:string,request:ReadoptionRequest):Promise<ReadoptionResult> {
 return owned(db,cfg,target,request,async()=>{
  await begin(db);await intentLocks(db);const run=await load(db,cfg,target,request,true);
  if(run.state==='aborted'){await db.query('ROLLBACK');return result(run,true);}
  if(!['prepared','validating','ready'].includes(run.state))throw new SyncError('READOPTION_AUTHORITY_IRREVERSIBLE');
  await control(db,cfg,target,run,true);await db.query("UPDATE olos_http.corporate_allocator_readoptions SET state='aborted' WHERE request_id=$1",[request.requestId]);
  await commit(db);return result(await load(db,cfg,target,request));
 });
}
// Queries perform no state mutation or reservation, even when reconciling COMMIT loss.
interface BatchEvidence {batch_no:number;first_id:string;last_id:string;member_count:number;chain_hash:string;quarantine_digest:string;created_at:Date}
export async function readoptionStatus(db:PoolClient,cfg:DeliveryConfig,target:string,source:string,requestId:string,evidence=false) {
 if(!uuid.test(requestId)||!source)throw new SyncError('READOPTION_REQUEST_INVALID');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await assertReadoptionSchema(db);
  const run=(await db.query<ReadoptionProgress>('SELECT * FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1',[requestId])).rows[0];
  if(!run||run.source_key!==source||run.binding!==cfg.binding||run.target_table!==target)throw new SyncError('READOPTION_REQUEST_CONFLICT');
  const pointer=(await db.query<{id_allocator_generation:string|null;id_allocator_required:boolean;paused:boolean}>('SELECT id_allocator_generation,id_allocator_required,paused FROM olos_http.corporate_control WHERE singleton')).rows[0];
  if(!pointer)throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
  if(run.state==='active'){validSeal(run);await control(db,cfg,target,run);if(run.registration_cursor!==run.registration_end)throw new SyncError('READOPTION_REGISTRATION_CHANGED');}
  const batches=evidence?(await db.query<BatchEvidence>('SELECT batch_no,first_id::text,last_id::text,member_count,chain_hash,quarantine_digest,created_at FROM olos_http.corporate_readoption_batches WHERE request_id=$1 ORDER BY batch_no',[requestId])).rows:undefined;
  await db.query('COMMIT');
  return {...result(run),previous_adoption_id:run.previous_adoption_id,previous_reversion_id:run.previous_reversion_id,validation_digest:run.validation_digest,
   predecessor_digest:run.predecessor_digest,remote_contract_hash:run.remote_contract_hash,registration_digest:run.registration_digest,registration_cursor:run.registration_cursor,
   registration_end:run.registration_end,barrier_at:run.barrier_at,activated_at:run.activated_at,last_error:run.last_error,authority:pointer,...(evidence?{batch_evidence:batches}:{})};
 }catch(error){await rollback(db);throw error;}
}
