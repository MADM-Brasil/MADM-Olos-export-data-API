import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { AdminReports } from '../src/admin/reports.js';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('Use scripts/test-admin-reports.sh');
const parsed=new URL(url);
if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/olos_admin_reports_test')throw new Error('Disposable database required');
const pool=new pg.Pool({connectionString:url}),target='"raw"."olos_calls"',source='report-fixture';
const reader=()=>new AdminReports(pool,source,{schema:'raw',table:'olos_calls'});
const read=async(r=reader())=>await r.read('2026-10-01','2026-10-31') as any;
const snapshot=async()=>JSON.stringify((await pool.query(`SELECT
  (SELECT json_agg(r ORDER BY source_key,source_id) FROM olos_http.records r) records,
  (SELECT json_agg(o ORDER BY source_key,source_id) FROM olos_http.corporate_outbox o) outbox,
  (SELECT json_agg(d ORDER BY internal_id_olos) FROM raw.olos_calls d) destination,
  (SELECT json_agg(r ORDER BY id) FROM olos_http.reads r) reads`)).rows);
before(async()=>{
  for(const file of ['test/fixture.sql','migrations/001_ingestion.sql','migrations/002_corporate_delivery.sql'])await pool.query(await readFile(file,'utf8'));
  const fixtures=[['2026-10-01T02:59:59Z','7','Ana','confirmed'],['2026-10-01T03:00:00Z','7',' João Silva ','confirmed'],['2026-11-01T02:59:59Z','9007199254740993','Maria','pending'],['2026-11-01T03:00:00Z','7','Ana','pending'],[null,'7','Ana','pending'],['2026-10-15T03:00:00Z','0','Ana','pending'],['2026-10-15T03:00:00Z','007','Ana','pending'],['2026-10-15T03:00:00Z','7',' UNKNOWN ','pending'],['2026-10-15T03:00:00Z','7','123','pending'],['2026-10-15T03:00:00Z','7','\u00a0\t','pending'],['2026-10-16T03:00:00Z','7','Unknown Silva',null],['2026-10-16T03:00:00Z',null,null,'pending']];
  for(const [index,f]of fixtures.entries()){
    const id=index+1;
    await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,olos_call_id,data_ligacao,nome_agente,cpf,email) OVERRIDING SYSTEM VALUE VALUES($1,'same-call-id',$2,$3,$4,$5)`,[id,f[0],f[2],id===2?'PRIVATE_CPF':null,id===3?'PRIVATE_EMAIL':null]);
    await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,'2020-01-01')`,[source,String(id),target,id,'a'.repeat(64),f[1]]);
    if(f[3])await pool.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at) VALUES($1,$2,$3,$4,'{"secret":"PRIVATE_PAYLOAD"}',$4,$5,'capture',$6,$7)`,[source,String(id),id,'a'.repeat(64),f[3],f[3]==='confirmed'?100+id:null,f[3]==='confirmed'?'2026-11-01T12:00:00Z':null]);
  }
  await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE VALUES(100,'2026-10-01T12:00:00Z','Other source'); INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) VALUES('other','1','"raw"."olos_calls"',100,'other','7')`);
  await pool.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,state,error_code) VALUES('132eb226-f4e4-419d-b79f-21dd0e6e64c1',$1,$2,'{}','reading','RESPONSE_TOO_LARGE');`,[source,target]);
  await pool.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,state,response_body) VALUES('09aeaeaa-cc32-415c-8137-2b95729ac131',$1,$2,'{}','received','[]')`,[source,target]);
});
after(async()=>{await pool.end();});
test('aggregate by call date in São Paulo, deduplicate by source_id, preserve local vs receipt semantics',async()=>{
  const before=await snapshot(),r=await read();assert.equal(r.summary.calls,'12');assert.equal(r.period.calls,'9');assert.equal(r.summary.undated,'1');assert.equal(r.period.identified_calls,'3');assert.equal(r.period.operators,'2');assert.equal(r.period.with_cpf,'1');assert.equal(r.period.with_email,'1');assert.equal(r.period.confirmed,'1');assert.equal(r.period.pending,'7');assert.equal(r.period.not_queued,'1');assert.equal(r.failed_reads,'1');
  assert.deepEqual(r.daily.map((x:any)=>x.day),['2026-10-01','2026-10-15','2026-10-16','2026-10-31']);
  assert.equal(r.daily[3].calls,'1');assert.doesNotMatch(JSON.stringify(r),/PRIVATE|same-call-id|source_id|payload|João|Maria/);assert.equal(await snapshot(),before);
});
test('read-only database role can produce reports; cached snapshot is explicit and identical',async()=>{
  await pool.query('CREATE ROLE admin_report_reader LOGIN; GRANT USAGE ON SCHEMA raw,olos_http TO admin_report_reader; GRANT SELECT ON ALL TABLES IN SCHEMA raw,olos_http TO admin_report_reader');
  const safeURL=new URL(url!);safeURL.username='admin_report_reader';const safePool=new pg.Pool({connectionString:safeURL.toString()});
  try{const r=new AdminReports(safePool,source,{schema:'raw',table:'olos_calls'}),first=await read(r);assert.equal(first.summary.calls,'12');assert.equal(await read(r),first);await assert.rejects(safePool.query('UPDATE raw.olos_calls SET nome_agente=NULL'),/permission denied/);}finally{await safePool.end();}
});
test('outbox absence is unavailable, not zero confirmations',async()=>{
  await pool.query('ALTER TABLE olos_http.corporate_outbox RENAME TO fixture_outbox');
  try{const r=await read();assert.equal(r.outbox_available,false);assert.equal(r.summary.confirmed,null);assert.equal(r.period.pending,null);assert.equal(r.daily[0].confirmed,null);}finally{await pool.query('ALTER TABLE olos_http.fixture_outbox RENAME TO corporate_outbox');}
});
test('mapping and receipt divergence remains visible and is never counted as confirmation',async()=>{
  await pool.query("UPDATE olos_http.corporate_outbox SET source_hash='mismatch' WHERE source_key=$1 AND source_id='2'",[source]);
  try{const r=await read();assert.equal(r.period.confirmed,'0');assert.equal(r.period.inconsistent,'1');}finally{await pool.query("UPDATE olos_http.corporate_outbox SET source_hash=$2 WHERE source_key=$1 AND source_id='2'",[source,'a'.repeat(64)]);}
});
test('missing local target is accounted as undated/missing mapping, not fabricated call date',async()=>{
  await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) VALUES($1,'99',$2,99,'fixture')`,[source,target]);
  const r=await read();assert.equal(r.summary.missing_mapping,'1');assert.equal(r.summary.undated,'2');assert.equal(r.period.calls,'9');
});
test('representative 200k local records remain bounded and cache avoids repeat aggregation',async()=>{
  await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE
    SELECT n,'2026-10-01T12:00:00Z'::timestamptz+(n%30)*interval '1 day',CASE WHEN n%10=0 THEN 'Agente Teste' END FROM generate_series(1000,200999) n`);
  await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id)
    SELECT $1,n::text,$2,n,'synthetic',CASE WHEN n%10=0 THEN '7' ELSE '0' END FROM generate_series(1000,200999) n`,[source,target]);
  await pool.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin)
    SELECT $1,n::text,n,'synthetic','{}',repeat('a',64),'pending','capture' FROM generate_series(1000,200999) n`,[source]);
  await pool.query('ANALYZE raw.olos_calls; ANALYZE olos_http.records; ANALYZE olos_http.corporate_outbox');
  const r=reader(),start=performance.now(),first=await read(r),duration=performance.now()-start;
  assert.equal(first.summary.calls,'200013');assert.equal(first.period.calls,'200009');assert.equal(first.period.identified_calls,'20003');
  const cachedStart=performance.now();assert.equal(await read(r),first);
  console.log(`REPORT_BENCH ${JSON.stringify({synthetic_local_records:200013,query_ms:Math.round(duration),cached_ms:Math.round(performance.now()-cachedStart),statement_timeout_ms:5000})}`);
});
