import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture,row} from './corporate-sync.fixture.js';
import {columns,type Row} from '../src/corporate-sync/mapping.js';
import {allocatorContract} from '../src/corporate-delivery/allocator-contract.js';
import {corporateSchema,matches} from '../src/corporate-delivery/contract.js';
import {deliveryConfig} from '../src/corporate-delivery/config.js';

const destination=process.env.OLOS_DIRECT_TEST_DESTINATION_URL!;
const enabled=process.env.OLOS_DIRECT_DISPOSABLE_TEST==='true';
if(enabled&&(new URL(destination).hostname!=='localhost'||new URL(destination).pathname!=='/madm'))throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const ddl=await readFile(new URL('../migrations/corporate/002_identity_authority.sql',import.meta.url),'utf8');
const binding='a'.repeat(64),source='synthetic-authority';
const payload=(name:string,id='1')=>({...row(id),olos_call_id:name});
const request=(name:string)=>({source_key:source,source_id:name,source_hash:'b'.repeat(64),request_id:randomUUID(),payload:payload(name)});
async function reserve(db:pg.Client,items:unknown[],legacy=false){return (await db.query('SELECT id::text,reservation_token::text AS token FROM olos_delivery_ids.reserve($1,$2,$3)',[binding,JSON.stringify(items),legacy])).rows;}
async function insert(db:pg.Client,value:Row){return db.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING raw_olos_call_id::text`,columns.map(key=>value[key]));}
test('corporate authority v2 in isolated PostgreSQL: occupied IDs, external writers, concurrency, identity and uncertain commit',{skip:!enabled},async t=>{
 const db=new pg.Client({connectionString:destination}),other=new pg.Client({connectionString:destination});await db.connect();await other.connect();
 const reset=async()=>{await db.query('DROP SCHEMA IF EXISTS olos_delivery_ids CASCADE; DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE');await db.query(fixture(false));};
 try{
  await reset();await insert(db,payload('occupied','1'));const historical=(await db.query('SELECT to_jsonb(d) AS d FROM raw.olos_calls d')).rows;
  await db.query(ddl);await allocatorContract(db);
  await t.test('an occupied destination ID is skipped; replay returns exactly the same durable token',async()=>{
   const item=request('new');const first=await reserve(db,[item]);assert.equal(first[0].id,'2');assert(first[0].token);
   assert.deepEqual(await reserve(other,[item]),first);
   await assert.rejects(reserve(db,[{...item,payload:payload('changed')}]),/ALLOCATOR_REQUEST_CONFLICT/);
   assert.deepEqual((await db.query('SELECT to_jsonb(d) AS d FROM raw.olos_calls d')).rows,historical);
  });
  await t.test('two instances cannot assign different IDs to the same source or identity',async()=>{
   const item=request('concurrent');const [a,b]=await Promise.all([reserve(db,[item]),reserve(other,[item])]);assert.deepEqual(a,b);
   const result=await Promise.allSettled([reserve(db,[request('distinct-a')]),reserve(other,[request('distinct-b')])]);assert(result.every(r=>r.status==='fulfilled'));
   const ids=result.map(r=>r.status==='fulfilled'?r.value[0].id:null);assert.notEqual(ids[0],ids[1]);
   await assert.rejects(reserve(db,[{...request('other-source'),payload:item.payload}]),/LOGICAL_CALL_AT_DIFFERENT_ID/);
  });
  await t.test('external explicit IDs participate atomically and cannot steal a reservation',async()=>{
   await db.query('CREATE ROLE authority_external_writer NOLOGIN');
   await db.query('GRANT USAGE ON SCHEMA raw,core TO authority_external_writer; GRANT INSERT,SELECT ON raw.olos_calls TO authority_external_writer; GRANT USAGE ON ALL SEQUENCES IN SCHEMA raw TO authority_external_writer');
   await other.query('SET SESSION AUTHORIZATION authority_external_writer');
   try{
   const item=request('owned'),[assignment]=await reserve(db,[item]);
   await assert.rejects(insert(other,payload('foreign',assignment.id)),/ALLOCATOR_ID_NOT_OWNED/);
   await db.query('BEGIN');await db.query("SELECT set_config('olos_delivery_ids.token',$1,true)",[assignment.token]);
   await assert.rejects(insert(db,payload('wrong-identity',assignment.id)),/ALLOCATOR_ID_NOT_OWNED|LOGICAL_CALL_AT_DIFFERENT_ID/);await db.query('ROLLBACK');
   const id=(await db.query('SELECT next_candidate::text id FROM olos_delivery_ids.counter')).rows[0].id;
   const external=insert(other,payload('external-racer',id));
   const allocation=reserve(db,[request('worker-racer')]);const results=await Promise.allSettled([external,allocation]);
   assert.equal(results[1].status,'fulfilled');
   if(results[0].status==='fulfilled'&&results[1].status==='fulfilled')assert.notEqual(results[1].value[0].id,id);
   if(results[0].status==='rejected')assert.match(String(results[0].reason),/ALLOCATOR_ID_NOT_OWNED/);
   }finally{await other.query('RESET SESSION AUTHORIZATION');}
  });
  await t.test('rollback creates no assignment; lost COMMIT ACK reuses the original reservation',async()=>{
   const rolled=request('rolled');await db.query('BEGIN');await reserve(db,[rolled]);await db.query('ROLLBACK');
   assert.equal((await db.query('SELECT count(*)::int n FROM olos_delivery_ids.identities WHERE source_id=$1',[rolled.source_id])).rows[0].n,0);
   const item=request('ack-lost');await db.query('BEGIN');const saved=await reserve(db,[item]);await db.query('COMMIT');
   // Simulated process loss after commit: a different connection reconciles the durable request.
   assert.deepEqual(await reserve(other,[item]),saved);
   const wrong={...item,request_id:randomUUID()};await assert.rejects(reserve(other,[wrong]),/ALLOCATOR_REQUEST_CONFLICT/);
  });
  await t.test('timeout behind an in-flight reservation cannot claim its ID; session loss rolls back atomically',async()=>{
   const first=request('lock-holder'),second=request('lock-waiter');
   await db.query('BEGIN');const [held]=await reserve(db,[first]);
   await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='50ms'");
   try{await assert.rejects(reserve(other,[second]),(error:unknown)=>(error as {code:string}).code==='55P03');}
   finally{await other.query('ROLLBACK');await db.query('COMMIT');}
   const [next]=await reserve(other,[second]);assert.notEqual(next.id,held.id);
   assert.deepEqual(await reserve(other,[first]),[held]);
   const disconnected=new pg.Client({connectionString:destination});await disconnected.connect();
   const item=request('connection-lost');
   try{await disconnected.query('BEGIN');await reserve(disconnected,[item]);}finally{await disconnected.end();}
   assert.equal((await db.query('SELECT count(*)::int n FROM olos_delivery_ids.identities WHERE source_id=$1',[item.source_id])).rows[0].n,0);
   const saved=await reserve(db,[item]);assert.deepEqual(await reserve(other,[item]),saved);
  });
  await t.test('reservation token authorizes only its immutable identity; existing-call comparison remains possible',async()=>{
   const item=request('delivery'),[assignment]=await reserve(db,[item]);await db.query('BEGIN');
   await db.query("SELECT set_config('olos_delivery_ids.token',$1,true)",[assignment.token]);await insert(db,payload('delivery',assignment.id));await db.query('COMMIT');
   assert.deepEqual(await reserve(other,[item]),[assignment]);
   await assert.rejects(insert(other,payload('delivery','2000000')),/LOGICAL_CALL_AT_DIFFERENT_ID/);
   await assert.rejects(db.query("UPDATE raw.olos_calls SET olos_call_id='different' WHERE internal_id_olos=$1",[assignment.id]),/ALLOCATOR_IDENTITY_IMMUTABLE/);
   await assert.rejects(db.query('UPDATE raw.olos_calls SET internal_id_olos=2000001 WHERE internal_id_olos=$1',[assignment.id]),/ALLOCATOR_IDENTITY_IMMUTABLE/);
   assert.equal((await db.query('SELECT state FROM olos_delivery_ids.registry WHERE internal_id=$1',[assignment.id])).rows[0].state,'used');
   await assert.rejects(reserve(db,[{...request('old-occupied'),id:'1'}],true),/INTERNAL_ID_COLLISION/);
  });
  await t.test('changed or disabled guards fail the contract check',async()=>{
   await db.query('ALTER TABLE raw.olos_calls DISABLE TRIGGER trg_olos_calls_reserve_internal_id');
   await assert.rejects(allocatorContract(db),/ALLOCATOR_CONTRACT_CHANGED/);
   await db.query('ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER trg_olos_calls_reserve_internal_id');await allocatorContract(db);
  });
  await t.test('duplicate history installs without choosing an owner; reservations, recognition and inserts stay blocked',async()=>{
   await reset();await insert(db,payload('duplicate','1'));await insert(db,payload('duplicate','2'));
   await insert(db,payload('duplicate-null','3'));await insert(db,{...payload('duplicate-null'),internal_id_olos:null});
   await insert(db,{...payload('all-null'),internal_id_olos:null});await insert(db,{...payload('all-null'),internal_id_olos:null});
   const before=(await db.query('SELECT to_jsonb(d) d FROM raw.olos_calls d ORDER BY raw_olos_call_id')).rows;
   await db.query(ddl);await allocatorContract(db);
   assert.deepEqual((await db.query("SELECT internal_id,state FROM olos_delivery_ids.registry ORDER BY internal_id")).rows,
    [1,2,3].map(internal_id=>({internal_id,state:'used'})));
   const cfg=deliveryConfig({DATABASE_URL:process.env.OLOS_DIRECT_TEST_SOURCE_URL,OLOS_CORPORATE_DATABASE_URL:destination,ATTEMPTS_PERSISTENCE_MODE:'corporate'});
   assert(cfg);const schema=await corporateSchema(db,cfg,false);
   for(const name of ['duplicate','duplicate-null','all-null']){
    const members=(await db.query<{id:string}>('SELECT raw_olos_call_id::text id FROM raw.olos_calls WHERE olos_call_id=$1 ORDER BY raw_olos_call_id',[name])).rows.map(r=>r.id);
    const group=(await db.query('SELECT internal_id,used_raw_id,source_key,source_id,ambiguous_raw_ids FROM olos_delivery_ids.identities WHERE identity->>0=$1',[name])).rows;
    assert.deepEqual(group,[{internal_id:null,used_raw_id:null,source_key:null,source_id:null,ambiguous_raw_ids:members}]);
    const item=request(name);
    await assert.rejects(reserve(db,[item]),/AMBIGUOUS_LOGICAL_IDENTITY/);
    await assert.rejects(reserve(db,[{...item,id:'1'}],true),/AMBIGUOUS_LOGICAL_IDENTITY/);
    await assert.rejects(reserve(db,[{...item,id:'1',isolated:true}],true),/AMBIGUOUS_LOGICAL_IDENTITY/);
    await assert.rejects(matches(db,[item.payload],schema.shape,cfg),/AMBIGUOUS_LOGICAL_IDENTITY/);
    await assert.rejects(insert(other,payload(name,'100')),/AMBIGUOUS_LOGICAL_IDENTITY/);
   }
   // Even when a disposable transaction hides one member, the durable marker
   // must prevent an implicit resolution. No historical deletion is committed.
   await db.query('BEGIN');
   try{
    await db.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=2');
    await assert.rejects(matches(db,[payload('duplicate')],schema.shape,cfg),/AMBIGUOUS_LOGICAL_IDENTITY/);
   }finally{await db.query('ROLLBACK');}
   assert.deepEqual((await db.query('SELECT to_jsonb(d) d FROM raw.olos_calls d ORDER BY raw_olos_call_id')).rows,before);
   const item=request('distinct-after-ambiguity');const saved=await reserve(db,[item]);assert.equal(saved[0].id,'4');
   assert.deepEqual(await reserve(other,[item]),saved);
   assert.equal((await db.query('SELECT count(*)::int n FROM olos_delivery_ids.identities WHERE source_id IS NOT NULL')).rows[0].n,1);
  });
  await t.test('a historical call with a NULL internal ID still owns its logical identity',async()=>{
   await reset();const p=payload('null-internal');
   await db.query('INSERT INTO raw.olos_calls(olos_call_id,data_ligacao,telefone,id_campanha_olos) VALUES($1,$2,$3,$4)',[p.olos_call_id,p.data_ligacao,p.telefone,p.id_campanha_olos]);
   await db.query(ddl);await allocatorContract(db);
   await assert.rejects(reserve(db,[{...request('same-null-call'),payload:p}]),/LOGICAL_CALL_AT_DIFFERENT_ID/);
   assert.equal((await db.query('SELECT internal_id_olos FROM raw.olos_calls')).rows[0].internal_id_olos,null);
  });
  await t.test('identity equality using a nondeterministic collation blocks installation',async()=>{
   await reset();await db.query("CREATE COLLATION raw.case_insensitive (provider=icu,locale='und-u-ks-level2',deterministic=false)");
   await db.query('ALTER TABLE raw.olos_calls ALTER COLUMN olos_call_id TYPE text COLLATE raw.case_insensitive');
   await assert.rejects(db.query(ddl),/ALLOCATOR_IDENTITY_COLLATION_UNSUPPORTED/);await db.query('ROLLBACK');
   assert.equal((await db.query("SELECT to_regnamespace('olos_delivery_ids') IS NULL AS absent")).rows[0].absent,true);
  });
  await t.test('v1 reservations block upgrade and preserve their unknown outcomes',async()=>{
   await reset();await db.query(await readFile(new URL('../migrations/corporate/001_id_allocator.sql',import.meta.url),'utf8'));
   await reserve(db,[{source_id:'v1',source_hash:'b'.repeat(64),request_id:randomUUID()}]);
   const before=(await db.query('SELECT * FROM olos_delivery_ids.registry')).rows;
   await assert.rejects(db.query(ddl),/ALLOCATOR_EXISTING_AUTHORITY_REQUIRES_RECONCILIATION/);await db.query('ROLLBACK');
   assert.deepEqual((await db.query('SELECT * FROM olos_delivery_ids.registry')).rows,before);
   assert.equal((await db.query("SELECT to_regclass('olos_delivery_ids.identities') IS NULL AS absent")).rows[0].absent,true);
  });
  await t.test('100000 occupied IDs are bootstrapped in SQL and allocation remains bounded',async()=>{
   await reset();await db.query(`INSERT INTO raw.olos_calls(internal_id_olos,olos_call_id,data_ligacao,telefone,id_campanha_olos)
    SELECT n,'historical-'||n,'2026-01-01T00:00:00Z','5500000000000','7' FROM generate_series(1,100000) n`);
   const started=performance.now();await db.query(ddl);const [assigned]=await reserve(db,[request('after-volume')]);
   assert.equal(assigned.id,'100001');assert.equal((await db.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,100000);
   console.log(JSON.stringify({synthetic:true,occupied:100000,duration_ms:Math.round(performance.now()-started),max_rss_kib:process.resourceUsage().maxRSS}));
  });
 }finally{await db.end();await other.end();}
});
