import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Store } from './store.js';
import type { Config } from './config.js';
import { readFields, rows, type ReadSpec } from './api.js';
import { WorkerError } from './errors.js';
import { drainHash } from './corporate-delivery/drain-request.js';
import { preservedHistoryRead } from './corporate-delivery/preserved-history.js';
import type { Cache } from './mapping.js';

export interface GapRange {date:string;start:string;end:string}
export interface GapInput {evidenceSha256:string;referencesSha256:string;ranges:GapRange[]}
interface Block extends GapRange {missing:string[];existing:unknown[]}
export interface GapManifest {
 version:1;parent:string;history:unknown;source:string;target:string;binding:string;schema:string;
 evidenceSha256:string;referencesSha256:string;sourceTimeZone:string;sourceAccountHash:string;
 maxResponseBytes:number;timeoutMs:number;blocks:Block[];
}
export interface GapAuthorization {planId:string;hash:string;block:number;confirmation:string}
export interface GapPlan {id:string;hash:string;manifest:GapManifest}
export interface GapScope {plan:GapPlan;block:Block;number:number;readId:string}
export const bodyHash=(body:string)=>createHash('sha256').update(body).digest('hex');
function fail(code:string):never{throw new WorkerError(code);}
const same=(a:unknown,b:unknown,code='GAP_EVIDENCE_CHANGED')=>{if(drainHash(a)!==drainHash(b))fail(code);};
const sourceAccount=(cfg:Config)=>drainHash([cfg.baseUrl,cfg.username,cfg.clientId,cfg.tlsVerify]);
export function gapConsent(action:'CAPTURE'|'PERSIST',a:Omit<GapAuthorization,'confirmation'>){
 return `AUTHORIZE_HISTORY_GAP_${action}:${a.planId}:${a.hash}:${a.block}`;
}
export function splitGapRanges(input:GapInput):GapRange[]{
 if(!input||!/^[a-f0-9]{64}$/.test(input.evidenceSha256)||!/^[a-f0-9]{64}$/.test(input.referencesSha256)||!Array.isArray(input.ranges)||!input.ranges.length||input.ranges.length>20)fail('GAP_SCOPE_INVALID');
 // Evidence supplied for this incident only. A digest is an attribution to human
 // review, not a claim that the application independently verified the OLOS log.
 const roots=[[46671511n,46800030n],[46800031n,46839630n],[46839631n,46856400n]];
 const blocks:GapRange[]=[];
 for(const r of input.ranges){
  readFields({...r,kind:'reread'});
  if(r.date!=='2026-10-28'||!roots.some(([s,e])=>BigInt(r.start)>=s!&&BigInt(r.end)<=e!))fail('GAP_OUTSIDE_EVIDENCE_SCOPE');
  for(let start=BigInt(r.start);start<=BigInt(r.end);start+=10000n){
   const end=start+9999n<BigInt(r.end)?start+9999n:BigInt(r.end);
   if(blocks.some(b=>start<=BigInt(b.end)&&end>=BigInt(b.start)))fail('GAP_RANGE_OVERLAP');
   blocks.push({date:r.date,start:String(start),end:String(end)});
  }
 }
 if(blocks.length>40)fail('GAP_BLOCK_LIMIT');
 return blocks;
}
export async function gapInstalled(db:PoolClient){return (await db.query("SELECT to_regclass('olos_http.history_gap_plans') IS NOT NULL AS ok")).rows[0].ok as boolean;}
async function guard(store:Store,plan?:GapPlan,ownRead?:string){
 const db=store.client!,cfg=store.cfg;
 if(!cfg.corporateDelivery||cfg.corporateDelivery.connection.writeEnabled||store.target!=='"raw"."olos_calls"'||!cfg.sourceTimeZone||!cfg.sourceIdConfirmed)fail('GAP_CONFIGURATION_INVALID');
 if(!await gapInstalled(db))fail('GAP_MIGRATION_REQUIRED');
 for(const n of [4])if(!(await db.query('SELECT pg_try_advisory_lock(17320914,$1) AS ok',[n])).rows[0].ok)fail('CORPORATE_DELIVERY_BUSY');
 for(const key of [`olos-admin:${cfg.sourceKey}`,`olos-http:history:${cfg.sourceKey}`]){
  if(!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0].ok)fail('GAP_CONSUMER_ACTIVE');
 }
 store.delivery!.suspend();await store.captureReady();
 const settings=(await db.query('SELECT enabled,desired_state,runtime_state FROM olos_http.worker_settings WHERE source_key=$1 FOR SHARE',[cfg.sourceKey])).rows[0];
 if(!settings||settings.enabled||settings.desired_state!=='STOPPED'||settings.runtime_state!=='STOPPED')fail('HISTORY_SCHEDULER_NOT_STOPPED');
 const control=(await db.query('SELECT * FROM olos_http.corporate_control WHERE singleton FOR SHARE')).rows[0];
 if(!control.ready||!control.paused||control.blocked||new Map(control.destination_shape).has('id_operador_olos'))fail('GAP_CONTROL_INVALID');
 if((await db.query("SELECT 1 FROM olos_http.corporate_selective_commits WHERE state='unresolved'")).rowCount||
  (await db.query("SELECT 1 FROM olos_http.corporate_drain_runs WHERE state IN ('planned','running','failed')")).rowCount||
  (await db.query('SELECT 1 FROM corporate_sync.control WHERE pending IS NOT NULL')).rowCount)fail('GAP_DELIVERY_PENDING');
 if((await db.query("SELECT to_regclass('olos_http.identity_runs') IS NOT NULL AS ok")).rows[0].ok&&
  (await db.query("SELECT 1 FROM olos_http.identity_runs WHERE state IN ('planned','intent')")).rowCount)fail('GAP_IDENTITY_PENDING');
 const history=(await db.query('SELECT to_jsonb(h) AS h FROM olos_http.reads h WHERE id=$1 AND source_key=$2 FOR SHARE',[preservedHistoryRead,cfg.sourceKey])).rows[0]?.h;
 if(!history||history.spec.kind!=='history'||history.state!=='reading'||history.error_code!=='RESPONSE_TOO_LARGE'||history.processed_count!==0||
  history.response_body!==null||history.finished_at!==null||history.resolution!==null||history.target_table!==store.target)fail('GAP_PARENT_CHANGED');
 if(plan){
  same(history,plan.manifest.history,'GAP_PARENT_CHANGED');
  const m=plan.manifest;
  if(m.source!==cfg.sourceKey||m.target!==store.target||m.binding!==cfg.corporateDelivery.binding||m.schema!==control.schema_hash||
   m.maxResponseBytes!==cfg.maxResponseBytes||m.timeoutMs!==cfg.timeoutMs||m.sourceTimeZone!==cfg.sourceTimeZone||m.sourceAccountHash!==sourceAccount(cfg))fail('GAP_BINDING_CHANGED');
 }
 if((await db.query("SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received') AND id<>$2 AND ($3::uuid IS NULL OR id<>$3)",
  [cfg.sourceKey,preservedHistoryRead,ownRead??null])).rowCount)fail('GAP_RECOVERY_REQUIRED');
 return {history,control};
}
async function inventory(db:PoolClient,source:string,r:GapRange){
 // Enumerate every candidate PK, including holes in the middle, without treating
 // a count difference or min/max as proof of which IDs are absent.
 return (await db.query(`SELECT g.id::text AS id,to_jsonb(r) AS record,to_jsonb(o) AS outbox
  FROM generate_series($2::bigint,$3::bigint) g(id)
  LEFT JOIN olos_http.records r ON r.source_key=$1 AND r.source_id=g.id::text
  LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id ORDER BY g.id`,[source,r.start,r.end])).rows;
}
async function noPriorOverlap(db:PoolClient,source:string,b:GapRange){
 const reads=(await db.query("SELECT spec FROM olos_http.reads WHERE source_key=$1 AND spec->>'kind'='reread'",[source])).rows;
 for(const {spec} of reads){
  readFields(spec);
  if(spec.date===b.date&&BigInt(b.start)<=BigInt(spec.end)&&BigInt(b.end)>=BigInt(spec.start))fail('GAP_PRIOR_RANGE_REVIEW_REQUIRED');
 }
}
export async function prepareGaps(store:Store,input:GapInput):Promise<GapPlan>{
 const ranges=splitGapRanges(input),db=store.client!;
 await db.query('BEGIN');
 try{
  const {history,control}=await guard(store);
  const blocks:Block[]=[];
  for(const r of ranges){
   await noPriorOverlap(db,store.cfg.sourceKey,r);
   const all=await inventory(db,store.cfg.sourceKey,r),missing=all.filter(x=>!x.record).map(x=>x.id as string);
   if(missing.length)blocks.push({...r,missing,existing:all.filter(x=>x.record)});
  }
  if(!blocks.length)fail('GAP_NOTHING_MISSING');
  const manifest:GapManifest={version:1,parent:preservedHistoryRead,history,source:store.cfg.sourceKey,target:store.target,
   binding:store.cfg.corporateDelivery!.binding,schema:control.schema_hash,evidenceSha256:input.evidenceSha256,referencesSha256:input.referencesSha256,
   sourceTimeZone:store.cfg.sourceTimeZone!,sourceAccountHash:sourceAccount(store.cfg),
   maxResponseBytes:store.cfg.maxResponseBytes,timeoutMs:store.cfg.timeoutMs,blocks};
  const plan={id:randomUUID(),hash:drainHash(manifest),manifest};
  await db.query('INSERT INTO olos_http.history_gap_plans(id,manifest,hash) VALUES($1,$2,$3)',[plan.id,manifest,plan.hash]);
  await store.ping();await db.query('COMMIT');return plan;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
export async function loadGap(store:Store,a:GapAuthorization,action:'CAPTURE'|'PERSIST',admission=true){
 if(!/^[a-f0-9-]{36}$/.test(a.planId)||!/^[a-f0-9]{64}$/.test(a.hash)||!Number.isSafeInteger(a.block)||a.block<1||a.block>40||a.confirmation!==gapConsent(action,a))fail('GAP_NOT_AUTHORIZED');
 const p=(await store.client!.query<GapPlan>('SELECT id,hash,manifest FROM olos_http.history_gap_plans WHERE id=$1',[a.planId])).rows[0];
 if(!p||p.hash!==a.hash||drainHash(p.manifest)!==p.hash||p.manifest.version!==1||p.manifest.parent!==preservedHistoryRead)fail('GAP_MANIFEST_CHANGED');
 const block=p.manifest.blocks[a.block-1];if(!block)fail('GAP_BLOCK_MISSING');
 const read=(await store.client!.query(`SELECT r.* FROM olos_http.history_gap_children c JOIN olos_http.reads r ON r.id=c.read_id
  WHERE c.plan_id=$1 AND c.block=$2`,[p.id,a.block])).rows[0];
 if(p.manifest.source!==store.cfg.sourceKey||p.manifest.target!==store.target||p.manifest.binding!==store.cfg.corporateDelivery?.binding)fail('GAP_BINDING_CHANGED');
 if(admission)await guard(store,p,read?.id);
 if(read){
  same(read.spec,{kind:'reread',date:block.date,start:block.start,end:block.end,gap:{planId:p.id,hash:p.hash,block:a.block}},'GAP_CHILD_CHANGED');
  if(read.source_key!==p.manifest.source||read.target_table!==p.manifest.target||!['reading','received','done'].includes(read.state))fail('GAP_CHILD_CHANGED');
 }
 return {plan:p,block: block!,number:a.block,read};
}
export async function beginGap(store:Store,a:GapAuthorization){
 const db=store.client!;await db.query('BEGIN');
 try{
  const context=await loadGap(store,a,'CAPTURE');
  if(context.read)fail('GAP_CAPTURE_ALREADY_ATTEMPTED');
  await noPriorOverlap(db,store.cfg.sourceKey,context.block);
  const all=await inventory(db,store.cfg.sourceKey,context.block);
  same(all.filter(x=>!x.record).map(x=>x.id),context.block.missing);
  same(all.filter(x=>x.record),context.block.existing);
  const readId=randomUUID(),spec={kind:'reread',date:context.block.date,start:context.block.start,end:context.block.end,
   gap:{planId:a.planId,hash:a.hash,block:a.block}};
  await db.query('INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES($1,$2,$3,$4)',[readId,store.cfg.sourceKey,store.target,spec]);
  await db.query('INSERT INTO olos_http.history_gap_children(read_id,plan_id,block) VALUES($1,$2,$3)',[readId,a.planId,a.block]);
  await store.ping();await db.query('COMMIT');return readId;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
export async function stageGap(store:Store,a:GapAuthorization,id:string,body:string,ms:number){
 const db=store.client!;await db.query('BEGIN');
 try{
  // Once a POST has returned, retain its evidence even if operational controls
  // changed in flight. This only stages the bound child's bytes; processing and
  // every new request still require the full admission guard.
  const c=await loadGap(store,a,'CAPTURE',false);
  if(c.read?.id!==id||c.read.state!=='reading')fail('GAP_CHILD_CHANGED');
  if(Buffer.byteLength(body)>c.plan.manifest.maxResponseBytes)fail('RESPONSE_TOO_LARGE');
  await store.stage(id,body,ms);
  await db.query('INSERT INTO olos_http.history_gap_responses(read_id,body_hash,bytes) VALUES($1,$2,$3)',[id,bodyHash(body),Buffer.byteLength(body)]);
  await store.ping();await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
export async function localGap(store:Store,a:GapAuthorization){
 const c=await loadGap(store,a,'PERSIST');
 if(!c.read||!['received','done'].includes(c.read.state))fail('GAP_REMOTE_RESULT_UNKNOWN');
 const response=(await store.client!.query('SELECT * FROM olos_http.history_gap_responses WHERE read_id=$1',[c.read.id])).rows[0];
 if(!response||bodyHash(c.read.response_body)!==response.body_hash||Buffer.byteLength(c.read.response_body)!==response.bytes)fail('GAP_RESPONSE_CHANGED');
 return c;
}
export async function checkGapInventory(store:Store,scope:GapScope){
 const all=await inventory(store.client!,store.cfg.sourceKey,scope.block),missing=new Set(scope.block.missing);
 same(all.filter(x=>!missing.has(x.id)),scope.block.existing);
 const proofs=new Map((await store.client!.query('SELECT * FROM olos_http.history_gap_members WHERE source_key=$1 AND read_id=$2',
  [store.cfg.sourceKey,scope.readId])).rows.map(p=>[p.source_id,p]));
 for(const row of all.filter(x=>missing.has(x.id)&&x.record)){
  const proof=proofs.get(row.id);
  if(!proof||!row.outbox||proof.target_id!==String(row.record.target_id)||proof.source_hash!==row.record.source_hash||
   proof.payload_hash!==row.outbox.payload_hash||row.outbox.source_hash!==proof.source_hash||String(row.outbox.target_id)!==proof.target_id)fail('GAP_EVIDENCE_CHANGED');
 }
}
export function gapReferences(body:string,hash:string):Cache{
 if(bodyHash(body)!==hash)fail('GAP_REFERENCES_CHANGED');
 const input=JSON.parse(body),cache:Cache={users:new Map(),campaigns:new Map(),dispositions:new Map()};
 if(!input||Object.keys(input).sort().join(',')!=='campaigns,dispositions,users')fail('GAP_REFERENCES_INVALID');
 for(const key of ['users','campaigns','dispositions'] as const){
  if(!Array.isArray(input[key]))fail('GAP_REFERENCES_INVALID');
  for(const pair of input[key]){
   if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string')||cache[key].has(pair[0]))fail('GAP_REFERENCES_INVALID');
   cache[key].set(pair[0],pair[1]);
  }
 }
 return cache;
}
export async function recordGapMembers(store:Store,scope:GapScope,ids:string[]){
 const missing=new Set(scope.block.missing);
 for(const id of new Set(ids.filter(id=>missing.has(id))))await store.client!.query(`INSERT INTO olos_http.history_gap_members(source_key,source_id,read_id,target_id,source_hash,payload_hash)
  SELECT source_key,source_id,$3,target_id::text,source_hash,payload_hash FROM olos_http.corporate_outbox
  WHERE source_key=$1 AND source_id=$2 ON CONFLICT(source_key,source_id) DO NOTHING`,[store.cfg.sourceKey,id,scope.readId]);
}

// Drain/identity exception for durable empty responses. This does not recover a
// block, grant membership, change a read, or authorize another OLOS request.
// Caller holds the source/history/delivery locks and rechecks before COMMIT.
export async function assertEmptyGapChildren(db:PoolClient,cfg:Config,target:string,history:unknown,schema:string,ids:string[]){
 if(!ids.length)return;
 if(!await gapInstalled(db))fail('GAP_PENDING_CHILD_INVALID');
 const children=(await db.query(`SELECT r.*,c.plan_id,c.block,p.manifest,p.hash,s.body_hash,s.bytes,
   r.started_at>=h.started_at AS after_parent,
   EXISTS(SELECT 1 FROM olos_http.history_gap_members gm WHERE gm.read_id=r.id) AS has_members
   FROM olos_http.reads r JOIN olos_http.history_gap_children c ON c.read_id=r.id
   JOIN olos_http.history_gap_plans p ON p.id=c.plan_id
   JOIN olos_http.history_gap_responses s ON s.read_id=r.id
   JOIN olos_http.reads h ON h.id=$2
   WHERE r.id=ANY($1::uuid[]) FOR SHARE OF r,c,p,s NOWAIT`,[ids,preservedHistoryRead])).rows;
 if(children.length!==ids.length)fail('GAP_PENDING_CHILD_INVALID');
 for(const r of children){
  const m=r.manifest as GapManifest;
  if(!m||m.version!==1||m.parent!==preservedHistoryRead||!Array.isArray(m.blocks)||!m.blocks.length||m.blocks.length>40||
   m.source!==cfg.sourceKey||m.target!==target||m.binding!==cfg.corporateDelivery!.binding||m.schema!==schema||
   r.hash!==drainHash(m)||drainHash(m.history)!==drainHash(history))fail('GAP_PENDING_CHILD_INVALID');
  // Reuse the original range/evidence bounds; a JSON spec alone is not a journal.
  const ranges=m.blocks.flatMap(b=>splitGapRanges({evidenceSha256:m.evidenceSha256,referencesSha256:m.referencesSha256,ranges:[b]}));
  same(ranges,m.blocks.map(b=>({date:b.date,start:b.start,end:b.end})),'GAP_PENDING_CHILD_INVALID');
  if(ranges.some((a,i)=>ranges.slice(0,i).some(b=>BigInt(a.start)<=BigInt(b.end)&&BigInt(a.end)>=BigInt(b.start))))fail('GAP_PENDING_CHILD_INVALID');
  const b=m.blocks[r.block-1];
  if(!b||!Array.isArray(b.missing)||!b.missing.length||!Array.isArray(b.existing)||
   r.source_key!==m.source||r.target_table!==target||!r.after_parent||r.state!=='received'||r.processed_count!==0||
   (r.received_count!==null&&r.received_count!==0)||r.finished_at!==null||r.resolution!==null||r.has_members||
   typeof r.response_body!=='string'||!/^\s*\[\s*\]\s*$/.test(r.response_body)||
   r.body_hash!==bodyHash(r.response_body)||r.bytes!==Buffer.byteLength(r.response_body)||
   !Number.isSafeInteger(m.maxResponseBytes)||r.bytes>m.maxResponseBytes)fail('GAP_PENDING_CHILD_INVALID');
  // JSON whitespace only. Do not accept BOM/other text as an empty JSON array.
  try{const body=JSON.parse(r.response_body);if(!Array.isArray(body)||body.length)fail('GAP_PENDING_CHILD_INVALID');}
  catch{fail('GAP_PENDING_CHILD_INVALID');}
  same(r.spec,{kind:'reread',date:b.date,start:b.start,end:b.end,
   gap:{planId:r.plan_id,hash:r.hash,block:r.block}},'GAP_PENDING_CHILD_INVALID');
 }
}

// Used only for newly admitted drain entries. Old run manifests do not acquire
// this exception implicitly. The immutable membership is bound into new evidence.
export async function recoveredGapProof(db:PoolClient,cfg:Config,entries:{source_id:string;target_id:string;source_hash:string;payload_hash:string}[]){
 const result=new Map<string,{read_id:string;plan_hash:string;body_hash:string}>();
 if(!entries.length||!await gapInstalled(db))return result;
 const members=(await db.query('SELECT * FROM olos_http.history_gap_members WHERE source_key=$1 AND source_id=ANY($2::text[])',
  [cfg.sourceKey,entries.map(e=>e.source_id)])).rows;
 const reads=(await db.query(`SELECT c.read_id,c.block,p.id AS plan_id,p.manifest,p.hash,r.spec,r.state,r.source_key AS read_source,r.target_table,
  r.response_body,r.processed_count,r.received_count,s.body_hash,s.bytes
  FROM olos_http.history_gap_children c JOIN olos_http.history_gap_plans p ON p.id=c.plan_id
  JOIN olos_http.reads r ON r.id=c.read_id JOIN olos_http.history_gap_responses s USING(read_id)
  WHERE c.read_id=ANY($1::uuid[])`,[[...new Set(members.map(m=>m.read_id))]])).rows;
 const history=(await db.query('SELECT to_jsonb(h) AS h FROM olos_http.reads h WHERE id=$1',[preservedHistoryRead])).rows[0]?.h;
 const schema=(await db.query('SELECT schema_hash FROM olos_http.corporate_control WHERE singleton')).rows[0]?.schema_hash;
 const valid=new Map<string,{read_id:string;plan_hash:string;body_hash:string}>();
 for(const p of reads){
  const m=p.manifest as GapManifest,b=m.blocks[p.block-1];
  if(p.state!=='done'||p.processed_count!==p.received_count||!b||m.version!==1||m.parent!==preservedHistoryRead||m.schema!==schema||
   m.source!==cfg.sourceKey||m.binding!==cfg.corporateDelivery!.binding||m.target!==p.target_table||p.read_source!==m.source||
   p.hash!==drainHash(m)||p.body_hash!==bodyHash(p.response_body)||p.bytes!==Buffer.byteLength(p.response_body))fail('GAP_PROVENANCE_INVALID');
  const received=rows(p.response_body);
  if(!received.length||received.length!==p.received_count)fail('GAP_PROVENANCE_INVALID');
  same(history,m.history,'GAP_PARENT_CHANGED');
  same(p.spec,{kind:'reread',date:b.date,start:b.start,end:b.end,gap:{planId:p.plan_id,hash:p.hash,block:p.block}},'GAP_CHILD_CHANGED');
  valid.set(p.read_id,{read_id:p.read_id,plan_hash:p.hash,body_hash:p.body_hash});
 }
 for(const p of members){
  const e=entries.find(e=>e.source_id===p.source_id)!,read=reads.find(r=>r.read_id===p.read_id);
  if(!valid.has(p.read_id)||!read.manifest.blocks[read.block-1].missing.includes(e.source_id)||
   p.target_id!==e.target_id||p.target_id!==e.source_id||p.source_hash!==e.source_hash||p.payload_hash!==e.payload_hash)fail('GAP_PROVENANCE_INVALID');
  result.set(e.source_id,valid.get(p.read_id)!);
 }
 return result;
}
