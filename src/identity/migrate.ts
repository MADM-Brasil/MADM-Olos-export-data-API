import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { Store } from '../store.js';
import type { Config } from '../config.js';
import { originalInternalId } from '../mapping.js';
import { quote } from '../schema.js';
import { connect, rollback } from '../corporate-sync/database.js';
import { SyncError } from '../corporate-sync/errors.js';
import { columns, projection, mapRow } from '../corporate-sync/mapping.js';
import { corporateSchema, matches } from '../corporate-delivery/contract.js';
import { deliveryDigest } from '../corporate-delivery/payload.js';
import { lockRemoteSelection, selectedRows, type SelectedEntry } from '../corporate-delivery/selective-commit.js';
import { assertLocalConsumersCompatible } from '../corporate-delivery/local-consumers.js';
import { historyHomologation, preservedHistoryRead } from '../corporate-delivery/preserved-history.js';
import { drainHash } from '../corporate-delivery/drain-request.js';
import { dependencies, referenceRows } from './dependencies.js';
import { consent, validateRequest, type Request, type Kind } from './request.js';

export const identityBlock='IDENTITY_RECONCILIATION_REQUIRED';
interface Entry extends SelectedEntry {
 record_snapshot:string; outbox_snapshot:string; local_row:string|null; receipt:string|null;
 new_payload:Record<string,unknown>; new_hash:string; remote_row:string|null;
}
interface Manifest {
 version:1; kind:Kind; ids:string[]; source:string; target:string; binding:string; schema:string; review:string;
 history:unknown; local_dependencies:Awaited<ReturnType<typeof dependencies>>;
 remote_dependencies:Awaited<ReturnType<typeof dependencies>>;
 references:Awaited<ReturnType<typeof referenceRows>>; checkpoint:string; entries:Entry[];
}
interface Plan {id:string;manifest:Manifest;hash:string;state:string}
export interface IdentityHooks {afterIntent?:()=>Promise<void>;beforeRemoteCommit?:()=>Promise<void>;afterRemoteCommit?:()=>Promise<void>;beforeLocalCommit?:()=>Promise<void>;afterLocalCommit?:()=>Promise<void>}
function same(a:unknown,b:unknown,code='IDENTITY_EVIDENCE_CHANGED'){if(drainHash(a)!==drainHash(b))throw new SyncError(code);}
async function event(db:PoolClient,id:string,name:string){await db.query('INSERT INTO olos_http.identity_events(id,event) VALUES($1,$2)',[id,name]);}
async function locks(db:PoolClient,source:string){
 for(const n of [4])if(!(await db.query('SELECT pg_try_advisory_lock(17320914,$1) AS ok',[n])).rows[0].ok)throw new SyncError('CORPORATE_DELIVERY_BUSY');
 for(const key of [`olos-http:history:${source}`,`olos-admin:${source}`])if(!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0].ok)throw new SyncError('IDENTITY_CONSUMER_ACTIVE');
}
async function guard(db:PoolClient,cfg:Config,owns=false){
 await assertLocalConsumersCompatible(db,cfg.sourceKey);
 const s=(await db.query('SELECT * FROM olos_http.worker_settings WHERE source_key=$1 FOR SHARE NOWAIT',[cfg.sourceKey])).rows[0];
 if(!s||s.enabled||s.desired_state!=='STOPPED'||s.runtime_state!=='STOPPED')throw new SyncError('HISTORY_SCHEDULER_NOT_STOPPED');
 const reads=(await db.query("SELECT to_jsonb(h) AS h FROM olos_http.reads h WHERE source_key=$1 AND state IN ('reading','received') FOR SHARE NOWAIT",[cfg.sourceKey])).rows;
 const h=reads[0]?.h;
 if(reads.length!==1||h.id!==preservedHistoryRead||h.state!=='reading'||h.error_code!=='RESPONSE_TOO_LARGE'||h.spec.kind!=='history'||h.processed_count!==0||h.response_body!==null||h.finished_at!==null||h.resolution!==null||h.target_table!=='"raw"."olos_calls"')throw new SyncError('IDENTITY_HISTORY_CHANGED');
 const c=(await db.query('SELECT * FROM olos_http.corporate_control WHERE singleton FOR UPDATE NOWAIT')).rows[0];
 if(!c?.ready||!c.paused||c.binding!==cfg.corporateDelivery!.binding||c.source_key!==cfg.sourceKey||c.target_table!==h.target_table||new Map(c.destination_shape).has('id_operador_olos'))throw new SyncError('IDENTITY_CONTROL_INVALID');
 if(owns?(!c.blocked||c.last_code!==identityBlock):c.blocked||c.last_code==='CORPORATE_COMMIT_UNKNOWN')throw new SyncError('CORPORATE_DELIVERY_BLOCKED');
 if((await db.query("SELECT 1 FROM olos_http.corporate_selective_commits WHERE state='unresolved'")).rowCount)throw new SyncError('SELECTIVE_COMMIT_RECONCILIATION_REQUIRED');
 if((await db.query("SELECT 1 FROM olos_http.corporate_drain_runs WHERE state IN ('planned','running','failed')")).rowCount)throw new SyncError('DRAIN_OPEN_RUN_EXISTS');
 if((await db.query('SELECT 1 FROM corporate_sync.control WHERE pending IS NOT NULL')).rowCount)throw new SyncError('LEGACY_STATE_NOT_RECONCILED');
 await db.query('LOCK TABLE raw.olos_calls IN ACCESS EXCLUSIVE MODE NOWAIT');
 await db.query('LOCK TABLE olos_http.records,olos_http.corporate_outbox,corporate_sync.receipts,corporate_sync.control IN SHARE ROW EXCLUSIVE MODE NOWAIT');
 return {history:h,control:c};
}
async function remoteBegin(remote:Client,cfg:Config,schema:string){
 await remote.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await remote.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
 await lockRemoteSelection(remote);
 // Protect absent IDs and logical identities against noncooperating writers. No corporate DDL.
 await remote.query('LOCK TABLE raw.olos_calls IN SHARE ROW EXCLUSIVE MODE NOWAIT');
 const result=await corporateSchema(remote,cfg.corporateDelivery!,false);
 if(result.hash!==schema||result.shape.has('id_operador_olos'))throw new SyncError('CORPORATE_SCHEMA_CHANGED');
 return result.shape;
}
async function entries(db:PoolClient,cfg:Config,ids:string[],kind:Kind,shape:Awaited<ReturnType<typeof corporateSchema>>['shape']):Promise<Entry[]>{
 const result=(await db.query(`SELECT o.source_id,o.target_id::text,o.payload,o.payload_hash,o.state,o.remote_raw_id::text,o.source_hash,o.origin,
 r.source_hash AS record_hash,r.target_id::text AS record_target_id,r.target_table,r.agent_id,
 to_jsonb(r)::text AS record_snapshot,to_jsonb(o)::text AS outbox_snapshot,
 (SELECT to_jsonb(d)::text FROM raw.olos_calls d WHERE d.internal_id_olos=r.target_id) AS local_row,
 (SELECT to_jsonb(c)::text FROM corporate_sync.receipts c WHERE c.internal_id_olos=r.target_id) AS receipt,
 r.created_at<h.started_at AND o.created_at<h.started_at AS eligible
 FROM olos_http.records r JOIN olos_http.corporate_outbox o USING(source_key,source_id)
 JOIN olos_http.reads h ON h.id=$3 WHERE r.source_key=$1 AND r.source_id=ANY($2::text[])
 ORDER BY r.source_id FOR UPDATE OF r,o NOWAIT`,[cfg.sourceKey,ids,preservedHistoryRead])).rows;
 if(result.length!==ids.length)throw new SyncError('IDENTITY_SELECTION_MISSING');
 selectedRows(result,shape,cfg.corporateDelivery!);
 for(const e of result){
  originalInternalId(e.source_id,32);originalInternalId(e.target_id,32);
  if(!/^[a-f0-9]{64}$/.test(e.source_hash))throw new SyncError('IDENTITY_SOURCE_HASH_INVALID');
  if(!e.eligible||e.source_hash!==e.record_hash||e.target_id!==e.record_target_id||e.target_table!=='"raw"."olos_calls"'||!['capture','legacy_backlog','legacy_receipt'].includes(e.origin)||e.state!==kind||Object.keys(e.payload).length!==14||columns.some(c=>!Object.hasOwn(e.payload,c)))throw new SyncError('IDENTITY_RECEIPT_INVALID');
  if(kind==='pending'&&(e.receipt||e.remote_raw_id))throw new SyncError('IDENTITY_RECEIPT_EXISTS');
  if(e.receipt&&JSON.parse(e.receipt).payload_hash!==e.payload_hash)throw new SyncError('IDENTITY_RECEIPT_INVALID');
  if(e.source_id===e.target_id)throw new SyncError('IDENTITY_ALREADY_ORIGINAL');
  if((await db.query(`SELECT 1 FROM olos_http.records WHERE target_table=$1 AND target_id=$2
   UNION ALL SELECT 1 FROM olos_http.corporate_outbox WHERE target_id=$2
   UNION ALL SELECT 1 FROM raw.olos_calls WHERE internal_id_olos=$2
   UNION ALL SELECT 1 FROM corporate_sync.receipts WHERE internal_id_olos=$2 LIMIT 1`,[e.target_table,e.source_id])).rowCount)throw new SyncError('IDENTITY_LOCAL_COLLISION');
  if(e.local_row){
   const p=projection(shape,'d',true,cfg.corporateDelivery!.connection);
   const raw=(await db.query(`SELECT ${p.sql} FROM raw.olos_calls d WHERE internal_id_olos=$${p.parameters.length+1}`,[...p.parameters,e.target_id])).rows[0];
   if(deliveryDigest(mapRow(raw,shape,cfg.corporateDelivery!.connection))!==e.payload_hash)throw new SyncError('IDENTITY_LOCAL_PAYLOAD_DIVERGES');
   if((await db.query(`SELECT 1 FROM raw.olos_calls d JOIN raw.olos_calls x ON d.olos_call_id=x.olos_call_id AND d.data_ligacao=x.data_ligacao
    AND d.telefone=x.telefone AND d.id_campanha_olos=x.id_campanha_olos WHERE x.internal_id_olos=$1 AND d.internal_id_olos<>x.internal_id_olos`,[e.target_id])).rowCount)throw new SyncError('IDENTITY_LOCAL_LOGICAL_COLLISION');
  }
  e.new_payload={...e.payload,internal_id_olos:e.source_id};e.new_hash=deliveryDigest(e.new_payload);e.remote_row=null;
 }
 if(kind==='confirmed')for(const expected of historyHomologation){
  const e=result.find(r=>r.source_id===expected.source_id);
  const rawIds:Record<string,string>={'47558756':'73757','47559439':'73758','47561569':'73759'};
  if(result.length!==3||!e||e.target_id!==expected.target_id||e.agent_id!==expected.agent_id||e.payload.olos_call_id!==expected.olos_call_id||e.remote_raw_id!==rawIds[e.source_id])throw new SyncError('IDENTITY_CONFIRMED_SCOPE_INVALID');
 }
 return result;
}
async function remoteProof(db:Client,cfg:Config,m:Manifest,shape:Awaited<ReturnType<typeof corporateSchema>>['shape'],updated=false){
 const rows=m.entries.map(e=>(updated?e.new_payload:e.payload) as any);
 const found=await matches(db,rows,shape,cfg.corporateDelivery!);
 if(m.kind==='pending'){
  if(found.size)throw new SyncError('IDENTITY_REMOTE_RECEIPT_EXISTS');
  await matches(db,m.entries.map(e=>e.new_payload as any),shape,cfg.corporateDelivery!).then(f=>{if(f.size)throw new SyncError('IDENTITY_REMOTE_COLLISION');});
 }else for(const e of m.entries){
  if(found.get(updated?e.source_id:e.target_id)!==e.remote_raw_id)throw new SyncError('IDENTITY_REMOTE_RECEIPT_DIVERGES');
 }
 const forbidden=m.entries.map(e=>updated?e.target_id:e.source_id);
 if((await db.query('SELECT 1 FROM raw.olos_calls WHERE internal_id_olos=ANY($1::int[])',[forbidden])).rowCount)throw new SyncError('IDENTITY_REMOTE_COLLISION');
 const snapshots=[];
 for(const e of m.entries){
  const row=m.kind==='confirmed'?(await db.query('SELECT to_jsonb(d)::text AS row FROM raw.olos_calls d WHERE raw_olos_call_id=$1',[e.remote_raw_id])).rows[0]?.row:null;
  if(e.remote_row!==null){
   const expected=(await db.query(`SELECT ($1::jsonb || jsonb_build_object('internal_id_olos',$2::int))::text AS row`,[e.remote_row,updated?e.source_id:e.target_id])).rows[0].row;
   if(row!==expected)throw new SyncError('IDENTITY_REMOTE_FIELDS_CHANGED');
  }
  snapshots.push(row);
 }
 return snapshots;
}
async function checkpoint(db:PoolClient){return (await db.query('SELECT to_jsonb(c)::text AS row FROM corporate_sync.control c WHERE singleton')).rows[0]?.row??'null';}
async function load(db:PoolClient,id:string):Promise<Plan>{
 const p=(await db.query('SELECT p.*,r.state FROM olos_http.identity_plans p JOIN olos_http.identity_runs r USING(id) WHERE id=$1 FOR UPDATE OF r NOWAIT',[id])).rows[0];
 if(!p)throw new SyncError('IDENTITY_PLAN_MISSING');same(p.hash,drainHash(p.manifest),'IDENTITY_MANIFEST_CHANGED');return p;
}
async function validateLocal(db:PoolClient,cfg:Config,m:Manifest,shape:Awaited<ReturnType<typeof corporateSchema>>['shape'],owns=false){
 const g=await guard(db,cfg,owns);same(g.history,m.history,'IDENTITY_HISTORY_CHANGED');
 if(g.control.schema_hash!==m.schema||g.control.binding!==m.binding||cfg.sourceKey!==m.source)throw new SyncError('IDENTITY_BINDING_CHANGED');
 same(await dependencies(db,true),m.local_dependencies);
 same(await checkpoint(db),m.checkpoint);
 const now=await entries(db,cfg,m.ids,m.kind,shape);
 same(now,m.entries.map(e=>({...e,remote_row:null})));
 same(await referenceRows(db,m.local_dependencies.refs,m.entries.map(e=>e.target_id)),m.references);
}
async function adopt(db:PoolClient){
 // Same sequence/OID/PK/ACL; permits explicit UPDATE, never changes defaults or constraints.
 await db.query('ALTER TABLE raw.olos_calls ALTER COLUMN internal_id_olos SET GENERATED BY DEFAULT');
 await db.query('UPDATE olos_http.identity_contract SET adopted=true WHERE singleton');
}
async function applyLocal(db:PoolClient,m:Manifest,deadline:()=>void){
 for(const e of m.entries){
  deadline();
  if(e.local_row){
   const r=await db.query('UPDATE raw.olos_calls d SET internal_id_olos=$1 WHERE internal_id_olos=$2 AND to_jsonb(d)=$3::jsonb',[e.source_id,e.target_id,e.local_row]);
   if(r.rowCount!==1)throw new SyncError('IDENTITY_LOCAL_FENCE_LOST');
   const ok=(await db.query("SELECT to_jsonb(d)=($1::jsonb || jsonb_build_object('internal_id_olos',$2::bigint)) AS ok FROM raw.olos_calls d WHERE internal_id_olos=$2",[e.local_row,e.source_id])).rows[0]?.ok;
   if(!ok)throw new SyncError('IDENTITY_LOCAL_FIELDS_CHANGED');
  }
  if((await db.query('UPDATE olos_http.records r SET target_id=$1 WHERE source_key=$2 AND source_id=$3 AND to_jsonb(r)=$4::jsonb',[e.source_id,m.source,e.source_id,e.record_snapshot])).rowCount!==1)throw new SyncError('IDENTITY_LOCAL_FENCE_LOST');
  if((await db.query('UPDATE olos_http.corporate_outbox o SET target_id=$1::integer,payload=$2,payload_hash=$3 WHERE source_key=$4 AND source_id=$1::text AND to_jsonb(o)=$5::jsonb',[e.source_id,JSON.stringify(e.new_payload),e.new_hash,m.source,e.outbox_snapshot])).rowCount!==1)throw new SyncError('IDENTITY_LOCAL_FENCE_LOST');
  if(e.receipt&&(await db.query('UPDATE corporate_sync.receipts r SET internal_id_olos=$1,payload_hash=$2 WHERE internal_id_olos=$3 AND to_jsonb(r)=$4::jsonb',[e.source_id,e.new_hash,e.target_id,e.receipt])).rowCount!==1)throw new SyncError('IDENTITY_LOCAL_FENCE_LOST');
 }
 // Verify each cascade changed only its referencing ID, retaining multiplicity and every other field.
 for(const group of m.references){
  const expected=[];
  for(const row of group.rows)expected.push((await db.query(`SELECT ($1::jsonb || jsonb_build_object($2::text,
    (SELECT source_id::bigint FROM jsonb_to_recordset($3::jsonb) AS e(source_id text,target_id text) WHERE target_id=($1::jsonb->>$2))))::text AS row`,
   [row,group.ref.column,JSON.stringify(m.entries)])).rows[0].row);
  const actual=(await referenceRows(db,[group.ref],m.entries.map(e=>e.source_id)))[0]!.rows;
  same(actual.sort(),expected.sort(),'IDENTITY_REFERENCE_CHANGED');
 }
 same(await checkpoint(db),m.checkpoint);
}
async function complete(db:PoolClient,p:Plan,start:number){
 await db.query("UPDATE olos_http.identity_runs SET state='completed',duration_ms=$2,finished_at=clock_timestamp() WHERE id=$1",[p.id,Math.round(performance.now()-start)]);
 await event(db,p.id,'LOCAL_FINALIZED');
 if(p.manifest.kind==='confirmed')await db.query("UPDATE olos_http.corporate_control SET blocked=false,last_code=NULL WHERE singleton AND last_code=$1",[identityBlock]);
}
function result(p:Plan){return {id:p.id,hash:p.hash,state:p.state,selected:p.manifest.entries.length,kind:p.manifest.kind,
 confirmation:consent(p.state==='intent'?'reconcile':'execute',p.id,p.hash,p.manifest.kind)};}
async function finalized(db:PoolClient,m:Manifest){
 for(const e of m.entries){
  const r=(await db.query(`SELECT o.target_id::text,o.payload_hash,o.payload,o.source_hash,r.target_id::text AS record_id,r.source_hash AS record_hash
   FROM olos_http.corporate_outbox o JOIN olos_http.records r USING(source_key,source_id) WHERE o.source_key=$1 AND o.source_id=$2`,[m.source,e.source_id])).rows[0];
  if(!r||r.target_id!==e.source_id||r.record_id!==e.source_id||r.source_hash!==e.source_hash||r.record_hash!==e.source_hash||r.payload_hash!==e.new_hash)throw new SyncError('IDENTITY_FINALIZED_DIVERGES');
  same(r.payload,e.new_payload);
  if(e.receipt&&!(await db.query("SELECT to_jsonb(r)=($1::jsonb || jsonb_build_object('internal_id_olos',$2::bigint,'payload_hash',$3::text)) AS ok FROM corporate_sync.receipts r WHERE internal_id_olos=$2",[e.receipt,e.source_id,e.new_hash])).rows[0]?.ok)throw new SyncError('IDENTITY_FINALIZED_DIVERGES');
  if(e.local_row&&!(await db.query("SELECT to_jsonb(d)=($1::jsonb || jsonb_build_object('internal_id_olos',$2::bigint)) AS ok FROM raw.olos_calls d WHERE internal_id_olos=$2",[e.local_row,e.source_id])).rows[0]?.ok)throw new SyncError('IDENTITY_FINALIZED_DIVERGES');
 }
}
export async function identityCommand(cfg:Config,request:Request,hooks:IdentityHooks={}){
 validateRequest(request);
 if(!cfg.corporateDelivery||cfg.corporateDelivery.connection.writeEnabled||cfg.schema!=='raw'||cfg.table!=='olos_calls')throw new SyncError('IDENTITY_CONFIGURATION_INVALID');
 const store=new Store(cfg);let remote:Client|undefined;let intent=false,localIssued=false;const start=performance.now();
 const deadline=()=>{if(performance.now()-start>60000)throw new SyncError('IDENTITY_LATENCY_LIMIT');};
 try{
  await store.open();const db=store.client!;
  if((await db.query('SELECT current_database() AS name')).rows[0].name==='madm')throw new SyncError('IDENTITY_LOCAL_DATABASE_REQUIRED');
  if(!(await db.query("SELECT to_regclass('olos_http.identity_plans') IS NOT NULL AND to_regclass('olos_http.corporate_drain_runs') IS NOT NULL AS ok")).rows[0].ok)throw new SyncError('IDENTITY_MIGRATION_REQUIRED');
  if(request.action==='status'){
   const p=(await db.query('SELECT p.id,p.hash,p.manifest,r.state FROM olos_http.identity_plans p JOIN olos_http.identity_runs r USING(id) WHERE id=$1',[request.id])).rows[0];
   if(!p)throw new SyncError('IDENTITY_PLAN_MISSING');return result(p);
  }
  await locks(db,cfg.sourceKey);
  await db.query("SET lock_timeout='1s'; SET statement_timeout='10s'");
  await db.query('BEGIN');
  if(request.action==='plan'){
   const g=await guard(db,cfg);
   if((await db.query("SELECT 1 FROM olos_http.identity_runs WHERE state IN ('planned','intent')")).rowCount)throw new SyncError('IDENTITY_OPEN_PLAN_EXISTS');
   const prior=(await db.query(`SELECT jsonb_array_length(p.manifest->'ids') AS n FROM olos_http.identity_plans p JOIN olos_http.identity_runs r USING(id)
     WHERE r.state='completed' AND r.duration_ms IS NOT NULL AND r.duration_ms<=60000 AND p.manifest->>'kind'='pending'
     AND p.manifest->>'source'=$1 AND p.manifest->>'binding'=$2`,[cfg.sourceKey,cfg.corporateDelivery.binding])).rows.map(r=>r.n as number);
   const ceiling=prior.includes(500)?1000:prior.includes(250)?500:prior.includes(100)?250:prior.includes(3)?100:3;
   if(![3,100,250,500,1000].includes(request.ids.length)||request.ids.length>(request.kind==='confirmed'?3:ceiling))throw new SyncError('IDENTITY_STAGE_NOT_PROVEN');
   remote=await connect(cfg.corporateDelivery.connection,'destination');const shape=await remoteBegin(remote,cfg,g.control.schema_hash);
   const local_dependencies=await dependencies(db,true), remote_dependencies=await dependencies(remote,false);
   const chosen=await entries(db,cfg,request.ids,request.kind,shape);
   const manifest:Manifest={version:1,kind:request.kind,ids:[...request.ids].sort(),source:cfg.sourceKey,target:store.target,binding:cfg.corporateDelivery.binding,
    schema:g.control.schema_hash,review:request.review,history:g.history,local_dependencies,remote_dependencies,
    references:await referenceRows(db,local_dependencies.refs,chosen.map(e=>e.target_id)),checkpoint:await checkpoint(db),entries:chosen};
   const snapshots=await remoteProof(remote,cfg,manifest,shape);chosen.forEach((e,i)=>{e.remote_row=snapshots[i];});
   const p:Plan={id:randomUUID(),manifest,hash:drainHash(manifest),state:'planned'};
   await db.query('INSERT INTO olos_http.identity_plans(id,manifest,hash) VALUES($1,$2,$3)',[p.id,JSON.stringify(manifest),p.hash]);
   await db.query("INSERT INTO olos_http.identity_runs(id,state) VALUES($1,'planned')",[p.id]);await event(db,p.id,'PREPARED');
   await store.ping();deadline();await db.query('COMMIT');return result(p);
  }
  const p=await load(db,request.id),m=p.manifest;
  if(request.hash!==p.hash||request.confirmation!==consent(request.action,p.id,p.hash,m.kind))throw new SyncError('IDENTITY_NOT_AUTHORIZED');
  if(m.source!==cfg.sourceKey||m.binding!==cfg.corporateDelivery.binding||m.target!==store.target||m.version!==1)throw new SyncError('IDENTITY_BINDING_CHANGED');
  if(p.state==='completed'){
   await finalized(db,m);
   if(m.kind==='confirmed'){
    remote=await connect(cfg.corporateDelivery.connection,'destination');const shape=await remoteBegin(remote,cfg,m.schema);await remoteProof(remote,cfg,m,shape,true);
   }
   await db.query('ROLLBACK');return result(p);
  }
  if(request.action==='cancel'){
   if(p.state!=='planned')throw new SyncError('IDENTITY_CANNOT_CANCEL');await guard(db,cfg);
   await db.query("UPDATE olos_http.identity_runs SET state='cancelled',finished_at=clock_timestamp() WHERE id=$1",[p.id]);await event(db,p.id,'CANCELLED');await db.query('COMMIT');return result({...p,state:'cancelled'});
  }
  if(request.action==='reconcile'&&p.state!=='intent'||request.action==='execute'&&p.state!=='planned')throw new SyncError('IDENTITY_RECONCILIATION_REQUIRED');
  // Both databases are fenced before checking absence or changing identity.
  await guard(db,cfg,request.action==='reconcile');
  remote=await connect(cfg.corporateDelivery.connection,'destination');const shape=await remoteBegin(remote,cfg,m.schema);
  await validateLocal(db,cfg,m,shape,request.action==='reconcile');same(await dependencies(remote,false),m.remote_dependencies);
  if(request.action==='reconcile'){
   const actual=(await remote.query('SELECT raw_olos_call_id::text AS raw,internal_id_olos::text AS id FROM raw.olos_calls WHERE raw_olos_call_id=ANY($1::bigint[])',[m.entries.map(e=>e.remote_raw_id)])).rows;
   const allNew=m.entries.every(e=>actual.some(a=>a.raw===e.remote_raw_id&&a.id===e.source_id));
   const allOld=m.entries.every(e=>actual.some(a=>a.raw===e.remote_raw_id&&a.id===e.target_id));
   if(!allNew&&!allOld)throw new SyncError('IDENTITY_REMOTE_AMBIGUOUS');
   await remoteProof(remote,cfg,m,shape,allNew);
   if(allNew){await adopt(db);await applyLocal(db,m,deadline);await complete(db,p,start);}
   else{
    await db.query("UPDATE olos_http.identity_runs SET state='not_applied',finished_at=clock_timestamp() WHERE id=$1",[p.id]);await event(db,p.id,'REMOTE_NOT_APPLIED');
    await db.query('UPDATE olos_http.corporate_control SET blocked=false,last_code=NULL WHERE singleton AND last_code=$1',[identityBlock]);
   }
   deadline();await store.ping();localIssued=true;await db.query('COMMIT');return result({...p,state:allNew?'completed':'not_applied'});
  }
  await remoteProof(remote,cfg,m,shape);
  await adopt(db);
  if(m.kind==='confirmed'){
   await db.query("UPDATE olos_http.identity_runs SET state='intent' WHERE id=$1",[p.id]);await event(db,p.id,'REMOTE_COMMIT_INTENT');
   await db.query('UPDATE olos_http.corporate_control SET paused=true,blocked=true,last_code=$1,next_attempt_at=NULL WHERE singleton',[identityBlock]);
   // This durable commit is mandatory before corporate DML/COMMIT, and survives process loss.
   intent=true;await db.query('COMMIT');await hooks.afterIntent?.();
   await db.query('BEGIN');await validateLocal(db,cfg,m,shape,true);
   if((await load(db,p.id)).state!=='intent')throw new SyncError('IDENTITY_FENCE_LOST');
   for(const e of m.entries){
    deadline();
    const changed=await remote.query('UPDATE raw.olos_calls d SET internal_id_olos=$1 WHERE raw_olos_call_id=$2 AND internal_id_olos=$3 AND to_jsonb(d)=$4::jsonb',
      [e.source_id,e.remote_raw_id,e.target_id,e.remote_row]);
    if(changed.rowCount!==1)throw new SyncError('IDENTITY_REMOTE_FENCE_LOST');
   }
   await remoteProof(remote,cfg,m,shape,true);await hooks.beforeRemoteCommit?.();
   await validateLocal(db,cfg,m,shape,true);
   if((await corporateSchema(remote,cfg.corporateDelivery,false)).hash!==m.schema)throw new SyncError('CORPORATE_SCHEMA_CHANGED');
   await remoteProof(remote,cfg,m,shape,true);await store.ping();deadline();
   await remote.query('COMMIT');await hooks.afterRemoteCommit?.();
  }
  await applyLocal(db,m,deadline);await complete(db,p,start);await hooks.beforeLocalCommit?.();same((await guard(db,cfg)).history,m.history,'IDENTITY_HISTORY_CHANGED');await store.ping();deadline();
  localIssued=true;await db.query('COMMIT');await hooks.afterLocalCommit?.();return result({...p,state:'completed'});
 }catch(error){
  if(store.client)await store.client.query('ROLLBACK').catch(()=>{});
  if(intent)throw new SyncError('IDENTITY_COMMIT_UNKNOWN');
  if(localIssued)throw new SyncError('IDENTITY_LOCAL_COMMIT_UNCERTAIN');
  throw error;
 }finally{
  if(remote){await rollback(remote);await remote.end().catch(()=>{});}
  await store.close();
 }
}
