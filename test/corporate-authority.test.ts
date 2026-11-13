import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client,PoolClient} from 'pg';
import pg from 'pg';
import {allocationPolicy,assertAllocationSchema} from '../src/corporate-delivery/allocation-policy.js';
import {nextLegacyId} from '../src/corporate-delivery/legacy-sequence.js';
import {readFileSync} from 'node:fs';
import {allocatorError,reserveIds,type AllocatorStatus} from '../src/corporate-delivery/allocator.js';
import type {DeliveryConfig} from '../src/corporate-delivery/config.js';
import {deliveryConfig} from '../src/corporate-delivery/config.js';
import {matches} from '../src/corporate-delivery/contract.js';
import {row,shape} from './corporate-sync.fixture.js';
import {SyncError} from '../src/corporate-sync/errors.js';

test('durable ambiguity blocks matching before recognizing any candidate and preserves the error code',async t=>{
 const db=new pg.Client(),queries:string[]=[];
 const cfg=deliveryConfig({DATABASE_URL:'postgresql://test@localhost/local',OLOS_CORPORATE_DATABASE_URL:'postgresql://test@localhost/madm',ATTEMPTS_PERSISTENCE_MODE:'corporate'});
 assert(cfg);
 const ambiguous=new pg.DatabaseError('private database details',0,'error');ambiguous.code='P3110';
 t.mock.method(db,'query',async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('to_regnamespace'))return {rows:[{present:true}]};
  if(sql.includes('assert_unambiguous'))throw ambiguous;
  assert.fail('An ambiguous call must not reach candidate recognition');
 });
 await assert.rejects(matches(db,[row()],shape(),cfg),error=>error instanceof SyncError&&error.code==='AMBIGUOUS_LOGICAL_IDENTITY');
 assert.equal(queries.length,2);
 const mapped=allocatorError(ambiguous);
 assert(mapped instanceof SyncError);assert.equal(mapped.code,'AMBIGUOUS_LOGICAL_IDENTITY');
});

test('one allocation policy: legacy/adopting only admit; active reserves; missing or reverting never allocate',()=>{
 for(const state of ['legacy','adopting','active','reverting'] as const){
  const allocation={state} as AllocatorStatus;
  if(state==='reverting')assert.throws(()=>allocationPolicy(allocation),/LEGACY_GENERATION_FORBIDDEN/);
  else assert.equal(allocationPolicy(allocation),state==='active'?'reserve':'admit');
 }
 assert.throws(()=>allocationPolicy(undefined),/ALLOCATOR_PREPARATION_REQUIRED/);
});
test('the former legacy entrypoint never consumes a sequence or writes a mapping',async()=>{
 const db={query:async()=>{assert.fail('No SQL is permitted for legacy allocation');}} as unknown as PoolClient;
 await assert.rejects(nextLegacyId(db,'unused','unused',[]),/ALLOCATOR_LEGACY_GENERATION_FORBIDDEN/);
});
test('local authority refuses absent migration, changed function and incomplete guards before admission',async()=>{
 const body=readFileSync(new URL('../migrations/014_corporate_authority.sql',import.meta.url),'utf8').split('AS $authority$')[1]!.split('$authority$;')[0];
 for(const fault of ['none','absent','version','function','guard']){
  const db={query:async(sql:string)=>{
   assert(sql.startsWith('SELECT'));
   if(sql.includes('to_regclass(\'olos_http.corporate_authority_contract'))return {rows:[{present:fault!=='absent'}]};
   if(sql.includes('SELECT version'))return {rows:[{version:fault==='version'?1:2}]};
   if(sql.includes('FROM pg_proc'))return {rows:[{prosrc:fault==='function'?'BEGIN RETURN NEW; END':body,prosecdef:false,proconfig:null,lanname:'plpgsql'}]};
   if(sql.includes('FROM pg_trigger'))return {rowCount:fault==='guard'?0:1};
   assert.fail(sql);
  }} as unknown as PoolClient;
  if(fault==='none')await assertAllocationSchema(db);
  else await assert.rejects(assertAllocationSchema(db),/ALLOCATOR_AUTHORITY_MIGRATION_REQUIRED|ALLOCATOR_LOCAL_CONTRACT_CHANGED/);
 }
});
test('reservation responses cannot substitute identities, duplicate members, omit tokens or exceed int32',async()=>{
 const token='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
 const input=[{source_key:'source',source_id:'1',source_hash:hash,request_id:token,payload:{}}];
 const cfg={binding:'b'.repeat(64)} as DeliveryConfig;
 const valid={id:'17',token,reserved_source_id:'1',reserved_source_hash:hash};
 for(const rows of [[],[valid,valid],[{...valid,reserved_source_id:'2'}],[{...valid,reserved_source_hash:'c'.repeat(64)}],[{...valid,token:null}],[{...valid,id:'2147483648'}]]){
  const db={query:async()=>({rows})} as unknown as Client;
  await assert.rejects(reserveIds(db,cfg,input,false));
 }
 const db={query:async(_sql:string,args:unknown[])=>{assert.equal(args[1],JSON.stringify(input));return {rows:[valid]};}} as unknown as Client;
 assert.deepEqual(await reserveIds(db,cfg,input,false),[{id:'17',token}]);
});
