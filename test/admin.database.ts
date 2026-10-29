import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { AdminRepository } from '../src/admin/repository.js';
import { createScheduledConsumer } from '../src/admin/consumer.js';
import { config } from '../src/config.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('Use scripts/test-admin.sh');
const parsed=new URL(url);
if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/olos_admin_homolog')throw new Error('Disposable test database required');
const pool=new pg.Pool({connectionString:url});const repositories:AdminRepository[]=[];
const migration=await readFile(new URL('../admin/migrations/002_worker_administration.sql',import.meta.url),'utf8');
const cfg=config({DATABASE_URL:url,OLOS_SOURCE_KEY:'olos-admin-homolog',POLL_INTERVAL_MS:'120000',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-10-01T00:00:00Z'});
const snapshot=async()=>({revision:0,credentials:{baseUrl:'https://fixture.invalid/WebApiExportData',username:'fixture',password:'fixture',clientId:'fixture',clientSecret:'fixture'}});
async function repo(initial:'RUNNING'|'PAUSED'|'STOPPED'='STOPPED',ms=120000){const r=new AdminRepository(url!,'olos-admin-homolog');repositories.push(r);await r.open(ms,initial);return r;}
async function close(r:AdminRepository){repositories.splice(repositories.indexOf(r),1);await r.close();}
before(async()=>{
  await pool.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../migrations/001_ingestion.sql',import.meta.url),'utf8'));
  await pool.query(migration);
});
beforeEach(async()=>{await pool.query('TRUNCATE olos_http.admin_audit,olos_http.admin_credentials,olos_http.worker_settings,olos_http.reads,olos_http.records,raw.olos_calls');});
afterEach(async()=>{for(const r of repositories.splice(0))await r.close();});
after(async()=>{await pool.end();});

test('initial env interval seeded only once; restart never overwrites saved settings',async()=>{
  const r=await repo('RUNNING');assert.equal((await r.settings()).interval_ms,120000);
  await r.change('admin:ana',{interval_ms:300000,mode:'PAUSED'});await r.state('PAUSED');await close(r);
  const next=await repo('RUNNING',60000);const saved=await next.settings();
  assert.equal(saved.interval_ms,300000);assert.equal(saved.desired_state,'PAUSED');assert.equal(saved.updated_by,'admin:ana');
});
test('incremental migration is idempotent and preserves configuration and audit',async()=>{
  const r=await repo();await r.change('admin:ana',{interval_ms:180000});await r.saveCredentials('admin:ana',0,'fixture-encrypted');
  const before=(await r.auditLog()).length;await pool.query(migration);await pool.query(migration);
  assert.equal((await r.settings()).interval_ms,180000);assert.equal((await r.credentials())!.encrypted_payload,'fixture-encrypted');assert.equal((await r.auditLog()).length,before);
});
test('only one scheduler owner can hold the administrative lock',async()=>{
  await repo();const other=new AdminRepository(url!,'olos-admin-homolog');
  try{await assert.rejects(other.open(120000,'RUNNING'),/SCHEDULER_ALREADY_ACTIVE/);}finally{await other.close();}
});
test('voluntary stop survives restart and unexpected exit is ERROR, not STOPPED',async()=>{
  const r=await repo('RUNNING');await r.change('admin:ana',{mode:'STOPPED'});await r.state('STOPPED');await close(r);
  const next=await repo('RUNNING');assert.equal((await next.settings()).enabled,false);assert.equal((await next.settings()).runtime_state,'STOPPED');
  await next.change('admin:ana',{mode:'RUNNING'});await next.state('RUNNING');await close(next);
  const crashed=await repo();assert.equal((await crashed.settings()).runtime_state,'ERROR');assert.equal((await crashed.settings()).last_error,'UNCLEAN_SCHEDULER_EXIT');
});
test('schedule write and administrator audit roll back atomically',async()=>{
  const r=await repo();await pool.query(`CREATE FUNCTION olos_http.test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;
    CREATE TRIGGER test_fail_audit BEFORE INSERT ON olos_http.admin_audit FOR EACH ROW EXECUTE FUNCTION olos_http.test_fail_audit()`);
  try{await assert.rejects(r.change('admin:ana',{interval_ms:300000}));assert.equal((await r.settings()).interval_ms,120000);}
  finally{await pool.query('DROP TRIGGER test_fail_audit ON olos_http.admin_audit; DROP FUNCTION olos_http.test_fail_audit()');}
});
test('credentials updates use revision CAS and never silently overwrite concurrent edits',async()=>{
  const r=await repo();const results=await Promise.allSettled([r.saveCredentials('admin:ana',0,'encrypted-A'),r.saveCredentials('admin:bob',0,'encrypted-B')]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await r.credentials())!.revision,1);
  assert.equal((await r.auditLog()).length,1);assert.doesNotMatch(JSON.stringify(await r.auditLog()),/encrypted-A|encrypted-B/);
});
test('late test result cannot certify a newer credential revision',async()=>{
  const r=await repo();await r.saveCredentials('admin:ana',0,'first');await r.saveCredentials('admin:ana',1,'second');
  await r.tested('admin:ana',1,true,'CONNECTION_OK',10);assert.equal((await r.credentials())!.last_test_ok,null);
  await r.tested('admin:ana',2,true,'CONNECTION_OK',20);assert.equal((await r.credentials())!.last_test_ms,20);
  await r.tested('admin:ana',0,false,'HTTP_401',30);assert.equal((await r.lastEnvironmentTest())!.code,'HTTP_401');
});
test('log endpoint query exposes only operational metadata, never response data',async()=>{
  const r=await repo();await pool.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,response_body,state) VALUES
    ('00000000-0000-0000-0000-000000000001','olos-admin-homolog','"raw"."olos_calls"','{"kind":"current"}','PRIVATE_PHONE_PASSWORD','received')`);
  const rows=await r.logs();assert.equal(rows.length,1);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_PHONE_PASSWORD|response_body/);
});
test('database constraints reject intervals outside range and incoherent enabled state',async()=>{
  await repo();await assert.rejects(pool.query("UPDATE olos_http.worker_settings SET interval_ms=59999 WHERE source_key='olos-admin-homolog'"));
  await assert.rejects(pool.query("UPDATE olos_http.worker_settings SET enabled=true WHERE source_key='olos-admin-homolog'"));
});
test('real Store rejects pending captured response before opening HTTP',async()=>{
  await pool.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,response_body,state) VALUES
    ('00000000-0000-0000-0000-000000000001','olos-admin-homolog','"raw"."olos_calls"','{"kind":"current"}','[]','received')`);
  let loaded=0;await assert.rejects(createScheduledConsumer(cfg,async()=>{loaded++;return snapshot();}),/RECOVERY_REQUIRED/);assert.equal(loaded,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
});
test('real source advisory lock prevents two consumer instances',async()=>{
  const first=await createScheduledConsumer(cfg,snapshot);
  try{await assert.rejects(createScheduledConsumer(cfg,snapshot),/CONSUMER_ALREADY_ACTIVE/);}finally{await first.close();}
});
test('dashboard separates database validity, pending reads, unmeasured history and confirmed empty cycles',async()=>{
  const r=await repo();let view=await r.observation();
  assert.equal(view.database.reachable,true);assert.equal(view.database.schema_valid,true);assert.equal(view.ingestion.status,'NOT_OBSERVED');
  const id='00000000-0000-0000-0000-000000000001';
  await pool.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,response_body,state,processed_count,received_count,finished_at)
    VALUES($1,'olos-admin-homolog','"raw"."olos_calls"','{"kind":"current"}','[]','done',0,0,clock_timestamp())`,[id]);
  view=await r.observation();assert.equal(view.ingestion.status,'CONFIRMED');assert.equal(view.ingestion.last_completed.inserted,null);
  await r.cycleCompleted({read_id:id,received:0,inserted:0,updated:0,duplicates:0,request_ms:3,persistence_ms:2,duration_ms:5});
  view=await r.observation();assert.equal(view.ingestion.last_completed.inserted,0);assert.equal(view.ingestion.last_completed.duplicates,0);assert.equal(view.ingestion.last_completed.duration_ms,5);
  await pool.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES('00000000-0000-0000-0000-000000000002','olos-admin-homolog','"raw"."olos_calls"','{"kind":"current"}')`);
  view=await r.observation();assert.equal(view.ingestion.status,'PENDING');assert.deepEqual(view.ingestion.pending,[{state:'reading',count:1}]);
  await assert.rejects(r.cycleCompleted({read_id:'00000000-0000-0000-0000-000000000002',received:1,inserted:1,updated:0,duplicates:0,request_ms:1,persistence_ms:1,duration_ms:2}),/CYCLE_PERSISTENCE_UNCONFIRMED/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
});
test('dashboard does not claim valid schema when destination is missing and still reports local pending evidence',async()=>{
  const r=await repo();await pool.query('ALTER TABLE raw.olos_calls RENAME TO missing_fixture');
  try{const view=await r.observation();assert.equal(view.database.reachable,true);assert.equal(view.database.schema_valid,false);assert.equal(view.ingestion.status,'NOT_OBSERVED');}
  finally{await pool.query('ALTER TABLE raw.missing_fixture RENAME TO olos_calls');}
});
