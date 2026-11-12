import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from '../src/worker.js';
import {OlosApi} from '../src/api.js';
import {OlosAuthManager} from '../src/auth.js';
import {StaticCache} from '../src/cache.js';
import {WorkerError} from '../src/errors.js';
import {Store} from '../src/store.js';
import {captureToDisk} from '../src/capture-spool.js';
import {config} from '../src/config.js';
import {historicalRead} from '../src/capture-continuity.js';
import {createScheduledConsumer} from '../src/admin/consumer.js';
const url=process.env.TEST_DATABASE_URL!;
if(process.env.OLOS_DIRECT_DISPOSABLE_TEST!=='true'||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_homolog')throw new Error('DISPOSABLE_DATABASE_REQUIRED');
test('continuity authorization and admission without any HTTP capture',async t=>{
 const db=new pg.Client({connectionString:url});await db.connect();const dir=await mkdtemp(join(tmpdir(),'continuity-'));
 const cfg=config({DATABASE_URL:url,OLOS_SOURCE_KEY:'olos-production',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',CAPTURE_SPOOL_DIRECTORY:dir,SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-01-01T00:00:00Z'});
 let store:Store;
 async function open(){store=new Store(cfg);await store.open();}
 const parent=async()=> (await db.query('SELECT to_jsonb(r) AS r FROM olos_http.reads r WHERE id=$1',[historicalRead])).rows[0].r;
 async function consent(){return {authorizationId:randomUUID(),parentHash:(await store.inspectContinuity()).parent_hash,actor:'synthetic-operator',evidenceRef:'SYNTHETIC-TICKET',evidenceSha256:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z',acceptedHistoricalGap:true,remoteOperationSettled:true,cursorAssessment:'NO_KNOWN_UNSAFE_CURSOR_OR_UNCONTROLLED_OVERLAP'};}
 try{
  await db.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE; DROP SCHEMA IF EXISTS corporate_sync CASCADE');
  await db.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  for(const name of ['001_ingestion.sql','012_capture_spool.sql'])await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await open();await db.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,state,error_code) VALUES($1,$2,$3,$4,'reading','RESPONSE_TOO_LARGE')`,[historicalRead,cfg.sourceKey,store!.target,{kind:'current',recovery_authorization:{manifest:{version:2,mode:'progressive'},evidence:'preserve'}}]);
  const before=await parent();
  await t.test('missing migration and missing authorization block without touching history',async()=>{
   assert.equal((await store.capturePending()).length,1);await assert.rejects(store.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
   await db.query(await readFile(new URL('../migrations/013_capture_continuity.sql',import.meta.url),'utf8'));
   assert.equal((await store.capturePending()).length,1);assert.deepEqual(await parent(),before);
  });
  const approval=await consent();
  await t.test('unsafe cursor, unsettled request, stale evidence and expired consent cannot authorize',async()=>{
   for(const patch of [{cursorAssessment:'UNSAFE'},{remoteOperationSettled:false},{parentHash:'f'.repeat(64)},{expiresAt:'2000-01-01T00:00:00.000Z'}])await assert.rejects(store.authorizeContinuity({...approval,...patch}));
   assert.equal((await store.capturePending()).length,1);
  });
  await t.test('lost authorization COMMIT acknowledgement is reconciled by identical request',async()=>{
   const query=store.client!.query.bind(store.client!);
   store.client!.query=(async(sql:string,p?:unknown[])=>{const r=await query(sql,p);if(sql==='COMMIT')throw new Error('synthetic ACK lost');return r;}) as typeof query;
   await assert.rejects(store.authorizeContinuity(approval),/CONTINUITY_COMMIT_UNKNOWN/);store.client!.query=query;
   await store.authorizeContinuity(approval);await assert.rejects(store.authorizeContinuity({...approval,evidenceRef:'OTHER'}),/CONTINUITY_REQUEST_REUSED/);
   assert.equal((await store.capturePending()).length,0);assert.deepEqual(await parent(),before);
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
  await t.test('changed parent or a parent spool file blocks; audit is immutable and revocation survives restart',async()=>{
   await db.query("UPDATE olos_http.reads SET error_code='CURSOR_UNSAFE' WHERE id=$1",[historicalRead]);await assert.rejects(store.capturePending(),/CONTINUITY_PARENT_CHANGED/);
   await db.query("UPDATE olos_http.reads SET error_code='RESPONSE_TOO_LARGE' WHERE id=$1",[historicalRead]);
   const file=join(dir,historicalRead+'.json');await writeFile(file,'[]');await assert.rejects(store.capturePending(),/CONTINUITY_PARENT_HAS_FILE/);await rm(file);
   await assert.rejects(db.query("UPDATE olos_http.capture_continuity SET consent='{}'"),/CONTINUITY_AUDIT_IMMUTABLE/);
   await store.revokeContinuity(approval.authorizationId);await store.close();await open();assert.equal((await store.capturePending()).length,1);
   await assert.rejects(store.authorizeContinuity(approval),/CONTINUITY_AUTHORIZATION_REVOKED/);assert.equal((await store.capturePending()).length,1);assert.deepEqual(await parent(),before);
  });
  await t.test('an expired persisted authorization stays blocked after restart and cannot be renewed by replay',async()=>{
   const expired={...approval,authorizationId:randomUUID(),expiresAt:'2001-01-01T00:00:00.000Z'};
   // Fixture represents a once-valid authorization; avoid wall-clock sleeps or modifying immutable audit rows.
   await db.query(`INSERT INTO olos_http.capture_continuity(authorization_id,source_key,parent_id,target_table,binding,parent_hash,consent,approved_at,expires_at)
     SELECT $1,source_key,parent_id,target_table,binding,parent_hash,$2,'2000-01-01T00:00:00Z',$3 FROM olos_http.capture_continuity WHERE authorization_id=$4`,
     [expired.authorizationId,JSON.stringify(expired),expired.expiresAt,approval.authorizationId]);
   await store.close();await open();assert.equal((await store.capturePending()).length,1);
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
 }finally{await store!?.close();await db.end();await rm(dir,{recursive:true,force:true});}
});
