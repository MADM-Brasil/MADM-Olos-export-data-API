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
import {matches,lockCorporateCalls} from '../src/corporate-delivery/contract.js';
import {admissionHash} from '../src/corporate-delivery/allocator.js';
import {verifyPending,recoverCollision} from '../src/corporate-delivery/recovery.js';
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

test('legacy delivery recovery uses existing UNIQUE with no corporate DDL and preserves 010/011/014 history',{skip:!enabled},async t=>{
 const pool=new pg.Pool({connectionString:url}),db=await pool.connect(),remote=new pg.Client({connectionString:destination});await remote.connect();
 const dir=await mkdtemp(join(tmpdir(),'authority-flow-'));
 const base={DATABASE_URL:url,OLOS_SOURCE_KEY:'authority-flow',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-01-01T00:00:00Z',CAPTURE_SPOOL_DIRECTORY:dir,BATCH_SIZE:'2'};
 const cfg=config({...base,ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:destination,OLOS_CORPORATE_CA_FILE:process.env.OLOS_DIRECT_TEST_CA_FILE!,
  OLOS_CORPORATE_WRITE_ENABLED:'true',OLOS_CORPORATE_WRITE_CONFIRMATION:'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY',OLOS_CORPORATE_MAX_FAILURES:'5',OLOS_CORPORATE_BACKOFF_MS:'1',
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
  const before=await snapshot();
  await t.test('014 blocks the old path; 015 is an idempotent forward transition preserving history',async()=>{
   const blocked=new Store(cfg);try{await assert.rejects(blocked.open(),/LEGACY_RECOVERY_TRANSITION_REQUIRED/);}finally{await blocked.close();}
   await db.query('ALTER TABLE raw.olos_calls DISABLE TRIGGER corporate_authority_only');
   try{await assert.rejects(migration('015_corporate_legacy_recovery.sql'),/LEGACY_RECOVERY_LOCAL_CONTRACT_CHANGED/);}
   finally{await db.query('ROLLBACK');await db.query('ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER corporate_authority_only');}
   assert.equal((await db.query("SELECT to_regclass('olos_http.corporate_legacy_recovery') IS NULL AS absent")).rows[0].absent,true);
   await migration('015_corporate_legacy_recovery.sql');
   const transition=(await db.query('SELECT * FROM olos_http.corporate_legacy_recovery')).rows;
   await migration('015_corporate_legacy_recovery.sql');
   assert.deepEqual((await db.query('SELECT * FROM olos_http.corporate_legacy_recovery')).rows,transition);
   assert.deepEqual(await snapshot(),before);
   assert.equal((await remote.query("SELECT to_regnamespace('olos_delivery_ids') IS NULL AS absent")).rows[0].absent,true);
   await assert.rejects(db.query("UPDATE olos_http.corporate_control SET id_allocator_required=true"),/LEGACY_RECOVERY_AUTHORITY_FROZEN/);
   await assert.rejects(db.query("UPDATE olos_http.corporate_id_allocator SET state='adopting'"),/LEGACY_RECOVERY_AUTHORITY_FROZEN/);
  });
  await reopen();
  const release=async()=>{
   const proof=await verifyPending(db,dc,source,target);
   await recoverCollision(db,dc,source,target,{source,verification:proof.verification_digest,requestId:randomUUID(),evidence:'SYNTHETIC-RELEASE',action:'release'});
   await store!.delivery!.resume(db);
  };
  await release();await store!.delivery!.tick(); // Original unambiguous pending call.
  const entry=async(sourceId:string)=>(await db.query<{target_id:string;payload:Row;state:string;payload_hash:string}>(
   'SELECT target_id::text,payload,state,payload_hash FROM olos_http.corporate_outbox WHERE source_id=$1',[sourceId])).rows[0]!;
  await t.test('new allocation skips occupied corporate IDs and preserves frozen IDs on replay',async()=>{
   const next=(await db.query('SELECT (last_value+1)::text id FROM raw.olos_calls_internal_id_olos_seq')).rows[0].id;
   await insert({...confirmed,internal_id_olos:next,olos_call_id:'occupied-before-allocation'});
   await capture([4]);const queued=await entry('4');assert.notEqual(queued.target_id,next);
   assert.equal(queued.state,'pending');await store!.delivery!.tick();assert.equal((await entry('4')).state,'confirmed');
   const count=(await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n;
   await capture([4]);await store!.delivery!.tick();assert.deepEqual(await entry('4'),{...queued,state:'confirmed'});
   assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,count);
   await assert.rejects(db.query("UPDATE olos_http.records SET target_id=999999 WHERE source_id='4'"),/LEGACY_RECOVERY_MAPPING_IMMUTABLE/);
   await assert.rejects(db.query("UPDATE olos_http.corporate_outbox SET state='pending',confirmed_at=NULL,remote_raw_id=NULL WHERE source_id='4'"),/LEGACY_RECOVERY_MAPPING_IMMUTABLE/);
  });
  await t.test('concurrent local allocator instances use distinct candidates and local locks',async()=>{
   const {lockLegacyIdSpace,nextAvailableLegacyId}=await import('../src/corporate-delivery/legacy-sequence.js');
   const allocate=async()=>{const client=await pool.connect();try{
    await client.query('BEGIN');const scopes=await lockLegacyIdSpace(client,target);
    const id=await nextAvailableLegacyId(client,remote,'raw.olos_calls_internal_id_olos_seq',target,scopes);
    await client.query('COMMIT');return id;
   }finally{await client.query('ROLLBACK');client.release();}};
   const [a,b]=await Promise.all([allocate(),allocate()]);assert.notEqual(a,b);
  });
  await t.test('external writer winning after allocation blocks delivery without remap or false receipt',async()=>{
   await capture([5]);const queued=await entry('5');await insert({...queued.payload,olos_call_id:'external-race-winner'});
   const count=(await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n;
   await store!.delivery!.tick();assert.deepEqual(await entry('5'),queued);
   assert.equal((await db.query('SELECT blocked,last_code FROM olos_http.corporate_control')).rows[0].last_code,'INTERNAL_ID_COLLISION');
   assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,count);
   await assert.rejects(insert(queued.payload),error=>error instanceof pg.DatabaseError&&error.code==='23505');
   const proof=await verifyPending(db,dc,source,target);
   await recoverCollision(db,dc,source,target,{source,verification:proof.verification_digest,requestId:randomUUID(),evidence:'SYNTHETIC-RACE',action:'quarantine'},{},true);
   await release();
  });
  await t.test('failure before COMMIT rolls back and retries the same frozen ID',async()=>{
   await capture([6]);const queued=await entry('6');
   await store!.delivery!.tick({beforeRemoteCommit:async()=>{throw Object.assign(new Error('synthetic serialization failure'),{code:'40001'});}});
   assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls WHERE internal_id_olos=$1',[queued.target_id])).rows[0].n,0);
   assert.deepEqual(await entry('6'),queued);
   await new Promise(resolve=>setTimeout(resolve,20));await store!.delivery!.tick();
   assert.deepEqual(await entry('6'),{...queued,state:'confirmed'});
  });
  await t.test('unknown COMMIT blocks automatic retries; explicit reconciliation survives restart',async()=>{
   await capture([7]);const queued=await entry('7');
   await store!.delivery!.tick({afterRemoteCommit:async()=>{throw new Error('synthetic lost ACK');}});
   const control=(await db.query('SELECT blocked,last_code,delivery_uncertain_ids FROM olos_http.corporate_control')).rows[0];
   assert.deepEqual(control,{blocked:true,last_code:'CORPORATE_COMMIT_UNKNOWN',delivery_uncertain_ids:['7']});
   assert.deepEqual(await entry('7'),queued);
   await reopen();await store!.delivery!.tick();assert.deepEqual(await entry('7'),queued);
   await store!.delivery!.resume(db);assert.deepEqual(await entry('7'),queued); // Read-only proof, not a receipt.
   await store!.delivery!.tick();assert.deepEqual(await entry('7'),{...queued,state:'confirmed'});
   assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls WHERE internal_id_olos=$1',[queued.target_id])).rows[0].n,1);
  });
  await t.test('table lock fences external writers through comparison and COMMIT',async()=>{
   await capture([8]);const other=new pg.Client({connectionString:destination,lock_timeout:100});await other.connect();
   try{await store!.delivery!.tick({beforeRemoteCommit:async()=>{
    await assert.rejects(other.query('INSERT INTO raw.olos_calls(internal_id_olos,olos_call_id) VALUES(1999999,$1)',['external-blocked']),error=>error instanceof pg.DatabaseError&&error.code==='55P03');
   }});}finally{await other.end();}
   assert.equal((await entry('8')).state,'confirmed');
  });
  await t.test('ambiguous identities block without selecting a principal or assigning another ID',async()=>{
   const payload={...confirmed,internal_id_olos:'2000000',olos_call_id:'external-ambiguous'};
   await assert.rejects(matches(remote,[payload],schema.shape,dc),/AMBIGUOUS_LOGICAL_IDENTITY/);
   await db.query('BEGIN');
   try{await assert.rejects(store!.delivery!.enqueue(db,'raw.olos_calls_internal_id_olos_seq',[
    mapRecord({...record(9),CallId:'external-ambiguous',OriginalPhoneNumber:record(1).OriginalPhoneNumber},cache,'UTC',true)
   ]),/AMBIGUOUS_LOGICAL_IDENTITY/);}finally{await db.query('ROLLBACK');}
   assert.equal((await db.query("SELECT count(*)::int n FROM olos_http.records WHERE source_id='9'")).rows[0].n,0);
  });
  await t.test('pause and restart preserve confirmed history, quarantines, reversions and guards',async()=>{
   await store!.delivery!.pause(db);await capture([10]);await store!.delivery!.tick();assert.equal((await entry('10')).state,'pending');
   await reopen();await store!.delivery!.tick();assert.equal((await entry('10')).state,'pending');
   const current=await snapshot();
   assert.deepEqual(current.records,before.records);assert.deepEqual(current.confirmed,before.confirmed);
   assert.deepEqual(current.reversions,before.reversions);assert.deepEqual(current.reversionBatches,before.reversionBatches);
   assert.deepEqual(current.remote,before.remote);assert.deepEqual(current.quarantine.slice(0,1),before.quarantine);
   await assert.rejects(db.query("DELETE FROM olos_http.corporate_collision_quarantine WHERE source_id='2'"),/IMMUTABLE/);
   await store!.delivery!.resume(db);await store!.delivery!.tick();assert.equal((await entry('10')).state,'confirmed');
  });
  await t.test('another worker cannot acquire the source while the owner is active',async()=>{
   const contender=new Store(cfg);try{await assert.rejects(contender.open(),/CONSUMER_ALREADY_ACTIVE/);}finally{await contender.close();}
  });
  await t.test('MADM outage preserves journal and checkpoints until the same capture can drain',async()=>{
   await reopen({...cfg,corporateDelivery:{...dc,connection:{...dc.connection,destinationUrl:'postgresql://postgres@localhost:1/madm'}}});
   await assert.rejects(capture([12]));
   assert.equal((await db.query("SELECT count(*)::int n FROM olos_http.records WHERE source_id='12'")).rows[0].n,0);
   const read=(await db.query("SELECT id,processed_count,state FROM olos_http.reads WHERE source_key=$1 ORDER BY started_at DESC LIMIT 1",[source])).rows[0];
   assert.equal(read.processed_count,0);assert.equal(read.state,'received');
   await reopen();await store!.drain(cache);await store!.delivery!.tick();assert.equal((await entry('12')).state,'confirmed');
   assert.equal((await db.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[read.id])).rows[0].processed_count,1);
  });
  await t.test('lost session during COMMIT with no remote row cannot be resumed or reallocated',async()=>{
   await capture([11]);const queued=await entry('11');
   await store!.delivery!.tick({beforeRemoteCommit:async()=>{
    const victims=(await remote.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE datname='madm' AND application_name='corporate-sync' AND xact_start IS NOT NULL")).rows;
    assert.equal(victims.length,1);await remote.query('SELECT pg_terminate_backend($1)',[victims[0]!.pid]);
   }});
   assert.equal((await db.query('SELECT last_code FROM olos_http.corporate_control')).rows[0].last_code,'CORPORATE_COMMIT_UNKNOWN');
   await reopen();await assert.rejects(store!.delivery!.resume(db),/CORPORATE_COMMIT_RECONCILIATION_REQUIRED/);
   await store!.delivery!.tick();assert.deepEqual(await entry('11'),queued);
   assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls WHERE internal_id_olos=$1',[queued.target_id])).rows[0].n,0);
  });
  await t.test('waiting for another writer establishes the SERIALIZABLE snapshot only after its commit',async()=>{
   const waiting=new pg.Client({connectionString:destination}),writer=new pg.Client({connectionString:destination});
   await waiting.connect();await writer.connect();
   try{
    const pid=(await waiting.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    const expected=(await entry('11')).payload;
    await writer.query('BEGIN');
    const concurrent={...expected,internal_id_olos:'2000002'};
    await writer.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(key=>concurrent[key]));
    await waiting.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const check=lockCorporateCalls(waiting).then(()=>matches(waiting,[expected],schema.shape,dc));
    const rejection=assert.rejects(check,/LOGICAL_CALL_AT_DIFFERENT_ID/);
    let blocked=false;
    for(let n=0;n<100&&!blocked;n++){
     blocked=(await remote.query<{blocked:boolean}>("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;
     if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    await writer.query('COMMIT');await rejection;assert(blocked);
   }finally{await waiting.query('ROLLBACK');await writer.query('ROLLBACK');await waiting.end();await writer.end();}
  });
 }finally{await store?.close();db.release(true);await pool.end();await remote.end();await rm(dir,{recursive:true,force:true});}
});
