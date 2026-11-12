import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import type { DeliveryConfig } from './config.js';
import { admissionHash } from './allocator.js';
import type { MappedRecord } from '../mapping.js';
import { quarantineMembers } from './quarantine.js';
import type { Shape } from '../corporate-sync/mapping.js';
import type { ReadoptionProgress } from './readoption-contract.js';
function canonical(value:unknown):string {
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value)??'undefined';
}
export const readoptionDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export async function assertReadoptionSchema(db:PoolClient):Promise<void> {
  if(!(await db.query("SELECT to_regclass('olos_http.corporate_readoption_schema') IS NOT NULL AS present")).rows[0].present)
    throw new SyncError('READOPTION_ACTIVATION_MIGRATION_REQUIRED');
  if((await db.query('SELECT version FROM olos_http.corporate_readoption_schema WHERE singleton')).rows[0]?.version!==1)
    throw new SyncError('READOPTION_LOCAL_CONTRACT_CHANGED');
  if((await db.query(`SELECT 1 FROM olos_http.corporate_control c LEFT JOIN olos_http.corporate_allocation_fence f ON f.source_key=c.source_key
    WHERE c.singleton AND (f.binding IS DISTINCT FROM c.binding OR f.target_table IS DISTINCT FROM c.target_table
      OR f.required IS DISTINCT FROM c.id_allocator_required OR f.generation_id IS DISTINCT FROM c.id_allocator_generation)`)).rowCount)throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
  const scope=['corporate_control','records','corporate_outbox','corporate_id_allocator','corporate_id_admissions','corporate_id_assignments',
    'corporate_id_reversions','corporate_id_reversion_batches','corporate_collision_quarantine','corporate_collision_quarantine_runs',
    'corporate_allocator_readoptions','corporate_readoption_batches','corporate_allocation_fence','corporate_readoption_schema'].map(t=>'olos_http.'+t);
  const tables=(await db.query<{relkind:string;relrowsecurity:boolean;relforcerowsecurity:boolean}>(`SELECT relkind,relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE oid=ANY(ARRAY(SELECT to_regclass(name) FROM unnest($1::text[]) name))`,[scope])).rows;
  if(tables.length!==scope.length||tables.some(t=>t.relkind!=='r'||t.relrowsecurity||t.relforcerowsecurity))throw new SyncError('READOPTION_LOCAL_CONTRACT_CHANGED');
  const index=(await db.query(`SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('olos_http.corporate_allocator_readoption_one_open')
    AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
    AND pg_get_expr(i.indpred,i.indrelid)=$1`,["(state = ANY (ARRAY['prepared'::text, 'validating'::text, 'ready'::text, 'activating'::text, 'active'::text]))"]));
  if(index.rowCount!==1)throw new SyncError('READOPTION_LOCAL_CONTRACT_CHANGED');
  const ddl=readFileSync(new URL('../../migrations/011_corporate_readoption_activation.sql',import.meta.url),'utf8');
  for(const [name,delimiter] of [['require_corporate_id_assignment','assignment'],['guard_readoption_record_fence','fence'],['guard_readoption_local_raw','raw'],['guard_readoption_control','control'],['guard_readoption_request','request'],['guard_readoption_history','history'],['stamp_readoption_generation','stamp'],['guard_readoption_fence','fence_row'],['check_readoption_fence','fence_check']] as const){
    const definition=delimiter==='assignment'?readFileSync(new URL('../../migrations/008_corporate_id_allocator.sql',import.meta.url),'utf8'):ddl;
    const body=definition.split(`AS $${delimiter}$`)[1]?.split(`$${delimiter}$;`)[0];
    const row=(await db.query('SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure($1)',[`olos_http.${name}()`])).rows[0] as {prosrc:string}|undefined;
    if(!body||row?.prosrc!==body)throw new SyncError('READOPTION_LOCAL_CONTRACT_CHANGED');
  }
  const expected=[['olos_http.corporate_allocation_fence','corporate_readoption_fence','guard_readoption_fence'],['olos_http.corporate_allocation_fence','corporate_readoption_fence_consistency','check_readoption_fence'],['olos_http.corporate_id_admissions','corporate_readoption_generation','stamp_readoption_generation'],['olos_http.corporate_id_assignments','corporate_readoption_generation','stamp_readoption_generation'],['olos_http.records','corporate_readoption_record_fence','guard_readoption_record_fence'],
    ['olos_http.records','corporate_id_assignment_required','require_corporate_id_assignment'],
    ['raw.olos_calls','corporate_readoption_local_raw','guard_readoption_local_raw'],
    ['olos_http.corporate_control','corporate_readoption_control','guard_readoption_control'],
    ['olos_http.corporate_allocator_readoptions','corporate_readoption_request','guard_readoption_request'],
    ...['records','corporate_outbox','corporate_id_allocator','corporate_id_admissions','corporate_id_assignments','corporate_id_reversions','corporate_id_reversion_batches','corporate_collision_quarantine','corporate_collision_quarantine_runs','corporate_readoption_batches'].map(t=>[`olos_http.${t}`,'corporate_readoption_history','guard_readoption_history'])];
  for(const [table,trigger,fn] of expected){
    const deferred=trigger==='corporate_id_assignment_required'||trigger==='corporate_readoption_fence_consistency';
    const type=deferred?21:trigger==='corporate_readoption_generation'?7:trigger==='corporate_readoption_local_raw'||trigger==='corporate_readoption_record_fence'?23:27;
    const info=await db.query(`SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND tgenabled='A'
      AND tgfoid=to_regprocedure($3) AND tgtype=$4 AND tgqual IS NULL AND tgnargs=0
      AND tgdeferrable=$5 AND tginitdeferred=$5 AND tgattr::text=CASE WHEN $6 THEN
        (SELECT attnum::text FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname='internal_id_olos') ELSE '' END`,
      [table,trigger,`olos_http.${fn}()`,type,deferred,trigger==='corporate_readoption_local_raw']);
    if(info.rowCount!==1)throw new SyncError('READOPTION_LOCAL_CONTRACT_CHANGED');
  }
}
interface InitialMember {source_id:string;source_hash:string;request_id:string;mapped_hash:string}
interface ReversionEvidence extends Record<string,unknown> {
 request_id:string;source_key:string;target_table:string;binding:string;adoption_request_id:string;state:string;
 initial_manifest:InitialMember[];initial_digest:string;initial_count:string;materialized_count:string;batch_count:number;
 validation_digest:string|null;validated_at:Date|null;
}
interface OriginalAllocator {request_id:string;evidence_ref:string;binding:string;target_table:string}
export async function predecessorProof(db:PoolClient,cfg:DeliveryConfig,run:ReadoptionProgress,deep:boolean) {
  const original=(await db.query<OriginalAllocator>('SELECT request_id,evidence_ref,binding,target_table FROM olos_http.corporate_id_allocator WHERE source_key=$1',[run.source_key])).rows[0];
  const reversal=(await db.query<ReversionEvidence>(`SELECT request_id,source_key,target_table,binding,adoption_request_id,sequence_name,evidence_ref,state,initial_digest,initial_count,materialized_count,batch_count,previous_allocator_state,previous_id_allocator_required,previous_generation,previous_code,previous_blocked,previous_confirmed_count,created_at,completed_at,validated_at,validation_digest${deep?',initial_manifest':''} FROM olos_http.corporate_id_reversions WHERE source_key=$1 AND request_id=$2`,[run.source_key,run.previous_reversion_id])).rows[0];
  if(!original||!reversal||reversal.state!=='completed'||!reversal.validated_at||!reversal.validation_digest
    ||reversal.adoption_request_id!==original.request_id||reversal.binding!==cfg.binding||reversal.target_table!==run.target_table
    ||(run.previous_adoption_id!==null&&run.previous_adoption_id!==original.request_id))throw new SyncError('READOPTION_REVERSAL_UNVERIFIED');
  const {initial_manifest,...header}=reversal;
  if(deep&&(!Array.isArray(initial_manifest)||String(initial_manifest.length)!==reversal.initial_count||
    createHash('sha256').update(JSON.stringify(initial_manifest.map(m=>[m.source_id,m.source_hash,m.request_id,m.mapped_hash]))).digest('hex')!==reversal.initial_digest))
    throw new SyncError('READOPTION_PREDECESSOR_CHANGED');
  const snapshot={original,reversal:header};
  if(!deep){
    if(readoptionDigest(snapshot)!==readoptionDigest(run.predecessor_snapshot))throw new SyncError('READOPTION_PREDECESSOR_CHANGED');
    return {snapshot,digest:run.predecessor_digest!,adoptionId:original.request_id};
  }
  if(!(await db.query(`SELECT 1 FROM olos_http.corporate_collision_recoveries WHERE source_key=$1 AND target_table=$2
    AND binding=$3 AND verification_digest=$4`,[run.source_key,run.target_table,cfg.binding,reversal.validation_digest])).rowCount)
    throw new SyncError('READOPTION_REVERSAL_UNVERIFIED');
  const batches=(await db.query<{batch_no:number;member_count:number;members:unknown[]}>('SELECT batch_no,member_count,members FROM olos_http.corporate_id_reversion_batches WHERE request_id=$1 ORDER BY batch_no',[reversal.request_id])).rows;
  if(batches.length!==reversal.batch_count||batches.reduce((n,b)=>n+BigInt(b.member_count),0n).toString()!==reversal.materialized_count||
    batches.some((b,i)=>b.batch_no!==i+1||!Array.isArray(b.members)||b.members.length!==b.member_count))throw new SyncError('READOPTION_PREDECESSOR_CHANGED');
  const entries=(await db.query<{mapped:MappedRecord;mapped_hash:string;source_id:string;source_hash:string;request_id:string;valid:boolean}>(`SELECT a.mapped,a.mapped_hash,x.source_id,x.source_hash,x.request_id::text,
    (a.materialized AND a.source_hash=x.source_hash AND a.request_id=x.request_id AND a.mapped_hash=x.mapped_hash
      AND r.source_hash=x.source_hash AND r.target_table=$2 AND r.target_id=x.target_id AND o.source_hash=x.source_hash
      AND o.target_id=x.target_id AND o.payload_hash=x.payload_hash) IS TRUE AS valid
    FROM olos_http.corporate_id_reversion_batches b CROSS JOIN LATERAL jsonb_to_recordset(b.members)
      AS x(source_id text,source_hash text,request_id uuid,mapped_hash text,target_id bigint,payload_hash text)
    LEFT JOIN olos_http.corporate_id_admissions a ON a.source_key=$1 AND a.source_id=x.source_id
    LEFT JOIN olos_http.records r ON r.source_key=$1 AND r.source_id=x.source_id
    LEFT JOIN olos_http.corporate_outbox o ON o.source_key=$1 AND o.source_id=x.source_id WHERE b.request_id=$3`,[run.source_key,run.target_table,reversal.request_id])).rows;
  if(BigInt(entries.length)!==BigInt(reversal.materialized_count)||entries.some(e=>!e.valid||!e.mapped||admissionHash(e.mapped)!==e.mapped_hash))throw new SyncError('READOPTION_PREDECESSOR_CHANGED');
  const indexed=new Map(entries.map(e=>[e.source_id,e]));
  if(indexed.size!==entries.length||initial_manifest.some(m=>{const e=indexed.get(m.source_id);return !e||e.source_hash!==m.source_hash||e.request_id!==m.request_id||e.mapped_hash!==m.mapped_hash;}))throw new SyncError('READOPTION_PREDECESSOR_CHANGED');
  return {snapshot,digest:readoptionDigest([snapshot,batches]),adoptionId:original.request_id};
}
export async function readoptionQuarantine(db:PoolClient,cfg:DeliveryConfig,run:ReadoptionProgress,shape:Shape) {
  const members=await quarantineMembers(db,cfg,run.source_key,run.target_table,shape);
  if(run.quarantine_manifest!==null){
    const current=new Map(members.map(m=>[m.source_id,m]));
    for(const member of run.quarantine_manifest)if(readoptionDigest(current.get(member.source_id))!==readoptionDigest(member))throw new SyncError('CORPORATE_QUARANTINE_CHANGED');
    const initial=new Set(run.quarantine_manifest.map(m=>m.source_id));
    const extra=members.filter(m=>!initial.has(m.source_id));
    if(extra.length){
      const runs=(await db.query<{request_id:string;readoption_request_id:string|null}>('SELECT request_id,readoption_request_id FROM olos_http.corporate_collision_quarantine_runs WHERE request_id=ANY($1::uuid[])',[extra.map(m=>m.request_id)])).rows;
      if(runs.some(r=>r.readoption_request_id!==run.request_id)||new Set(runs.map(r=>r.request_id)).size!==new Set(extra.map(m=>m.request_id)).size)throw new SyncError('CORPORATE_QUARANTINE_CHANGED');
    }
  }
  return members;
}
