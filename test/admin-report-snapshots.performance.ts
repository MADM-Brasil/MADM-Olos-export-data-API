// Opt-in production-path benchmark. Synthetic data, disposable Docker PG only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pg from 'pg';
import { AdminReports } from '../src/admin/reports.js';
import { ReportUpdater } from '../src/admin/report-updater.js';
import { LegacyAdminReports } from './fixtures/admin-reports-legacy.js';
import { reportHttp } from './fixtures/report-http.js';
const exec=promisify(execCallback),url=process.env.TEST_DATABASE_URL,container=process.env.REPORT_PERF_CONTAINER;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_reports_test'||!container?.startsWith('olos-'))throw new Error('Disposable reports runner required');
const connection=new URL(url),inspection=JSON.parse((await exec('docker',['inspect',container])).stdout) as {Config:{Labels:Record<string,string>};NetworkSettings:{Ports:Record<string,{HostIp:string;HostPort:string}[]>}}[];
assert.equal(inspection[0]?.Config.Labels['olos-http.disposable-test'],'true');assert(inspection[0]?.NetworkSettings.Ports['5432/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort===connection.port));
const directory=process.env.REPORT_PERF_EVIDENCE??'/tmp/olos-persisted-reports';await mkdir(directory,{recursive:true});
let pool=new pg.Pool({connectionString:url,max:4,statement_timeout:5000});
const source='perf',target='"raw"."olos_calls"',dest={schema:'raw',table:'olos_calls'};
const ranges=[1,7,15,30,366].map(days=>({from:new Date(Date.UTC(2026,10,10)-(days-1)*86400000).toISOString().slice(0,10),to:'2026-11-10'}));
const scopes=['summary','period','daily','failed_reads'] as const;
const samples:{phase:string;ms:number;status:number}[]=[],updates:number[]=[],ingestion:{phase:string;ms:number}[]=[];
let historical=0,apiHistorical=0,apiSelects=0,sql='',parameters:unknown[]=[],peakRSS=process.memoryUsage().rss;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const ownPool=(role?:string)=>{const u=new URL(connection);if(role)u.username=role;const p=new pg.Pool({connectionString:u.toString(),max:1,connectionTimeoutMillis:1000,statement_timeout:5000,application_name:role?'olos-bench-http':'olos-bench-updater'});p.on('error',()=>{});return p;};
async function restart(){await pool.end();await exec('docker',['restart',container!],{timeout:30000});for(let i=0;;i++){try{await exec('docker',['exec',container!,'pg_isready','-h','127.0.0.1','-U','postgres','-d','olos_admin_reports_test']);break;}catch(e){if(i===29)throw e;await delay(500);}}const address=(await exec('docker',['port',container!,'5432/tcp'])).stdout.trim();assert(address.startsWith('127.0.0.1:'));connection.port=address.split(':').at(-1)!;pool=new pg.Pool({connectionString:connection.toString(),max:4,statement_timeout:5000});}
function writerProxy(p:pg.Pool,onClock?:()=>Promise<void>) {
 return {async connect(){const db=await p.connect();return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(query:string,values?:unknown[]){
   if(query.startsWith('WITH classified')){historical++;sql=query;parameters=values??[];}
   const result=await db.query(query,values);if(query.includes('to_regclass'))await onClock?.();return result;
 },release(discard?:boolean){db.release(discard);}};}} as unknown as pg.Pool;
}
async function build(onClock?:()=>Promise<void>) {
 const p=ownPool(),updater=new ReportUpdater(writerProxy(p,onClock),source,dest),at=performance.now();
 try{const result=await updater.refreshOnce();updates.push(performance.now()-at);assert.equal(result.state,'published',JSON.stringify(result));return result.snapshot_id!;}
 finally{await updater.stop();await p.end();}
}
async function requestBatch(phase:string,expected?:Record<string,unknown>[],until?:()=>boolean) {
 const p=ownPool('snapshot_bench_http');
 const traced={async connect(){const db=await p.connect();return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(query:string,values?:unknown[]){if(query.startsWith('WITH classified')||/olos_http\.records|corporate_outbox|raw\.olos_calls/.test(query))apiHistorical++;if(query.startsWith('SELECT s.id'))apiSelects++;return db.query(query,values);},release(discard?:boolean){db.release(discard);}};}} as unknown as pg.Pool;
 const server=await reportHttp(new AdminReports(traced,source,dest));
 try{
   for(let wave=0;wave<5||(until&&!until());wave++){
     if(until)await delay(100);
     const responses=await Promise.all(ranges.map(r=>server.request(`/api/reports?from=${r.from}&to=${r.to}`)));
     for(const [i,r]of responses.entries()){samples.push({phase:wave===0?phase:phase+'-warm-app',ms:r.ms,status:r.status});assert.equal(r.status,200,JSON.stringify(r.data));if(expected)for(const key of scopes)assert.deepEqual(r.data[key],expected[i]![key],key);}
   }
   const today=await server.request('/api/today');assert.equal(today.status,200);return today.data;
 }finally{await server.close();await p.end();}
}
async function ingest(phase:string,start:number,batches:number,key:string) {
 const p=new pg.Pool({connectionString:connection.toString(),max:1,statement_timeout:5000,application_name:'olos-synthetic-ingest'});
 try{for(let batch=0;batch<batches;batch++){
  const db=await p.connect(),first=start+batch*500,at=performance.now();
  try{await db.query('BEGIN');await db.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE SELECT n,'2026-11-10T12:00:00Z','Synthetic Ingestion' FROM generate_series($1::int,$1::int+499) n`,[first]);
   await db.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) SELECT $1,n::text,$2,n,repeat('a',64),'7' FROM generate_series($3::int,$3::int+499) n`,[key,target,first]);
   await db.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin) SELECT $1,n::text,n,repeat('a',64),'{}',repeat('b',64),'pending','capture' FROM generate_series($2::int,$2::int+499) n`,[key,first]);await db.query('COMMIT');ingestion.push({phase,ms:performance.now()-at});
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }}finally{await p.end();}
}
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]!;
await test('persisted snapshots: 2M records, cold HTTP/restart, consistency and operational resource gates',async t=>{
 const rssTimer=setInterval(()=>{peakRSS=Math.max(peakRSS,process.memoryUsage().rss);},25);rssTimer.unref();
 try{
  if(process.env.REPORT_SNAPSHOT_PERF_PREPARED!=='1'){
   await pool.query("SET statement_timeout=0"); // fixture construction only; restart below restores 5s serving budget
   await pool.query(await readFile('test/fixtures/admin-reports.sql','utf8'));await pool.query(await readFile('admin/migrations/003_report_snapshots.sql','utf8'));
   console.log('SNAPSHOT_FIXTURE schema');
   await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente,cpf,email,telefone,nome_campanha_olos) OVERRIDING SYSTEM VALUE SELECT n,'2025-11-11T03:00:00Z'::timestamptz+(n%365)*interval '1 day',CASE WHEN n%20=0 THEN 'UNKNOWN' ELSE 'Operador Teste '||((n/365)%1000) END,CASE WHEN n%3=0 THEN 'synthetic' END,CASE WHEN n%5=0 THEN 'synthetic@example.invalid' END,repeat('x',12),repeat('synthetic ',20) FROM generate_series(1,786460) n`);
   console.log('SNAPSHOT_FIXTURE destination');
   await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,created_at) SELECT $1,n::text,$2,n,repeat('a',64),((n/365)%1000+1)::text,'2026-11-10T12:00:00Z'::timestamptz FROM generate_series(1,2000000) n`,[source,target]);
   console.log('SNAPSHOT_FIXTURE records');
   await pool.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at) SELECT $1,n::text,n,repeat('a',64),jsonb_build_object('synthetic',repeat('sample ',80)),repeat('b',64),CASE WHEN n%3=0 THEN 'confirmed' WHEN n%17=0 THEN 'skipped' ELSE 'pending' END,'capture',CASE WHEN n%3=0 THEN n END,CASE WHEN n%3=0 THEN '2026-11-10T13:00:00Z'::timestamptz END FROM generate_series(1,1910290) n`,[source]);
   console.log('SNAPSHOT_FIXTURE outbox');
   for(const table of ['raw.olos_calls','olos_http.records','olos_http.corporate_outbox'])await pool.query(`VACUUM ANALYZE ${table}`);
   await pool.query('CHECKPOINT');await pool.query("COMMENT ON SCHEMA raw IS 'olos persisted-report benchmark v1'");
  }else {
   assert.equal((await pool.query("SELECT obj_description('raw'::regnamespace,'pg_namespace') marker")).rows[0].marker,'olos persisted-report benchmark v1');
   await pool.query('TRUNCATE olos_http.report_snapshot_state,olos_http.report_snapshots');
   await pool.query("DELETE FROM olos_http.corporate_outbox WHERE target_id>2000000 OR source_key<>'perf'");
   await pool.query("DELETE FROM olos_http.records WHERE target_id>2000000 OR source_key<>'perf'");
   await pool.query('DELETE FROM raw.olos_calls WHERE internal_id_olos>786460');
   await pool.query("UPDATE olos_http.corporate_outbox SET state='pending',remote_raw_id=NULL,confirmed_at=NULL,source_hash=repeat('a',64) WHERE source_key='perf' AND source_id IN ('1','2')");
  }
  await pool.query(await readFile('admin/migrations/003_report_snapshots.sql','utf8'));
  await pool.query('DO $$ BEGIN CREATE ROLE snapshot_bench_http LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$; GRANT USAGE ON SCHEMA olos_http TO snapshot_bench_http; GRANT SELECT ON olos_http.report_snapshots,olos_http.report_snapshot_state TO snapshot_bench_http');
  const counts=(await pool.query(`SELECT (SELECT count(*) FROM olos_http.records)::text records,(SELECT count(*) FROM olos_http.corporate_outbox)::text outbox,(SELECT count(*) FROM raw.olos_calls)::text destination`)).rows[0];assert.deepEqual(counts,{records:'2000000',outbox:'1910290',destination:'786460'});
  await t.test('initialization HTTP is fast, authenticated, explicit and does not start a build',async()=>{
   const p=ownPool('snapshot_bench_http'),server=await reportHttp(new AdminReports(p,source,dest));
   try{const r=await server.request('/api/reports?from=2026-11-10&to=2026-11-10');assert.equal(r.status,503);assert.equal(r.data.error,'REPORT_INITIALIZING');assert(r.ms<500);assert.equal(historical,0);}
   finally{await server.close();await p.end();}
  });
  await restart();
  const firstId=await build();console.log('SNAPSHOT_BUILD',Math.round(updates[0]!));
  const oraclePool={async connect(){const db=await pool.connect();return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(query:string,values?:unknown[]){return db.query(query.startsWith('SET LOCAL statement_timeout')?"SET LOCAL statement_timeout='60s'":query,values);},release(){db.release();}};}} as unknown as pg.Pool;
  // Frozen old implementation, separate diagnostic budget, never the HTTP path.
  const legacy=new LegacyAdminReports(oraclePool,source,dest,()=>0),expected:Record<string,unknown>[]=[];
  for(const range of ranges)expected.push(await legacy.read(range.from,range.to) as Record<string,unknown>);
  const oldToday=await legacy.today();
  const today=await requestBatch('cold-app-existing-persistent-snapshot',expected);assert.equal(today.calls,oldToday.calls);
  assert.equal(historical,1);
  for(let cycle=1;cycle<=3;cycle++){
   await restart();await requestBatch(`cold-pg-restart-${cycle}`,expected);
   assert.equal((await pool.query('SELECT published_id FROM olos_http.report_snapshot_state WHERE source_key=$1',[source])).rows[0].published_id,firstId);assert.equal(historical,1);
  }
  await ingest('baseline',4000001,4,'synthetic-probe');
  await pool.query("UPDATE olos_http.report_snapshot_state SET next_attempt_at='-infinity' WHERE source_key=$1",[source]);
  const entered=deferred(),release=deferred();let buildDone=false;const pending=build(async()=>{entered.resolve();await release.promise;}).finally(()=>{buildDone=true;});await entered.promise;
  const writes=ingest('concurrent-refresh',2000001,4,source);release.resolve();
  await Promise.all([requestBatch('during-refresh',expected,()=>buildDone),writes,pending]);
  // The concurrent snapshot must exclude writes committed after its RR boundary.
  assert.equal((await new AdminReports(pool,source,dest).read(ranges[4]!.from,ranges[4]!.to) as {summary:{calls:string}}).summary.calls,'2000000');
  await pool.query("UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=1,confirmed_at=now() WHERE source_key=$1 AND source_id='1'",[source]);
  await pool.query("UPDATE olos_http.corporate_outbox SET source_hash='receipt-changed' WHERE source_key=$1 AND source_id='2'",[source]);
  await pool.query("INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE VALUES(1000001,'2026-10-02T12:00:00Z','Synthetic Backfill')");
  await pool.query("UPDATE olos_http.report_snapshot_state SET next_attempt_at='-infinity' WHERE source_key=$1",[source]);await build();
  const latest=await new AdminReports(pool,source,dest).read(ranges[4]!.from,ranges[4]!.to) as {summary:{calls:string;undated:string;missing_mapping:string;confirmed:string;inconsistent:string},period:{calls:string}};
  assert.equal(latest.summary.calls,'2002000');assert.equal(latest.summary.undated,'1213539');assert.equal(latest.summary.missing_mapping,'1213539');assert.equal(latest.summary.confirmed,(BigInt((expected[4]!.summary as {confirmed:string}).confirmed)+1n).toString());
  assert.equal(latest.summary.inconsistent,(BigInt((expected[4]!.summary as {inconsistent:string}).inconsistent)+1n).toString());
  const latestReader=new AdminReports(pool,source,dest),lateOracle=new LegacyAdminReports(oraclePool,source,dest,()=>0);
  for(const range of ranges){const after=await latestReader.read(range.from,range.to) as Record<string,unknown>,reference=await lateOracle.read(range.from,range.to) as Record<string,unknown>;for(const key of scopes)assert.deepEqual(after[key],reference[key],key);}
  assert.equal((await latestReader.today()).calls,(await lateOracle.today()).calls);
  const retained=(await pool.query('SELECT count(*)::int n FROM olos_http.report_snapshots WHERE source_key=$1',[source])).rows[0].n;assert.equal(retained,2);
  const db=await pool.connect();let tempWritten=0;
  try{
   await db.query('BEGIN READ ONLY');for(const setting of ["SET LOCAL statement_timeout='30s'",'SET LOCAL jit=off',"SET LOCAL work_mem='16MB'",'SET LOCAL hash_mem_multiplier=2','SET LOCAL max_parallel_workers_per_gather=1',"SET LOCAL temp_file_limit='768MB'"])await db.query(setting);
   const estimated=(await db.query('EXPLAIN (SETTINGS,FORMAT JSON) '+sql,parameters)).rows;
   const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,SETTINGS,TIMING OFF,FORMAT JSON) '+sql,parameters)).rows;
   tempWritten=plan[0]['QUERY PLAN'][0].Plan['Temp Written Blocks']*8192;
   await writeFile(directory+'/refresh-estimated.json',JSON.stringify(estimated,null,2));await writeFile(directory+'/refresh-executed.json',JSON.stringify(plan,null,2));
   // Only the persistent-key SELECT is planned; neither endpoint executes the history.
   const readPlan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) SELECT s.data FROM olos_http.report_snapshot_state k JOIN olos_http.report_snapshots s ON s.id=k.published_id WHERE k.source_key=$1 AND k.target_table=$2 AND k.contract_version=1',[source,target])).rows;
   await writeFile(directory+'/persistent-read-executed.json',JSON.stringify(readPlan,null,2));
  }finally{await db.query('ROLLBACK');db.release();}
  // Service RSS excludes this driver, the frozen oracle and HTTP response clients.
  const child=fork('test/fixtures/report-memory.ts',[],{execArgv:['--import','tsx'],env:{...process.env,TEST_DATABASE_URL:connection.toString()},silent:true});
  let readyResolve!:(v:{url:string;cookie:string;origin:string})=>void,statsResolve!:(v:{peak_rss_mib:number;refresh_with_http_ms:number;requests:number;limit_mib:number})=>void;
  const ready=new Promise<{url:string;cookie:string;origin:string}>(r=>{readyResolve=r;});
  const stats=new Promise<{peak_rss_mib:number;refresh_with_http_ms:number;requests:number;limit_mib:number}>(r=>{statsResolve=r;});
  let failure:Error|undefined;
  child.on('message',(message:unknown)=>{const value=message as {type:string;url:string;cookie:string;origin:string;stats:{peak_rss_mib:number;refresh_with_http_ms:number;requests:number;limit_mib:number};error?:string};if(value.type==='ready')readyResolve(value);if(value.type==='stats')statsResolve(value.stats);if(value.type==='failure')failure=new Error(value.error);});
  const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
  const timeout=setTimeout(()=>child.kill('SIGKILL'),60000);timeout.unref();
  let serviceMemory:{peak_rss_mib:number;refresh_with_http_ms:number;requests:number;limit_mib:number};
  try{
    const endpoint=await Promise.race([ready,exited.then(()=>{throw failure??new Error('isolated service exited before readiness');})]);
    child.send({type:'start'});const trafficStart=performance.now();let requests=0;
    while(performance.now()-trafficStart<20000){
      const responses=await Promise.all(ranges.map(async range=>{const began=performance.now();const r=await fetch(endpoint.url+`/api/reports?from=${range.from}&to=${range.to}`,{headers:{Cookie:endpoint.cookie,Origin:endpoint.origin}});const body=await r.json();samples.push({phase:'isolated-service-concurrent',ms:performance.now()-began,status:r.status});assert.equal(r.status,200,JSON.stringify(body));return body;}));requests+=responses.length;await delay(100);
    }
    child.send({type:'stop',requests});
    serviceMemory=await Promise.race([stats,exited.then(()=>{throw failure??new Error('isolated service exited without stats');})]);assert.equal(await exited,0);
  }finally{clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGTERM');}
  const environment=(await pool.query("SELECT version(),current_setting('shared_buffers') shared_buffers,current_setting('work_mem') work_mem,pg_database_size(current_database())::text database_bytes")).rows[0];
  const summary={refresh_settings:{statement_timeout_ms:30000,wall_timeout_ms:40000,work_mem_mib:16,parallel_workers:1,temp_limit_per_backend_mib:768,pool_max:1},read_settings:{statement_timeout_ms:5000,wall_timeout_ms:5000,connection_timeout_ms:1000,pool_max:1},synthetic:true,counts,environment,operators:1000,days:365,ingestion_batch_size:500,cold_definition:'PostgreSQL restart, host OS cache not dropped',historical_queries_in_driver:historical,isolated_service_refreshes:1,http_historical_queries:apiHistorical,http_snapshot_queries:apiSelects,
    http_p95_ms:percentile(samples.map(s=>s.ms),.95),http_max_ms:Math.max(...samples.map(s=>s.ms)),refresh_ms:updates,node_service_peak_rss_mib:serviceMemory.peak_rss_mib,node_benchmark_driver_peak_rss_mib:peakRSS/1048576,isolated_service:serviceMemory,temp_written_mib:tempWritten/1048576,ingestion,samples,
    limits:{http_p95_ms:500,http_max_ms:1000,refresh_ms:20000,build_statement_ms:30000,build_wall_ms:40000,max_snapshot_age_seconds:900,node_rss_mib:256,temp_written_mib:1536,ingestion_batch_p95_ms:250,ingestion_p95_increment_ms:100}};
  await writeFile(directory+'/summary.json',JSON.stringify(summary,null,2));console.log('PERSISTED_REPORT_BENCH',JSON.stringify({...summary,samples:undefined,ingestion:undefined}));
  await t.test('admission gates include cold reads, concurrent ingestion and resource margins',()=>{
    assert(samples.every(s=>s.status===200));assert.equal(apiHistorical,0);assert(summary.http_p95_ms<500);assert(summary.http_max_ms<1000);assert(updates.every(ms=>ms<20000));assert(serviceMemory.peak_rss_mib<256);assert(serviceMemory.refresh_with_http_ms<20000);assert(tempWritten/1048576<1536);
    const base=percentile(ingestion.filter(x=>x.phase==='baseline').map(x=>x.ms),.95),concurrent=percentile(ingestion.filter(x=>x.phase==='concurrent-refresh').map(x=>x.ms),.95);
    assert(concurrent<250);assert(concurrent-base<100);
  });
 }finally{clearInterval(rssTimer);await pool.end();}
});
