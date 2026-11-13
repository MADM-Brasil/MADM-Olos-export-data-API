import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from '../src/worker.js';
import {OlosApi,type CaptureTransport} from '../src/api.js';
import {OlosAuthManager} from '../src/auth.js';
import {StaticCache} from '../src/cache.js';
import {WorkerError} from '../src/errors.js';
import {Store} from '../src/store.js';
import {captureToDisk} from '../src/capture-spool.js';
import {config} from '../src/config.js';
import {historicalRead} from '../src/capture-continuity.js';
import {createScheduledConsumer} from '../src/admin/consumer.js';
import {fixture} from './corporate-sync.fixture.js';
const url=process.env.TEST_DATABASE_URL!;
if(process.env.OLOS_DIRECT_DISPOSABLE_TEST!=='true'||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_homolog')throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const cache={users:new Map([['7','Synthetic Agent']]),campaigns:new Map([['8','Campaign']]),dispositions:new Map([['9','Disposition']])};
function syntheticWorker(store:Store,capture:CaptureTransport){
 const request=async(path:string,fields?:Record<string,string>)=>{
  if(path==='/api/auth')return JSON.stringify({access_token:'synthetic',token_type:'bearer',expires_in:3600});
  if(path.endsWith('/available-tables'))return JSON.stringify([
   {TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
   {TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}]);
  if(path.endsWith('/read-data')){
   if(fields?.TableName==='Users')return '[{"AgentId":"7","UserName":"Synthetic Agent"}]';
   if(fields?.TableName==='Campaign')return '[{"CampaignId":"8","Description":"Campaign"}]';
   if(fields?.TableName==='Disposition')return '[{"DispositionId":"9","Description":"Disposition"}]';
  }
  throw new Error('Unexpected request or buffered capture');
 };
 const api=new OlosApi(request,new OlosAuthManager(request,{username:'synthetic',password:'synthetic',clientId:'synthetic',clientSecret:'synthetic'}),undefined,capture);
 return new Worker(store,api,new StaticCache(api,3600000));
}
for(const corporate of [false,true])test(`continuity authorization and admission without HTTP capture (corporate=${corporate})`,async t=>{
 const db=new pg.Client({connectionString:url});await db.connect();const dir=await mkdtemp(join(tmpdir(),'continuity-'));
 const destination=process.env.OLOS_DIRECT_TEST_DESTINATION_URL!;
 if(corporate){assert.equal(new URL(destination).hostname,'localhost');assert.equal(new URL(destination).pathname,'/madm');}
 const remote=corporate?new pg.Client({connectionString:destination}):undefined;
 const cfg=config({DATABASE_URL:url,OLOS_SOURCE_KEY:'olos-production',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',CAPTURE_SPOOL_DIRECTORY:dir,SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-01-01T00:00:00Z',BATCH_SIZE:'2',...(corporate?{
  ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:destination,OLOS_CORPORATE_CA_FILE:process.env.OLOS_DIRECT_TEST_CA_FILE!,
  OLOS_CORPORATE_WRITE_ENABLED:'false',OLOS_CORPORATE_LEGACY_BINDING:'a'.repeat(64),OLOS_CORPORATE_LEGACY_EXPECTED_COUNT:'0',OLOS_CORPORATE_RECONCILE_CONFIRMATION:'AUTHORIZE_CORPORATE_STATE_RECONCILIATION',
 }:{})});
 let store:Store;
 async function open(){store=new Store(cfg);await store.open();}
 const parent=async()=> (await db.query('SELECT to_jsonb(r) AS r FROM olos_http.reads r WHERE id=$1',[historicalRead])).rows[0].r;
 async function consent(){return {version:2,authorizationId:randomUUID(),parentHash:(await store.inspectContinuity()).parent_hash,actor:'synthetic-operator',evidenceRef:'SYNTHETIC-TICKET',evidenceSha256:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z',acceptedHistoricalGap:true,remoteOperationSettled:false,cursorAssessment:'UNKNOWN',acceptedUnknownCursorRisk:true,acceptedUnreconciledOperationRisk:true};}
 async function schedulerBlocked(){
  await store.close();await assert.rejects(createScheduledConsumer(cfg,async()=>{throw new Error('Must block before credentials or HTTP');}),/RECONCILIATION_REQUIRED/);await open();
 }
 try{
  await db.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE; DROP SCHEMA IF EXISTS corporate_sync CASCADE');
  await db.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  for(const name of ['001_ingestion.sql','012_capture_spool.sql'])await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  if(remote){
   await remote.connect();
   for(const file of ['corporate-sync/001_control.sql','002_corporate_delivery.sql','003_corporate_outbox_skipped.sql','005_corporate_campaign_policy.sql','006_corporate_collision_recovery.sql','007_corporate_collision_quarantine.sql'])await db.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
   await remote.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS olos_delivery_ids CASCADE');await remote.query(fixture(false));
   await db.query('INSERT INTO corporate_sync.control(singleton,binding,confirmed_count) VALUES(true,$1,0)',[cfg.corporateDelivery!.legacyBinding]);
  }
  await open();if(corporate)await store!.reconcileCorporate();
  await db.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,state,error_code) VALUES($1,$2,$3,$4,'reading','RESPONSE_TOO_LARGE')`,[historicalRead,cfg.sourceKey,store!.target,{kind:'current',recovery_authorization:{manifest:{version:2,mode:'progressive'},evidence:'preserve'}}]);
  const before=await parent();
  await t.test('missing migration and missing authorization block without touching history',async()=>{
   assert.equal((await store.capturePending()).length,1);await assert.rejects(store.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
   await db.query(await readFile(new URL('../migrations/013_capture_continuity.sql',import.meta.url),'utf8'));
   assert.equal((await store.capturePending()).length,1);assert.deepEqual(await parent(),before);
  });
  const approval=await consent();
  await t.test('missing risk acceptance, false safety claims, stale evidence and expired consent cannot authorize',async()=>{
   for(const patch of [{cursorAssessment:'UNSAFE'},{remoteOperationSettled:true},{acceptedUnknownCursorRisk:false},{acceptedUnreconciledOperationRisk:false},{parentHash:'f'.repeat(64)},{expiresAt:'2000-01-01T00:00:00.000Z'}])await assert.rejects(store.authorizeContinuity({...approval,...patch}));
   assert.equal((await store.capturePending()).length,1);
  });
  await t.test('lost authorization COMMIT acknowledgement is reconciled by identical request',async()=>{
   const query=store.client!.query.bind(store.client!);
   store.client!.query=(async(sql:string,p?:unknown[])=>{const r=await query(sql,p);if(sql==='COMMIT')throw new Error('synthetic ACK lost');return r;}) as typeof query;
   await assert.rejects(store.authorizeContinuity(approval),/CONTINUITY_COMMIT_UNKNOWN/);store.client!.query=query;
   await store.authorizeContinuity(approval);await assert.rejects(store.authorizeContinuity({...approval,evidenceRef:'OTHER'}),/CONTINUITY_REQUEST_REUSED/);
   assert.deepEqual((await db.query('SELECT consent FROM olos_http.capture_continuity WHERE authorization_id=$1',[approval.authorizationId])).rows[0].consent,approval);
   assert.equal((await store.capturePending()).length,0);assert.deepEqual(await parent(),before);
  });
  await t.test('continuity only admits current, never previous or an unauthorized reread',async()=>{
   await assert.rejects(store.beginRead({kind:'previous'}),/RECOVERY_REQUIRED/);
   await assert.rejects(store.beginRead({kind:'reread',date:'2026-01-01',start:'1',end:'2'}),/RECOVERY_AUTHORIZATION_REQUIRED/);
   assert.equal((await db.query('SELECT count(*)::int n FROM olos_http.reads')).rows[0].n,1);
  });
  await t.test('Worker passes the authorized gate but creates no intent when authentication fails',async()=>{
   const request=async(path:string):Promise<string>=>{assert.equal(path,'/api/auth');throw new WorkerError('SYNTHETIC_AUTH_STOP');};
   const api=new OlosApi(request,new OlosAuthManager(request,{username:'synthetic',password:'synthetic',clientId:'synthetic',clientSecret:'synthetic'}),undefined,async()=>{throw new Error('Capture must never be invoked');});
   await assert.rejects(new Worker(store,api,new StaticCache(api,3600000)).captureOnce(),/SYNTHETIC_AUTH_STOP/);
   assert.equal((await db.query('SELECT count(*)::int n FROM olos_http.reads')).rows[0].n,1);assert.deepEqual(await parent(),before);
  });
  await t.test('a parent change between policy evaluation and intent INSERT blocks admission atomically',async()=>{
   const query=store.client!.query.bind(store.client!);let intercepted=false;
   store.client!.query=(async(sql:string,p?:unknown[])=>{
    if(sql.includes('FROM olos_http.capture_continuity a WHERE authorization_id')){
     intercepted=true;await db.query("UPDATE olos_http.reads SET error_code='CURSOR_UNSAFE' WHERE id=$1",[historicalRead]);
    }
    return query(sql,p);
   }) as typeof query;
   try{
    await assert.rejects(store.beginRead({kind:'current'}),/CONTINUITY_ADMISSION_CHANGED/);
    assert(intercepted);assert.equal((await db.query('SELECT count(*)::int n FROM olos_http.reads')).rows[0].n,1);
   }finally{store.client!.query=query;await db.query("UPDATE olos_http.reads SET error_code='RESPONSE_TOO_LARGE' WHERE id=$1",[historicalRead]);}
   assert.deepEqual(await parent(),before);
  });
  await t.test('source lock and admission exclusion prevent competing new intents',async()=>{
   const second=new Store(cfg);try{await assert.rejects(second.open(),/CONSUMER_ALREADY_ACTIVE/);}finally{await second.close();}
   const results=await Promise.allSettled([store.beginRead({kind:'current'}),store.beginRead({kind:'current'})]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const read=(await db.query('SELECT * FROM olos_http.reads WHERE id<>$1',[historicalRead])).rows[0];
   assert.equal(read.spec.continuity.authorization_id,approval.authorizationId);assert.equal(read.spec.capture.storage,'spool');
   assert.equal((await store.capturePending()).length,2);await assert.rejects(store.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
   await store.close();await assert.rejects(createScheduledConsumer(cfg,async()=>{throw new Error('Must block before credentials or HTTP');}),/RECONCILIATION_REQUIRED/);await open();
   async function* body(){yield Buffer.from('[]');}
   await store.registerCaptureSpool(read.id,await captureToDisk(body(),dir,read.id,1024));
   assert.equal((await store.capturePending()).length,2);await assert.rejects(store.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
   await store.drain({users:new Map(),campaigns:new Map(),dispositions:new Map()});assert.equal((await store.capturePending()).length,0);
  });
  await t.test('restart preserves authorization and Admin prepares without reading the API',async()=>{
   await store.close();const consumer=await createScheduledConsumer(cfg,async()=>({revision:1,credentials:{baseUrl:'http://127.0.0.1:1',username:'synthetic',password:'synthetic',clientId:'synthetic',clientSecret:'synthetic'}}));
   await consumer.close();await open();assert.equal((await store.capturePending()).length,0);assert.deepEqual(await parent(),before);
  });
  await t.test('authorized Worker streams, resumes committed checkpoints and keeps frozen corporate outbox entries',async()=>{
   let captures=0;
   const control=corporate?(await db.query('SELECT * FROM olos_http.corporate_control')).rows:[];
   const worker=()=>syntheticWorker(store,async(path,fields,token,id)=>{
    assert.equal(path,'/api/export-data/read-data-current-day');assert.deepEqual(fields,{TableName:'AttemptsRawData'});assert.equal(token,'synthetic');
    const intent=(await db.query('SELECT spec,state,response_body FROM olos_http.reads WHERE id=$1',[id])).rows[0];
    assert.equal(intent.state,'reading');assert.equal(intent.response_body,null);assert.equal(intent.spec.continuity.authorization_id,approval.authorizationId);
    assert.equal(intent.spec.capture.storage,'spool');
    captures++;
    const body=JSON.stringify(Array.from({length:captures===1?5:1},(_,i)=>({AttemptsRawDataID:String(captures===1?i+1:6),CallId:`synthetic-${captures}-${i}`,AgentId:'7',CampaignId:'8',DispositionId:'9',StartDate:'2026-11-12T10:00:00Z',OriginalPhoneNumber:'5500000000000'})));
    async function* chunks(){for(let offset=0;offset<body.length;offset+=17)yield Buffer.from(body.slice(offset,offset+17));}
    return captureToDisk(chunks(),dir,id,cfg.captureMaxBytes);
   });
   const id=await worker().captureOnce();
   const spool=await store.inspectCaptureSpool(id);
   const query=store.client!.query.bind(store.client!);let lost=false;
   store.client!.query=(async(sql:string,p?:unknown[])=>{const result=await query(sql,p);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('synthetic checkpoint ACK lost');}return result;}) as typeof query;
   try{await assert.rejects(store.drain(cache));assert(lost);}finally{store.client!.query=query;}
   const checkpoint=(await db.query('SELECT state,processed_count FROM olos_http.reads WHERE id=$1',[id])).rows[0];
   assert.equal(checkpoint.state,'received');assert.equal(checkpoint.processed_count,2);
   const frozen=corporate?(await db.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows:[];
   if(corporate)assert.equal(frozen.length,2);
   await schedulerBlocked();await assert.rejects(worker().captureOnce(),/RECOVERY_REQUIRED/);assert.equal(captures,1);
   await store.drain(cache); // Explicit local recovery only; never replay the capture.
   assert.equal((await db.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[id])).rows[0].processed_count,5);
   assert.equal((await store.inspectCaptureSpool(id)).sha256,spool.sha256);
   assert.equal((await store.capturePending()).length,0);
   const next=await worker().cycle();assert.equal(captures,2);assert.equal(next.received,1);
   assert.equal((await db.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,6);
   if(remote){
    const outbox=(await db.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows;
    assert.equal(outbox.length,6);assert(outbox.every(row=>row.state==='pending'));assert.deepEqual(outbox.slice(0,2),frozen);
    assert.deepEqual((await db.query('SELECT * FROM olos_http.corporate_control')).rows,control);
    assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
   }
   assert.deepEqual(await parent(),before);
  });
  await t.test('changed parent or a parent spool file blocks; audit is immutable and revocation survives restart',async()=>{
   await db.query("UPDATE olos_http.reads SET error_code='CURSOR_UNSAFE' WHERE id=$1",[historicalRead]);await assert.rejects(store.capturePending(),/CONTINUITY_PARENT_CHANGED/);
   await db.query("UPDATE olos_http.reads SET error_code='RESPONSE_TOO_LARGE' WHERE id=$1",[historicalRead]);
   const file=join(dir,historicalRead+'.json');await writeFile(file,'[]');await assert.rejects(store.capturePending(),/CONTINUITY_PARENT_HAS_FILE/);await rm(file);
   await assert.rejects(db.query("UPDATE olos_http.capture_continuity SET consent='{}'"),/CONTINUITY_AUDIT_IMMUTABLE/);
   await store.revokeContinuity(approval.authorizationId);await store.close();await open();assert.equal((await store.capturePending()).length,1);
   await schedulerBlocked();
   await assert.rejects(store.authorizeContinuity(approval),/CONTINUITY_AUTHORIZATION_REVOKED/);assert.equal((await store.capturePending()).length,1);assert.deepEqual(await parent(),before);
  });
  await t.test('an expired persisted authorization stays blocked after restart and cannot be renewed by replay',async()=>{
   const expired={...approval,authorizationId:randomUUID(),expiresAt:'2001-01-01T00:00:00.000Z'};
   // Fixture represents a once-valid authorization; avoid wall-clock sleeps or modifying immutable audit rows.
   await db.query(`INSERT INTO olos_http.capture_continuity(authorization_id,source_key,parent_id,target_table,binding,parent_hash,consent,approved_at,expires_at)
     SELECT $1,source_key,parent_id,target_table,binding,parent_hash,$2,'2000-01-01T00:00:00Z',$3 FROM olos_http.capture_continuity WHERE authorization_id=$4`,
     [expired.authorizationId,JSON.stringify(expired),expired.expiresAt,approval.authorizationId]);
   await store.close();await open();assert.equal((await store.capturePending()).length,1);
   await schedulerBlocked();
   await assert.rejects(store.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
   await assert.rejects(store.authorizeContinuity(expired),/CONTINUITY_AUTHORIZATION_EXPIRED/);
   await store.revokeContinuity(expired.authorizationId);
   const renewed=await consent();await store.authorizeContinuity(renewed);
   const query=store.client!.query.bind(store.client!);let intercepted=false;
   store.client!.query=(async(sql:string,p?:unknown[])=>{
    if(sql.includes('FROM olos_http.capture_continuity a WHERE authorization_id')){
     intercepted=true;await db.query('UPDATE olos_http.capture_continuity SET revoked_at=clock_timestamp() WHERE authorization_id=$1',[renewed.authorizationId]);
    }
    return query(sql,p);
   }) as typeof query;
   try{await assert.rejects(store.beginRead({kind:'current'}),/CONTINUITY_ADMISSION_CHANGED/);assert(intercepted);}
   finally{store.client!.query=query;}
   assert.deepEqual(await parent(),before);assert.equal((await store.capturePending()).length,1);
  });
  await t.test('an ambiguous streaming failure blocks every subsequent capture and survives restart',async()=>{
   await store.authorizeContinuity(await consent());let captures=0;
   const worker=()=>syntheticWorker(store,async()=>{captures++;throw new WorkerError('SYNTHETIC_STREAM_INTERRUPTED');});
   await assert.rejects(worker().captureOnce(),/RECOVERY_REQUIRED/);
   const pending=await store.unresolved();assert.equal(pending.length,2);
   const uncertain=pending.find(read=>read.id!==historicalRead)!;
   assert.equal(uncertain.state,'reading');assert.equal(uncertain.error_code,'SYNTHETIC_STREAM_INTERRUPTED');assert.equal(uncertain.response_body,null);
   await assert.rejects(worker().captureOnce(),/RECOVERY_REQUIRED/);
   await assert.rejects(store.authorizeContinuity(await consent()),/RECOVERY_REQUIRED/);
   await schedulerBlocked();await assert.rejects(worker().cycle(),/RECOVERY_REQUIRED/);assert.equal(captures,1);
   assert.deepEqual(await parent(),before);
  });
 }finally{await store!?.close();await remote?.end();await db.end();await rm(dir,{recursive:true,force:true});}
});
