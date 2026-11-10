import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { DateTime } from 'luxon';
import { reportHttp } from './fixtures/report-http.js';
import { AdminRepository } from '../src/admin/repository.js';
import { AdminReports } from '../src/admin/reports.js';
import { ReportUpdater } from '../src/admin/report-updater.js';
import { reportWhitespace, reportPlaceholder, reportDataHash, type ReportData, reportValidationMetadata, sealReportData, countFields } from '../src/admin/report-snapshot.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_reports_test')throw new Error('Use disposable scripts/test-admin-reports.sh');
const pool=new pg.Pool({connectionString:url,max:8,statement_timeout:5000});
const source='persistent-fixture',dest={schema:'raw',table:'olos_calls'},target='"raw"."olos_calls"';
const migration=await readFile('admin/migrations/003_report_snapshots.sql','utf8');
const original=await readFile('test/fixtures/admin-reports-before.sql','utf8');
const reader=()=>new AdminReports(pool,source,dest);
const force=()=>pool.query("UPDATE olos_http.report_snapshot_state SET next_attempt_at='-infinity' WHERE source_key=$1",[source]);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const scopes=['summary','period','daily','failed_reads'] as const;
const read=async(r=reader())=>{const result=await r.read('2026-10-01','2026-10-31') as Record<string,unknown>;const {snapshot_age_seconds:age,refresh_state:refresh,last_refresh_error:error,next_refresh_at:next,...stable}=result;return stable;};
function intercept(hook:(sql:string,values:unknown[]|undefined,db:pg.PoolClient)=>Promise<pg.QueryResult|undefined>) {
  return {async connect(){const db=await pool.connect();return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(sql:string,values?:unknown[]){return await hook(sql,values,db)??db.query(sql,values);},release(destroy?:boolean){db.release(destroy);}};}} as unknown as pg.Pool;
}
async function publish(p=pool) {await force();const updater=new ReportUpdater(p,source,dest);try{const result=await updater.refreshOnce();assert.equal(result.state,'published',JSON.stringify(result));return result;}finally{await updater.stop();}}
async function authoritative(){return JSON.stringify((await pool.query(`SELECT
 (SELECT json_agg(r ORDER BY source_key,source_id) FROM olos_http.records r) AS records,
 (SELECT json_agg(o ORDER BY source_key,source_id) FROM olos_http.corporate_outbox o) AS outbox,
 (SELECT json_agg(d ORDER BY internal_id_olos) FROM raw.olos_calls d) AS calls,
 (SELECT json_agg(r ORDER BY id) FROM olos_http.reads r) AS reads`)).rows);}
before(async()=>{
  await pool.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE');
  await pool.query(await readFile('test/fixtures/admin-reports.sql','utf8'));
  await pool.query(migration);await pool.query(migration);
  const rows:[number,string|null,string|null,string|null,string][]=[
    [1,'2026-10-01T02:59:59Z','7','Ana','confirmed'],[2,'2026-10-01T03:00:00Z','7',' João ','confirmed'],
    [3,'2026-11-01T02:59:59Z','9007199254740993','Maria','pending'],[4,null,'7','Ana','pending'],
    [5,'2026-10-15T12:00:00Z','007','Ana','skipped'],[6,'2026-10-15T12:00:00Z','7',' UNKNOWN ','pending'],
    [7,'2026-10-16T12:00:00Z','7','Unknown Silva','none']];
  for(const [id,at,agent,name,state] of rows){
    await pool.query('INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente,cpf,email) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5)',[id,at,name,id===2?'PRIVATE_CPF':null,id===3?'PRIVATE_EMAIL':null]);
    await pool.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,created_at) VALUES($1,$2,$3,$4,repeat('a',64),$5,'2020-01-01')",[source,String(id),target,id,agent]);
    if(state!=='none')await pool.query("INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at) VALUES($1,$2,$3,repeat('a',64),'{\"private\":\"PRIVATE_PAYLOAD\"}',repeat('b',64),$4,'capture',$5,$6)",[source,String(id),id,state,state==='confirmed'?id:null,state==='confirmed'?'2026-11-10T12:00:00Z':null]);
  }
  await pool.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) VALUES($1,'99',$2,99,'missing')",[source,target]);
  await pool.query("INSERT INTO olos_http.reads(id,source_key,target_table,spec,error_code) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'{}','FIXTURE')",[source,target]);
});
after(async()=>{await pool.end();});
test('missing snapshot returns initialization immediately with no synchronous aggregation',async()=>{
  let historical=0;const wrapped=intercept(async sql=>{if(sql.startsWith('WITH classified'))historical++;return undefined;});
  await assert.rejects(new AdminReports(wrapped,source,dest).read('2026-10-01','2026-10-31'),/REPORT_INITIALIZING/);assert.equal(historical,0);
});
test('first publication is exact to the old SQL, contains no private payloads, and never changes authoritative tables',async()=>{
  const before=await authoritative();await publish();
  const expected=(await pool.query(original,[source,'2026-10-01','2026-10-31',reportWhitespace,reportPlaceholder,target])).rows[0];
  const actual=await read();for(const key of scopes)assert.deepEqual(actual[key],expected[key],key);
  assert.equal(await authoritative(),before);
  const snapshot=(await pool.query('SELECT * FROM olos_http.report_snapshots')).rows[0];
  assert.equal(snapshot.status,'published');assert.doesNotMatch(JSON.stringify(snapshot.data),/PRIVATE|João|Unknown Silva|source_id|nome_agente|payload/);
  assert.equal((snapshot.data as ReportData).summary.operators,'2');
  const settings=(await pool.query("SELECT current_setting('work_mem') mem,current_setting('statement_timeout') timeout")).rows[0];
  assert.equal(settings.mem,'4MB');assert.equal(settings.timeout,'5s');
});
test('an HTTP role with access ONLY to snapshots serves periods and today after restart',async()=>{
  await pool.query('CREATE ROLE snapshot_http LOGIN; GRANT USAGE ON SCHEMA olos_http TO snapshot_http; GRANT SELECT ON olos_http.report_snapshots,olos_http.report_snapshot_state TO snapshot_http');
  const u=new URL(url!);u.username='snapshot_http';const httpPool=new pg.Pool({connectionString:u.toString(),max:1});
  try{
    const r=new AdminReports(httpPool,source,dest);
    const independent=new AdminRepository(u.toString(),source,dest);
    try{const result=await independent.reports('2026-10-01','2026-10-31') as Record<string,unknown>;assert.deepEqual(result.summary,(await read()).summary);}finally{await independent.close();}
    assert.deepEqual(await read(r),await read());assert.equal((await r.today()).calls,'1');
    await assert.rejects(httpPool.query('SELECT count(*) FROM olos_http.records'),/permission denied/);
    await assert.rejects(httpPool.query('UPDATE olos_http.report_snapshot_state SET status=\'building\''),/permission denied/);
  }finally{await httpPool.end();}
});
test('a least-privilege analytical updater cannot write ingestion or corporate tables',async()=>{
  await pool.query('CREATE ROLE snapshot_builder LOGIN; GRANT SET ON PARAMETER temp_file_limit TO snapshot_builder; GRANT USAGE ON SCHEMA raw,olos_http TO snapshot_builder; GRANT SELECT ON raw.olos_calls,olos_http.reads,olos_http.records,olos_http.corporate_outbox TO snapshot_builder; GRANT SELECT,INSERT,DELETE ON olos_http.report_snapshots TO snapshot_builder; GRANT SELECT,INSERT,UPDATE ON olos_http.report_snapshot_state TO snapshot_builder');
  const u=new URL(url!);u.username='snapshot_builder';const builder=new pg.Pool({connectionString:u.toString(),max:1,statement_timeout:5000});
  try{await publish(builder);await assert.rejects(builder.query('UPDATE olos_http.records SET agent_id=NULL'),/permission denied/);await assert.rejects(builder.query('DELETE FROM olos_http.corporate_outbox'),/permission denied/);}
  finally{await builder.end();}
});
test('two instances cannot rebuild the same source concurrently; publication stays invisible until COMMIT',async()=>{
  const old=await read(),entered=deferred(),release=deferred();let aggregations=0;
  const priorCount=(await pool.query('SELECT count(*)::int n FROM olos_http.report_snapshots WHERE source_key=$1',[source])).rows[0].n;
  const blocked=intercept(async(sql,values,db)=>{
    if(sql.startsWith('WITH classified'))aggregations++;
    if(sql==='COMMIT'){entered.resolve();await release.promise;}
    return undefined;
  });
  await force();const first=new ReportUpdater(blocked,source,dest),second=new ReportUpdater(pool,source,dest);
  const build=first.refreshOnce();await entered.promise;
  try{
    assert.equal((await second.refreshOnce()).state,'busy');assert.deepEqual(await read(),old);
    assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.report_snapshots WHERE source_key=$1',[source])).rows[0].n,priorCount);
  }finally{release.resolve();}
  assert.equal((await build).state,'published');assert.equal(aggregations,1);await first.stop();await second.stop();
  assert.notEqual((await read() as {snapshot_id?:string}).snapshot_id,(old as {snapshot_id?:string}).snapshot_id);
});
test('different destinations of the same source share the refresh lock, independent sources do not',async()=>{
  const entered=deferred(),release=deferred();
  const blocked=intercept(async sql=>{if(sql.startsWith('WITH classified')){entered.resolve();await release.promise;}return undefined;});
  await force();const first=new ReportUpdater(blocked,source,dest),otherTarget=new ReportUpdater(pool,source,{schema:'other',table:'calls'}),otherSource=new ReportUpdater(pool,'independent',dest);
  const pending=first.refreshOnce();await entered.promise;
  try{assert.equal((await otherTarget.refreshOnce()).state,'busy');assert.equal((await otherSource.refreshOnce()).state,'published');}
  finally{release.resolve();}assert.equal((await pending).state,'published');await Promise.all([first.stop(),otherTarget.stop(),otherSource.stop()]);
});
test('failure before publication rolls back all derived rows and preserves the last valid pointer',async()=>{
  const before=await read(),count=(await pool.query('SELECT count(*)::int n FROM olos_http.report_snapshots WHERE source_key=$1',[source])).rows[0].n;
  const failed=intercept(async sql=>{if(sql.startsWith('UPDATE olos_http.report_snapshot_state SET published_id'))throw new Error('simulated failure');return undefined;});
  await force();const updater=new ReportUpdater(failed,source,dest);const result=await updater.refreshOnce();await updater.stop();
  assert.equal(result.state,'failed');assert.equal(result.retry_ms,30000);assert.deepEqual(await read(),before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.report_snapshots WHERE source_key=$1',[source])).rows[0].n,count);
  assert.equal((await pool.query('SELECT status FROM olos_http.report_snapshot_state WHERE source_key=$1',[source])).rows[0].status,'error');
});
test('COMMIT acknowledgement loss uses durable publication and never rewrites it to failed',async()=>{
  let commits=0;const uncertain=intercept(async(sql,values,db)=>{
    if(sql==='COMMIT'){commits++;await db.query(sql,values);throw new Error('ack lost');}return undefined;
  });
  await force();const updater=new ReportUpdater(uncertain,source,dest);const result=await updater.refreshOnce();await updater.stop();
  assert.equal(result.state,'commit_unknown');assert.equal(commits,1);
  const state=(await pool.query('SELECT status,published_id FROM olos_http.report_snapshot_state WHERE source_key=$1',[source])).rows[0];
  assert.equal(state.status,'ready');assert.equal((await read() as {snapshot_id?:string}).snapshot_id,state.published_id);
  const restart=new ReportUpdater(pool,source,dest);assert.equal((await restart.refreshOnce()).state,'not_due');await restart.stop();
});
test('shutdown during an update discards only its connection; restart recovers without partial publication',async()=>{
  const before=await read(),entered=deferred(),release=deferred();
  const blocked=intercept(async sql=>{if(sql.startsWith('WITH classified')){entered.resolve();await release.promise;}return undefined;});
  await force();const updater=new ReportUpdater(blocked,source,dest);updater.start();await entered.promise;
  const stopping=updater.stop();release.resolve();await stopping;
  assert.deepEqual(await read(),before);await force();await publish();
});
test('lost PostgreSQL session cannot publish or crash the updater/reader; a new instance recovers',async()=>{
  const before=await read(),entered=deferred(),release=deferred();let pid=0;
  const disconnected={async connect(){const db=await pool.connect();pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(sql:string,values?:unknown[]){if(sql.startsWith('WITH classified')){entered.resolve();await release.promise;}return db.query(sql,values);},release(destroy?:boolean){db.release(destroy);}};}} as unknown as pg.Pool;
  await force();const updater=new ReportUpdater(disconnected,source,dest),pending=updater.refreshOnce();await entered.promise;
  await pool.query('SELECT pg_terminate_backend($1)',[pid]);release.resolve();assert.equal((await pending).state,'failed');await updater.stop();assert.deepEqual(await read(),before);
  await publish();
  const readEntered=deferred(),readRelease=deferred();let readerPid=0;
  const readDisconnected={async connect(){const db=await pool.connect();readerPid=(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(sql:string,values?:unknown[]){if(sql.startsWith('SELECT s.id')){readEntered.resolve();await readRelease.promise;}return db.query(sql,values);},release(destroy?:boolean){db.release(destroy);}};}} as unknown as pg.Pool;
  const reading=new AdminReports(readDisconnected,source,dest).read('2026-10-01','2026-10-31');const rejected=assert.rejects(reading,/REPORT_UNAVAILABLE/);
  await readEntered.promise;await pool.query('SELECT pg_terminate_backend($1)',[readerPid]);readRelease.resolve();await rejected;assert((await read()).summary);
});
test('a build crossing the Brasília calendar boundary schedules an immediate replacement',async()=>{
  const oldClock=intercept(async(sql,values,db)=>{
    if(sql.includes('to_regclass')){const result=await db.query(sql,values);const current=result.rows[0];current.collection_date='2020-01-01';current.start_at=new Date('2020-01-01T03:00:00Z');current.end_at=new Date('2020-01-02T03:00:00Z');return result;}
    if(sql.includes('transaction_timestamp() AS observed_at')){const result=await db.query(sql,values);result.rows[0].observed_at=new Date('2020-01-01T12:00:00Z');return result;}return undefined;
  });
  await force();const updater=new ReportUpdater(oldClock,source,dest);const result=await updater.refreshOnce();await updater.stop();assert.equal(result.state,'published');assert.equal(result.retry_ms,1000);
  await assert.rejects(reader().today(),/REPORT_SNAPSHOT_STALE/);
  const next=new ReportUpdater(pool,source,dest);assert.equal((await next.refreshOnce()).state,'published');await next.stop();assert.equal((await reader().today()).calls,'1');
});
test('limited retries/backoff are persisted across instances; polling filters never increments attempts',async()=>{
  const failed=intercept(async sql=>{if(sql.startsWith('WITH classified'))throw Object.assign(new Error('timeout'),{code:'57014'});return undefined;});
  const delays=[];
  for(let i=0;i<3;i++){await force();const updater=new ReportUpdater(failed,source,dest);delays.push((await updater.refreshOnce()).retry_ms);await updater.stop();}
  assert.deepEqual(delays,[30000,60000,300000]);
  const state=(await pool.query('SELECT failure_count,attempt_id FROM olos_http.report_snapshot_state WHERE source_key=$1',[source])).rows[0];
  await Promise.all([read(),read(),read()]);
  const after=(await pool.query('SELECT failure_count,attempt_id FROM olos_http.report_snapshot_state WHERE source_key=$1',[source])).rows[0];assert.deepEqual(after,state);
  const another=new ReportUpdater(pool,source,dest);assert.equal((await another.refreshOnce()).state,'not_due');await another.stop();
  await publish();
});
test('backfills, late confirmations, changed receipts, null dates and mappings preserve exact semantics',async()=>{
  await pool.query("UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=3,confirmed_at=now() WHERE source_key=$1 AND source_id='3'",[source]);
  await pool.query("UPDATE olos_http.corporate_outbox SET source_hash='divergent' WHERE source_key=$1 AND source_id='2'",[source]);
  await pool.query("INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE VALUES(99,'2026-10-02T12:00:00Z','Backfill')");
  await publish();
  const r=reader();for(const [from,to]of [['2026-10-01','2026-10-01'],['2026-10-01','2026-10-07'],['2026-10-01','2026-10-15'],['2026-10-01','2026-10-30'],['2026-01-01','2026-12-31']]){
    const expected=(await pool.query(original,[source,from,to,reportWhitespace,reportPlaceholder,target])).rows[0];const actual=await r.read(from,to) as Record<string,unknown>;
    for(const key of scopes)assert.deepEqual(actual[key],expected[key],key);
  }
  const count=(await pool.query('SELECT count(*)::int n FROM olos_http.report_snapshots WHERE source_key=$1',[source])).rows[0].n;assert.equal(count,2);
});
test('temporary-space exhaustion is bounded and cannot replace the valid snapshot',async()=>{
  const previous=await read();const limited=intercept(async(sql,values,db)=>{
    if(sql.startsWith('WITH classified')){await db.query("SET LOCAL temp_file_limit='64kB'");await db.query("SET LOCAL work_mem='64kB'");await db.query('SELECT n FROM generate_series(1,100000) n ORDER BY md5(n::text)');}
    return undefined;
  });
  await force();const updater=new ReportUpdater(limited,source,dest);const outcome=await updater.refreshOnce();await updater.stop();assert.equal(outcome.code,'REPORT_TEMP_LIMIT');assert.deepEqual(await read(),previous);await publish();
});
test('source schema failures are classified separately from a missing snapshot migration',async()=>{
  const updater=new ReportUpdater(pool,'missing-source-schema',{schema:'no_such_schema',table:'calls'});const result=await updater.refreshOnce();await updater.stop();
  assert.equal(result.state,'failed');assert.equal(result.code,'REPORT_SOURCE_SCHEMA_UNAVAILABLE');
});
test('missing outbox is persisted as unavailable; its restoration is captured on the next refresh',async()=>{
  await pool.query('ALTER TABLE olos_http.corporate_outbox RENAME TO hidden_outbox');
  try{await publish();const observed=await read();assert.equal(observed.outbox_available,false);assert.equal((observed.summary as {confirmed:null}).confirmed,null);assert.equal((observed.period as {pending:null}).pending,null);}
  finally{await pool.query('ALTER TABLE olos_http.hidden_outbox RENAME TO corporate_outbox');}
  await publish();assert.equal((await read()).outbox_available,true);
});
test('published generations are immutable and very large decimal strings survive a PostgreSQL/HTTP round trip',async()=>{
  const current=(await pool.query('SELECT published_id FROM olos_http.report_snapshot_state WHERE source_key=$1',[source])).rows[0].published_id;
  await assert.rejects(pool.query('UPDATE olos_http.report_snapshots SET data=data WHERE id=$1',[current]),/REPORT_SNAPSHOT_IMMUTABLE/);
  const now=(await pool.query("SELECT clock_timestamp() observed,(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS collection_day")).rows[0];
  const huge='900719925474099312345';
  const counts=Object.fromEntries(countFields.map(f=>[f,'0'])) as Record<typeof countFields[number],string>;
  const data=sealReportData({days:[{...counts,day:'2026-10-01',calls:huge,pending:huge,identified_calls:'1',operator_ids:['9007199254740993'],collected_today:huge}],failed_reads:huge,observed_at:now.observed.toISOString(),collection_date:now.collection_day,outbox_available:true});
  const id=randomUUID();await pool.query(`INSERT INTO olos_http.report_snapshots(id,source_key,target_table,contract_version,contract_name,timezone,status,observed_at,collection_date,data,validation,data_hash)
    VALUES($1,'wide-counts',$2,1,'olos-admin-reports/v1','America/Sao_Paulo','published',$3,$4,$5,$6,$7)`,[id,target,data.observed_at,data.collection_date,JSON.stringify(data),JSON.stringify(reportValidationMetadata(data)),reportDataHash(data)]);
  await pool.query("INSERT INTO olos_http.report_snapshot_state(source_key,target_table,contract_version,published_id,status) VALUES('wide-counts',$1,1,$2,'ready')",[target,id]);
  const r=new AdminReports(pool,'wide-counts',dest);assert.equal(((await r.read('2026-10-01','2026-10-01')) as {period:{calls:string}}).period.calls,huge);assert.equal((await r.today()).calls,huge);
  const server=await reportHttp(r);try{const response=await server.request('/api/reports?from=2026-10-01&to=2026-10-01');assert.equal(response.status,200);assert.equal((response.data.period as {calls:string}).calls,huge);}finally{await server.close();}
});
test('maximum age and incompatible snapshots are explicit; migration rollback never triggers an HTTP fallback',async()=>{
  const stored=(await pool.query('SELECT * FROM olos_http.report_snapshots WHERE id=(SELECT published_id FROM olos_http.report_snapshot_state WHERE source_key=$1)',[source])).rows[0];
  const data=stored.data as ReportData;data.observed_at=new Date(Date.now()-901000).toISOString();data.collection_date=DateTime.fromISO(data.observed_at).setZone('America/Sao_Paulo').toISODate()!;
  const agedId=randomUUID();
  await pool.query(`INSERT INTO olos_http.report_snapshots(id,source_key,target_table,contract_version,contract_name,timezone,status,observed_at,collection_date,data,validation,data_hash)
    VALUES($1,$2,$3,1,'olos-admin-reports/v1','America/Sao_Paulo','published',$4,$5,$6,$7,$8)`,[agedId,source,target,data.observed_at,data.collection_date,JSON.stringify(data),JSON.stringify(reportValidationMetadata(data)),reportDataHash(data)]);
  await pool.query('UPDATE olos_http.report_snapshot_state SET published_id=$2 WHERE source_key=$1',[source,agedId]);
  await assert.rejects(read(),/REPORT_SNAPSHOT_STALE/);await publish();
  await pool.query(`INSERT INTO olos_http.report_snapshots(id,source_key,target_table,contract_version,timezone,status,observed_at,collection_date,data,validation,data_hash,contract_name)
    SELECT '22222222-2222-4222-8222-222222222222','future',$1,99,timezone,status,observed_at,collection_date,data,validation,data_hash,'olos-admin-reports/v99' FROM olos_http.report_snapshots WHERE id=(SELECT published_id FROM olos_http.report_snapshot_state WHERE source_key=$2)`,[target,source]);
  await assert.rejects(new AdminReports(pool,'future',dest).read('2026-10-01','2026-10-31'),/REPORT_SNAPSHOT_INCOMPATIBLE/);
  const before=await authoritative();
  await pool.query(await readFile('admin/migrations/rollback/003_report_snapshots.sql','utf8'));
  await assert.rejects(read(),/REPORT_SNAPSHOT_MIGRATION_REQUIRED/);
  assert((await pool.query(original,[source,'2026-10-01','2026-10-31',reportWhitespace,reportPlaceholder,target])).rows[0].summary.calls);
  assert.equal(await authoritative(),before);await pool.query(migration);await publish();
});
