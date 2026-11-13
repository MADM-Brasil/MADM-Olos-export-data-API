import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './corporate-sync.fixture.js';
import {columns,digest,mapRow,projection,type Row} from '../src/corporate-sync/mapping.js';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {mapRecord} from '../src/mapping.js';
import {matches} from '../src/corporate-delivery/contract.js';
import {admissionHash,adoptAllocator} from '../src/corporate-delivery/allocator.js';
import {verifyPending,recoverCollision} from '../src/corporate-delivery/recovery.js';
import {prepareCorporateReadoption,validateReadoption,activateReadoption} from '../src/corporate-delivery/readoption.js';
import {revertAllocator} from '../src/corporate-delivery/legacy-recovery.js';
import {captureToDisk} from '../src/capture-spool.js';
import {Worker} from '../src/worker.js';
import {OlosApi} from '../src/api.js';
import {OlosAuthManager} from '../src/auth.js';
import {StaticCache} from '../src/cache.js';

const enabled=process.env.OLOS_DIRECT_DISPOSABLE_TEST==='true';
const url=process.env.TEST_DATABASE_URL!,destination=process.env.OLOS_DIRECT_TEST_DESTINATION_URL!;
if(enabled&&(new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_homolog'
 ||new URL(destination).hostname!=='localhost'||new URL(destination).pathname!=='/madm'))throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cache={users:new Map([['7','Agent']]),campaigns:new Map([['8','Campaign']]),dispositions:new Map([['9','Disposition']])};
const record=(id:number)=>({AttemptsRawDataID:String(id),CallId:`call-${id}`,AgentId:'7',CampaignId:'8',DispositionId:'9',StartDate:'2026-10-01T10:00:00Z',OriginalPhoneNumber:String(id).padStart(11,'0')});

test('one authority from preserved legacy/reversion through streaming, admissions, reservation, outbox and acknowledged receipt',{skip:!enabled},async t=>{
 const pool=new pg.Pool({connectionString:url}),db=await pool.connect(),remote=new pg.Client({connectionString:destination});await remote.connect();
 const dir=await mkdtemp(join(tmpdir(),'authority-flow-'));
 const base={DATABASE_URL:url,OLOS_SOURCE_KEY:'authority-flow',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-01-01T00:00:00Z',CAPTURE_SPOOL_DIRECTORY:dir,BATCH_SIZE:'2'};
 const cfg=config({...base,ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:destination,OLOS_CORPORATE_CA_FILE:process.env.OLOS_DIRECT_TEST_CA_FILE!,
  OLOS_CORPORATE_WRITE_ENABLED:'true',OLOS_CORPORATE_WRITE_CONFIRMATION:'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY',OLOS_CORPORATE_MAX_FAILURES:'1',OLOS_CORPORATE_BACKOFF_MS:'1',
  OLOS_CORPORATE_LEGACY_BINDING:'c'.repeat(64),OLOS_CORPORATE_LEGACY_EXPECTED_COUNT:'1',OLOS_CORPORATE_RECONCILE_CONFIRMATION:'AUTHORIZE_CORPORATE_STATE_RECONCILIATION',OLOS_CORPORATE_BATCH_SIZE:'2'});
 const dc=cfg.corporateDelivery!,source=cfg.sourceKey,target='"raw"."olos_calls"';let store:Store|undefined;
 const migration=async(file:string)=>db.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const reopen=async(options=cfg)=>{await store?.close();store=new Store(options);await store.open();};
 const snapshot=async()=>({records:(await db.query('SELECT * FROM olos_http.records WHERE source_id IN (\'1\',\'2\',\'3\') ORDER BY source_id')).rows,
  confirmed:(await db.query("SELECT * FROM olos_http.corporate_outbox WHERE source_id='1'")).rows,
  quarantine:(await db.query('SELECT * FROM olos_http.corporate_collision_quarantine')).rows,
  reversions:(await db.query('SELECT * FROM olos_http.corporate_id_reversions')).rows,
  reversionBatches:(await db.query('SELECT * FROM olos_http.corporate_id_reversion_batches')).rows,
  remote:(await remote.query('SELECT to_jsonb(d) d FROM raw.olos_calls d WHERE olos_call_id IN ($1,$2,$3) ORDER BY internal_id_olos',[record(1).CallId,'somebody-elses-call','external-ambiguous'])).rows});
 async function capture(ids:number[],attributes:Partial<ReturnType<typeof record>>={}){
  const request=async(path:string,fields?:Record<string,string>)=>{
   if(path==='/api/auth')return '{"access_token":"synthetic","token_type":"bearer","expires_in":3600}';
   if(path.endsWith('/available-tables'))return JSON.stringify([
    {TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
    {TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}]);
   if(path.endsWith('/read-data'))return fields?.TableName==='Users'?'[{"AgentId":"7","UserName":"Agent"}]':fields?.TableName==='Campaign'?'[{"CampaignId":"8","Description":"Campaign"}]':'[{"DispositionId":"9","Description":"Disposition"}]';
   throw new Error('Unexpected HTTP/buffered capture');
  };
  const api=new OlosApi(request,new OlosAuthManager(request,{username:'test',password:'test',clientId:'test',clientSecret:'test'}),undefined,
   async(path,_fields,_token,id)=>{assert(path.endsWith('/read-data-current-day'));async function* body(){yield Buffer.from(JSON.stringify(ids.map(value=>({...record(value),...attributes}))));}return captureToDisk(body(),dir,id,cfg.captureMaxBytes);});
  // captureOnce does not kick delivery; drain is the existing checkpoint/outbox path.
  const id=await new Worker(store!,api,new StaticCache(api,3600000)).captureOnce();await store!.drain(cache);return id;
 }
 try{
  await db.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE; DROP SCHEMA IF EXISTS corporate_sync CASCADE');
  await remote.query('DROP SCHEMA IF EXISTS olos_delivery_ids CASCADE; DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE');
  await db.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));await migration('001_ingestion.sql');await migration('012_capture_spool.sql');await remote.query(fixture(false));
  // Historical fixture: calls captured before corporate authority was installed.
  await reopen(config(base));await capture([1,2,3]);await store!.close();store=undefined;
  for(const file of ['corporate-sync/001_control.sql','002_corporate_delivery.sql','003_corporate_outbox_skipped.sql','005_corporate_campaign_policy.sql','006_corporate_collision_recovery.sql','007_corporate_collision_quarantine.sql'])await migration(file);
  const {corporateSchema}=await import('../src/corporate-delivery/contract.js');const schema=await corporateSchema(remote,dc,false);
  // Legacy IDs belong to the persisted mapping, not to input order or source_id.
  const projected=projection(schema.shape,'s',true,dc.connection),n=projected.parameters.length;
  const history=(await db.query<Row & {source_id:string}>(`SELECT r.source_id,${projected.sql}
    FROM olos_http.records r JOIN raw.olos_calls s ON s.internal_id_olos=r.target_id
    WHERE r.source_key=$${n+1} AND r.target_table=$${n+2} ORDER BY r.source_id`,[...projected.parameters,source,target])).rows;
  assert.deepEqual(history.map(row=>row.source_id),['1','2','3']);
  const [confirmed,colliding,reverted]=history.map(row=>mapRow(row,schema.shape,dc.connection));
  assert(confirmed&&colliding&&reverted);
  const insert=async(value:Row)=>remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(key=>value[key]));
  await insert(confirmed);await db.query('INSERT INTO corporate_sync.receipts(internal_id_olos,payload_hash) VALUES($1,$2)',[confirmed.internal_id_olos,digest(confirmed)]);
  await db.query('INSERT INTO corporate_sync.control(singleton,binding,confirmed_count) VALUES(true,$1,1)',[dc.legacyBinding]);
  await reopen();await store!.reconcileCorporate();await store!.close();store=undefined;
  await insert({...colliding,olos_call_id:'somebody-elses-call'});
  // Unrelated corporate history must not prevent installation or new, distinct calls.
  await insert({...confirmed,internal_id_olos:'2000000',olos_call_id:'external-ambiguous'});
  await insert({...confirmed,internal_id_olos:'2000001',olos_call_id:'external-ambiguous'});
  await t.test('a genuinely divergent historical identity still raises INTERNAL_ID_COLLISION',async()=>{
   await assert.rejects(matches(remote,[colliding],schema.shape,dc),/INTERNAL_ID_COLLISION/);
  });
  await db.query("UPDATE olos_http.corporate_control SET paused=true,blocked=true,last_code='INTERNAL_ID_COLLISION' WHERE singleton");
  const verification=await verifyPending(db,dc,source,target);
  assert.deepEqual(verification.issues.map(issue=>({target_id:issue.target_id,code:issue.code})),[{target_id:colliding.internal_id_olos,code:'INTERNAL_ID_COLLISION'}]);
  await recoverCollision(db,dc,source,target,{source,verification:verification.verification_digest,requestId:randomUUID(),evidence:'SYNTHETIC-COLLISION',action:'quarantine'},{},true);
  await migration('008_corporate_id_allocator.sql');await migration('009_corporate_allocator_reversion.sql');
  // Restored historical evidence, not a new execution of the prohibited legacy allocator.
  const adoption=randomUUID(),reversion='138fd602-7838-4662-bc48-04fe71746979',oldRequest=randomUUID();
  const mapped=mapRecord(record(3),cache,'UTC',true),mappedHash=admissionHash(mapped),validation=hash('synthetic-old-validation');
  const member={source_id:'3',source_hash:mapped.source_hash,request_id:oldRequest,mapped_hash:mappedHash};
  await db.query("INSERT INTO olos_http.corporate_id_allocator(source_key,binding,target_table,request_id,evidence_ref,state) VALUES($1,$2,$3,$4,'SYNTHETIC-OLD','legacy')",[source,dc.binding,target,adoption]);
  await db.query('INSERT INTO olos_http.corporate_id_admissions(source_key,source_id,source_hash,request_id,mapped,mapped_hash,materialized) VALUES($1,$2,$3,$4,$5,$6,true)',[source,'3',mapped.source_hash,oldRequest,JSON.stringify(mapped),mappedHash]);
  await db.query(`INSERT INTO olos_http.corporate_id_reversions(request_id,source_key,target_table,binding,adoption_request_id,sequence_name,evidence_ref,state,
    initial_manifest,initial_digest,initial_count,materialized_count,batch_count,previous_generation,previous_blocked,previous_confirmed_count,completed_at,validated_at,validation_digest)
    VALUES($1,$2,$3,$4,$5,'raw.olos_calls_internal_id_olos_seq','SYNTHETIC-REVERSAL','completed',$6,$7,1,1,1,0,true,1,now(),now(),$8)`,[reversion,source,target,dc.binding,adoption,JSON.stringify([member]),hash([[member.source_id,member.source_hash,member.request_id,member.mapped_hash]]),validation]);
  await db.query('INSERT INTO olos_http.corporate_id_reversion_batches(request_id,batch_no,members,member_count) VALUES($1,1,$2,1)',[reversion,JSON.stringify([{...member,target_id:reverted.internal_id_olos,payload_hash:digest(reverted)}])]);
  await db.query(`INSERT INTO olos_http.corporate_collision_recoveries(request_id,source_key,target_table,binding,verification_digest,evidence_ref,previous_generation,previous_code,pending_count,eligible_count,existing_count,schema_hash)
    VALUES($1,$2,$3,$4,$5,'SYNTHETIC-OLD-VALIDATION',0,'INTERNAL_ID_COLLISION',2,1,0,$6)`,[randomUUID(),source,target,dc.binding,validation,schema.hash]);
  await migration('010_corporate_allocator_readoption.sql');await migration('011_corporate_readoption_activation.sql');await migration('014_corporate_authority.sql');
  const before=await snapshot();await reopen();
  await t.test('restart accepts the two canonical local guards and rejects a disabled authority guard',async()=>{
   await store!.close();store=undefined;
   await db.query('ALTER TABLE raw.olos_calls DISABLE TRIGGER corporate_authority_only');
   const probe=new Store(cfg);
   try{await assert.rejects(probe.open(),/ALLOCATOR_LOCAL_CONTRACT_CHANGED/);}
   finally{await probe.close();await db.query('ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER corporate_authority_only');}
   await reopen();assert.deepEqual(await snapshot(),before);
  });
  const req={source,requestId:randomUUID(),evidence:'SYNTHETIC-NEW-GENERATION'};
  await t.test('legacy captures queue without an ID; the old generation cannot be reactivated',async()=>{
   const sequence=(await db.query('SELECT last_value,is_called FROM raw.olos_calls_internal_id_olos_seq')).rows;
   const read=await capture([4,5]);assert.equal((await db.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[read])).rows[0].processed_count,2);
   assert.equal((await db.query("SELECT count(*)::int n FROM olos_http.records WHERE source_id IN ('4','5')")).rows[0].n,0);
   assert.deepEqual((await db.query('SELECT last_value,is_called FROM raw.olos_calls_internal_id_olos_seq')).rows,sequence);
   await assert.rejects(adoptAllocator(db,dc,source,target,{source,requestId:adoption,evidence:'SYNTHETIC-OLD'}),/ALLOCATOR_ADOPTION_REVERTED/);
   await assert.rejects(store!.delivery!.resume(db),/ALLOCATOR_ADOPTION_INCOMPLETE/);
  });
  await t.test('new generation validates the preserved reversal; absent authority blocks before registration',async()=>{
   await prepareCorporateReadoption(db,req,dc.binding,target,dc);
   await assert.rejects(validateReadoption(db,dc,target,req),/READOPTION_REMOTE_AUTHORITY_ABSENT/);
   await remote.query(await readFile(new URL('../migrations/corporate/002_identity_authority.sql',import.meta.url),'utf8'));
   await validateReadoption(db,dc,target,req);assert.deepEqual(await snapshot(),before);
  });
  const activation=async()=>({...req,validation:(await db.query('SELECT validation_digest FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1',[req.requestId])).rows[0].validation_digest as string,maxBatches:1});
  await t.test('lost registration ACK and process restart keep the generation and the same reserved IDs',async()=>{
   const query=db.query.bind(db);let lost=false;
   db.query=(async(sql:string,parameters?:unknown[])=>{const result=await query(sql,parameters);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('synthetic barrier ACK lost');}return result;}) as typeof query;
   try{await assert.rejects(activateReadoption(db,dc,target,await activation()),/READOPTION_COMMIT_UNKNOWN/);assert(lost);}finally{db.query=query;}
   await assert.rejects(activateReadoption(db,dc,target,await activation(),{afterReserveCommit:async()=>{throw new Error('synthetic ACK lost');}}),/synthetic ACK lost/);
   await reopen();assert.equal((await db.query('SELECT id_allocator_generation FROM olos_http.corporate_control')).rows[0].id_allocator_generation,req.requestId);
   await activateReadoption(db,dc,target,{...await activation(),maxBatches:10},{},true);
   assert.equal((await db.query('SELECT state FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1',[req.requestId])).rows[0].state,'active');
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('pause prevents reservations; materialization COMMIT uncertainty retains the durable request',async()=>{
   const reservations=(await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
   await store!.delivery!.tick();assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows,reservations);
   await assert.rejects(store!.delivery!.resume(db),/CORPORATE_DELIVERY_BLOCKED/);
   const proof=await verifyPending(db,dc,source,target);
   await recoverCollision(db,dc,source,target,{source,verification:proof.verification_digest,requestId:randomUUID(),evidence:'SYNTHETIC-RELEASE',action:'release'});
   await store!.delivery!.resume(db);
   await store!.delivery!.tick({afterReserveCommit:async()=>{throw new Error('synthetic process loss after reserve commit');}});
   const saved=(await remote.query('SELECT internal_id,token,request_id FROM olos_delivery_ids.registry WHERE source_id IN (\'4\',\'5\') ORDER BY internal_id')).rows;assert.equal(saved.length,2);
   assert.equal((await db.query("SELECT count(*)::int n FROM olos_http.records WHERE source_id IN ('4','5')")).rows[0].n,0);
   await reopen();await store!.delivery!.tick();
   assert.deepEqual((await remote.query('SELECT internal_id,token,request_id FROM olos_delivery_ids.registry WHERE source_id IN (\'4\',\'5\') ORDER BY internal_id')).rows,saved);
  });
  await t.test('unknown delivery COMMIT blocks and reconciles exact remote rows without another INSERT',async()=>{
   await store!.delivery!.tick({afterRemoteCommit:async()=>{throw new Error('synthetic ACK loss');}});
   const state=(await db.query('SELECT blocked,last_code FROM olos_http.corporate_control')).rows[0];assert.equal(state.blocked,true);assert.equal(state.last_code,'CORPORATE_COMMIT_UNKNOWN');
   const count=(await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n;
   await store!.delivery!.tick();assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,count);
   await store!.delivery!.resume(db);await store!.delivery!.tick();assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,count);
   assert.equal((await db.query("SELECT count(*)::int n FROM olos_http.corporate_outbox WHERE state='confirmed'")).rows[0].n,4);
  });
  await t.test('quarantine, confirmed receipts, old references and reversal evidence survive; rollback cannot restore legacy',async()=>{
   assert.deepEqual(await snapshot(),before);
   assert.equal((await db.query("SELECT state FROM olos_http.corporate_outbox WHERE source_id='2'")).rows[0].state,'pending');
   await assert.rejects(db.query('UPDATE olos_http.corporate_control SET id_allocator_required=false'),/IRREVERSIBLE/);
   await assert.rejects(db.query("UPDATE olos_http.records SET target_id=9000 WHERE source_id='2'"),/HISTORY_FROZEN/);
   await assert.rejects(db.query("DELETE FROM olos_http.corporate_collision_quarantine WHERE source_id='2'"),/IMMUTABLE|HISTORY_FROZEN/);
   await assert.rejects(revertAllocator(db,cfg,store!.delivery!,{source,adoptionId:adoption,requestId:reversion,evidence:'SYNTHETIC-REVERSAL',maxBatches:1}),/REVERSION_EVIDENCE_CHANGED/);
   const second=new Store(cfg);try{await assert.rejects(second.open(),/CONSUMER_ALREADY_ACTIVE/);}finally{await second.close();}
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('MADM outage leaves capture and admissions durable without creating a local ID',async()=>{
   await capture([6]);const pending=(await db.query("SELECT request_id,mapped_hash FROM olos_http.corporate_id_admissions WHERE source_id='6'")).rows;
   await reopen({...cfg,corporateDelivery:{...dc,connection:{...dc.connection,destinationUrl:'postgresql://postgres@localhost:1/madm'}}});
   await store!.delivery!.tick();assert.deepEqual((await db.query("SELECT request_id,mapped_hash FROM olos_http.corporate_id_admissions WHERE source_id='6'")).rows,pending);
   assert.equal((await db.query("SELECT count(*)::int n FROM olos_http.records WHERE source_id='6'")).rows[0].n,0);
   await reopen();await store!.delivery!.tick();assert.equal((await db.query("SELECT state FROM olos_http.corporate_outbox WHERE source_id='6'")).rows[0].state,'confirmed');
  });
  await t.test('an ambiguous historical identity cannot materialize, deliver or gain a receipt after restart',async()=>{
   await capture([7],{CallId:'external-ambiguous',OriginalPhoneNumber:record(1).OriginalPhoneNumber});
   const admission=(await db.query("SELECT * FROM olos_http.corporate_id_admissions WHERE source_id='7'")).rows;
   const registry=(await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
   for(let attempt=0;attempt<2;attempt++){
    await store!.delivery!.tick();
    assert.deepEqual((await db.query("SELECT * FROM olos_http.corporate_id_admissions WHERE source_id='7'")).rows,admission);
    for(const table of ['records','corporate_outbox','corporate_id_assignments']){
     assert.equal((await db.query(`SELECT count(*)::int n FROM olos_http.${table} WHERE source_id='7'`)).rows[0].n,0);
    }
    assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows,registry);
    assert.deepEqual(await snapshot(),before);
    if(attempt===0)await reopen();
   }
  });
 }finally{await store?.close();db.release(true);await pool.end();await remote.end();await rm(dir,{recursive:true,force:true});}
});
