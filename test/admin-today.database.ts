// Disposable fixtures only. Does not execute migrations or use operational URLs.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import pg from 'pg';
import {AdminReports} from '../src/admin/reports.js';
import {AdminRepository} from '../src/admin/repository.js';
const url=process.env.TEST_DATABASE_URL;
if(process.env.OLOS_TODAY_DISPOSABLE_TEST!=='true'||!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_reports_test')throw Error('Disposable today runner required');
const pool=new pg.Pool({connectionString:url,max:4,statement_timeout:5000});
const source='manual-tests',dest={schema:'raw',table:'olos_calls'},target='"raw"."olos_calls"';
const reader=(p=pool)=>new AdminReports(p,source,dest);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function intercept(handler:(sql:string,values:unknown[]|undefined,db:pg.PoolClient)=>Promise<void>){
 return {async connect(){const db=await pool.connect();return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(sql:string,values?:unknown[]){await handler(sql,values,db);return db.query(sql,values);},release:db.release.bind(db)};}} as unknown as pg.Pool;
}
before(async()=>{
 if(!(await pool.query("SELECT to_regclass('olos_http.records') present")).rows[0].present)await pool.query(await readFile('test/fixtures/admin-reports.sql','utf8'));
 await pool.query("DELETE FROM olos_http.records WHERE source_key LIKE 'manual-tests%' OR source_key='synthetic-load'");
 await pool.query(`WITH bounds AS (SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo') start_at)
  INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,created_at)
  SELECT $1,n::text,$2,3000000+n,'fixture',start_at+delta FROM bounds CROSS JOIN (VALUES(1,interval '0'),(2,interval '1 day'-interval '1 microsecond'),(3,-interval '1 microsecond'),(4,interval '1 day')) v(n,delta)`,[source,target]);
 await pool.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) VALUES($1,'other-target','other',3000005,'fixture'),($2,'other-source',$3,3000006,'fixture')",[source,source+'-other',target]);
 if(process.env.TODAY_PERF==='1'&&!(await pool.query("SELECT 1 FROM olos_http.records WHERE source_key='manual-perf' LIMIT 1")).rowCount){
  await pool.query("SET statement_timeout=0"); // fixture construction only
  await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) SELECT 'manual-perf',n::text,$1,n,repeat('a',64),'7' FROM generate_series(1,2000000) n`,[target]);
  await pool.query('VACUUM (ANALYZE,PARALLEL 0) olos_http.records');await pool.query("SET statement_timeout='5s'");
 }
});
after(async()=>{await pool.end();});
test('live count matches first-persistence boundaries/source/target without mappings or snapshots',async()=>{
 const r=await reader().refreshToday();assert.equal(r.calls,'2');assert.equal(r.observation_source,'local_records');
 assert.equal((await pool.query("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS date")).rows[0].date,r.date);
 assert(r.observed_at<=new Date().toISOString());
 const repo=new AdminRepository(url!,source,dest);try{assert.equal((await repo.refreshToday()).calls,'2');}finally{await repo.close();}
 // No snapshot tables are necessary and the snapshot-only API stays unchanged.
 await assert.rejects(reader().today(),/REPORT_SNAPSHOT_MIGRATION_REQUIRED/);
});
test('two instances exclude concurrent counts; RR excludes later commits and the next observation includes them',async()=>{
 const entered=deferred(),release=deferred();
 const first=reader(intercept(async sql=>{if(sql.startsWith('SELECT count(*)')){entered.resolve();await release.promise;}}));
 const pending=first.refreshToday();await entered.promise;
 try{
  await assert.rejects(reader().refreshToday(),/REPORT_TODAY_BUSY/);
  await pool.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) VALUES($1,'later',$2,3000007,'fixture')",[source,target]);
 }finally{release.resolve();}
 assert.equal((await pending).calls,'2');assert.equal((await reader().refreshToday()).calls,'3');
 await assert.rejects(first.refreshToday(),/REPORT_TODAY_RATE_LIMITED/);
});
test('server statement timeout keeps failures explicit and restores connection settings',async()=>{
 const bounded=reader(intercept(async(sql,_values,db)=>{if(sql.startsWith('SELECT count(*)'))await db.query('SELECT pg_sleep(2)');}));
 const at=performance.now();await assert.rejects(bounded.refreshToday(),/REPORT_TODAY_TIMEOUT/);assert(performance.now()-at<2000);
 const settings=(await pool.query("SELECT current_setting('statement_timeout') timeout,current_setting('max_parallel_workers_per_gather') workers")).rows[0];
 assert.equal(settings.timeout,'5s');assert.notEqual(settings.workers,'0');assert.equal((await reader().refreshToday()).calls,'3');
});
test('connection loss fails closed, releases source exclusion and does not crash the process',async()=>{
 const disconnected=reader(intercept(async(sql,_values,db)=>{if(sql.startsWith('SELECT count(*)')){const pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await pool.query('SELECT pg_terminate_backend($1)',[pid]);}}));
 await assert.rejects(disconnected.refreshToday(),/REPORT_TODAY_UNAVAILABLE/);
 assert.equal((await reader().refreshToday()).calls,'3');
});
test('two-million record count stays bounded with concurrent batches of 500 persisted records', {skip:process.env.TODAY_PERF!=='1'},async()=>{
 const baseline:number[]=[],concurrent:number[]=[],durations:number[]=[];
 async function insert(at:number){const began=performance.now();await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) SELECT 'synthetic-load',n::text,$1,n,'fixture' FROM generate_series($2::int,$2::int+499) n`,[target,at]);return performance.now()-began;}
 for(let i=0;i<4;i++)baseline.push(await insert(6000000+i*500));
 let countSql='',parameters:unknown[]|undefined;
 for(let i=0;i<5;i++){
  const r=new AdminReports(intercept(async(sql,values)=>{if(sql.startsWith('SELECT count(*)')){countSql=sql;parameters=values;}}),'manual-perf',dest);
  const started=performance.now(),count=r.refreshToday();
  if(i===0){for(let j=0;j<4;j++)concurrent.push(await insert(7000000+j*500));}
  assert.equal((await count).calls,'2000000');durations.push(performance.now()-started);
 }
 const db=await pool.connect();let plan;
 try{await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='1s'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off");plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+countSql,parameters)).rows;await db.query('ROLLBACK');}finally{db.release();}
 const root=plan[0]['QUERY PLAN'][0].Plan;
 assert.equal(root['Temp Written Blocks']??0,0);assert(durations.every(ms=>ms<1000));assert(Math.max(...concurrent)<250);assert(Math.max(...concurrent)-Math.max(...baseline)<100);
 const directory=process.env.TODAY_EVIDENCE_DIR??'/tmp/olos-manual-today-evidence';await mkdir(directory,{recursive:true});
 const evidence={synthetic:true,record_count:'2000000',durations_ms:durations,baseline_batches_ms:baseline,concurrent_batches_ms:concurrent,temp_written_blocks:root['Temp Written Blocks']??0,plan};
 await writeFile(directory+'/runtime.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({...evidence,plan:undefined}));
});
