import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { AdminReports, reportPlaceholder, reportWhitespace, reportStatementTimeoutMs } from '../src/admin/reports.js';
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
  await pool.query(await readFile('test/fixtures/admin-reports.sql','utf8'));
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
  try{
    const settings="SELECT current_setting('jit') AS jit,current_setting('statement_timeout') AS timeout,current_setting('lock_timeout') AS lock_timeout";
    const before=(await safePool.query(settings)).rows;
    const r=new AdminReports(safePool,source,{schema:'raw',table:'olos_calls'}),first=await read(r);
    assert.deepEqual((await safePool.query(settings)).rows,before,'report settings must not leak to the shared pool');assert.equal(first.summary.calls,'12');assert.deepEqual(await read(r),first);await assert.rejects(safePool.query('UPDATE raw.olos_calls SET nome_agente=NULL'),/permission denied/);}finally{await safePool.end();}
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
test('all report fields match the frozen legacy query for multiple ranges and empty periods',async()=>{
  const sql=await readFile('test/fixtures/admin-reports-before.sql','utf8'),r=reader();
  for(const [from,to]of [['2026-09-01','2026-10-31'],['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30'],['2020-01-01','2020-01-01']]){
    const old=(await pool.query(sql,[source,from,to,reportWhitespace,reportPlaceholder,target])).rows[0];
    const actual=await r.read(from,to) as any;
    for(const key of ['summary','period','daily','failed_reads'])assert.deepEqual(actual[key],old[key],key);
    for(const field of ['calls','identified_calls','with_cpf','with_email','confirmed','pending','not_queued','inconsistent'])
      assert.equal(actual.daily.reduce((n:bigint,d:any)=>n+BigInt(d[field]),0n).toString(),actual.period[field]);
    assert.equal(actual.summary.operators,'2'); // same operator on several days, including undated
  }
  const empty=await new AdminReports(pool,'empty-source',{schema:'raw',table:'olos_calls'}).read('2026-10-01','2026-10-31') as any;
  assert.equal(empty.summary.calls,'0');assert.equal(empty.summary.operators,'0');assert.equal(empty.summary.undated,'0');assert.deepEqual(empty.daily,[]);
});
test('receipt classification keeps partial receipts and target divergence inconsistent',async()=>{
  const cases=["remote_raw_id=123", "confirmed_at=now()", "target_id=999999", "source_hash='divergent'"];
  for(const patch of cases){
    await pool.query(`UPDATE olos_http.corporate_outbox SET ${patch} WHERE source_key=$1 AND source_id='3'`,[source]);
    try{const r=await read();assert.equal(r.period.pending,'6');assert.equal(r.period.inconsistent,'1');assert.equal(r.period.confirmed,'1');}
    finally{await pool.query("UPDATE olos_http.corporate_outbox SET remote_raw_id=NULL,confirmed_at=NULL,target_id=3,source_hash=$2 WHERE source_key=$1 AND source_id='3'",[source,'a'.repeat(64)]);}
  }
});
test('range-independent snapshot includes old receipt changes only after expiry, atomically with failed reads',async()=>{
  let now=0,mutated=false;
  const wrapped={async connect(){const db=await pool.connect();return {async query(sql:string,values?:unknown[]){
    const result=await db.query(sql,values);
    if(sql.startsWith('WITH classified')&&!mutated){mutated=true;await pool.query("UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=123,confirmed_at=now() WHERE source_key=$1 AND source_id='3'",[source]);
      await pool.query("UPDATE olos_http.reads SET error_code='FIXTURE' WHERE id='09aeaeaa-cc32-415c-8137-2b95729ac131'");}
    return result;},release(){db.release();}};}} as unknown as pg.Pool;
  try{
    const r=new AdminReports(wrapped,source,{schema:'raw',table:'olos_calls'},()=>now),first=await read(r);
    assert.equal(first.period.confirmed,'1');assert.equal(first.failed_reads,'1');
    now=30000;assert.deepEqual(await read(r),first);
    now=300000;const fresh=await read(r);assert.equal(fresh.period.confirmed,'2');assert.equal(fresh.period.pending,'6');assert.equal(fresh.failed_reads,'2');
  }finally{
    await pool.query("UPDATE olos_http.corporate_outbox SET state='pending',remote_raw_id=NULL,confirmed_at=NULL WHERE source_key=$1 AND source_id='3'",[source]);
    await pool.query("UPDATE olos_http.reads SET error_code=NULL WHERE id='09aeaeaa-cc32-415c-8137-2b95729ac131'");
  }
});
test('SQL operator/contact semantics preserve canonical IDs, Unicode whitespace and placeholders',async()=>{
  const cases:[string|null,string|null,boolean][]=[
    ['1','Ana',true],['9007199254740993','Unknown Silva',true],['1',' Ana 2 ',true],
    ['0','Ana',false],['01','Ana',false],['-1','Ana',false],['1.0','Ana',false],['1 ','Ana',false],[null,'Ana',false],
    ['1',null,false],['1',reportWhitespace,false],
    ...['123','-1','null','undefined','N/A','UNKNOWN','desconhecido','sem operador','sem agente','NÃO IDENTIFICADO','nao identificado'].map(name=>['1',name,false] as [string,string,boolean])];
  for(const [i,[agent,name]]of cases.entries()){
    const id=i+300;
    await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente,cpf,email) OVERRIDING SYSTEM VALUE VALUES($1,'2026-10-20T12:00:00Z',$2,$3,$4)`,[id,name,i===0?'0':reportWhitespace,i===1?'invalid-but-nonblank':null]);
    await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) VALUES('semantics',$1,$2,$3,'fixture',$4)`,[String(id),target,id,agent]);
  }
  // Same source but another target is outside this report, including its mapping.
  await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) VALUES($1,'other-target','"other"."calls"',9999999,'fixture','1')`,[source]);
  const r=await new AdminReports(pool,'semantics',{schema:'raw',table:'olos_calls'}).read('2026-10-01','2026-10-31') as any;
  assert.equal(r.summary.calls,String(cases.length));assert.equal(r.period.identified_calls,String(cases.filter(c=>c[2]).length));assert.equal(r.period.operators,'2');
  assert.equal(r.period.with_cpf,'1');assert.equal(r.period.with_email,'1');assert.equal(r.period.not_queued,String(cases.length));
  const old=(await pool.query(await readFile('test/fixtures/admin-reports-before.sql','utf8'),['semantics','2026-10-01','2026-10-31',reportWhitespace,reportPlaceholder,target])).rows[0];
  for(const key of ['summary','period','daily','failed_reads'])assert.deepEqual(r[key],old[key]);
});
test('representative local history remains bounded; compare old/new and repeated range requests',async()=>{
  const size=Number(process.env.REPORT_BENCH_ROWS??200000);
  assert(Number.isInteger(size)&&size%10===0&&size>=200000&&size<=1600000,'Use 200000..1600000 synthetic rows, multiple of 10');
  const dense=process.env.REPORT_BENCH_DENSE==='1';
  await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE
    SELECT n,'2026-10-01T12:00:00Z'::timestamptz+(n%30)*interval '1 day',CASE WHEN $2 OR n%10=0 THEN 'Agente Teste' END FROM generate_series(1000,$1::int+999) n`,[size,dense]);
  await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id)
    SELECT $1,n::text,$2,n,'synthetic',CASE WHEN $4 THEN ((n/30)%1000+1)::text WHEN n%10=0 THEN '7' ELSE '0' END FROM generate_series(1000,$3::int+999) n`,[source,target,size,dense]);
  await pool.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin)
    SELECT $1,n::text,n,'synthetic','{}',repeat('a',64),'pending','capture' FROM generate_series(1000,$2::int+999) n`,[source,size]);
  // Finish fixture bulk-write I/O before measuring reporting on an existing history.
  // Test-only maintenance, never issued by AdminReports or against an existing DB.
  await pool.query('CHECKPOINT');
  await pool.query('ANALYZE raw.olos_calls; ANALYZE olos_http.records; ANALYZE olos_http.corporate_outbox');
  let query='',parameters:unknown[]=[];
  const traced={async connect(){const db=await pool.connect();return {async query(sql:string,values?:unknown[]){
    if(sql.startsWith('WITH classified')){query=sql;parameters=values??[];
      if(process.env.REPORT_BENCH_EXPLAIN==='1'){
        const plan=(await db.query(`EXPLAIN (SETTINGS, FORMAT JSON) ${sql}`,values)).rows[0];
        const path=`/tmp/admin-reports-estimated-${process.pid}.json`;await writeFile(path,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(`REPORT_PLAN ${path}`);
      }
    }return db.query(sql,values);
  },release(){db.release();}};}} as unknown as pg.Pool;
  const r=new AdminReports(traced,source,{schema:'raw',table:'olos_calls'}),start=performance.now(),first=await read(r),duration=performance.now()-start;
  assert.equal(first.summary.calls,String(size+13));assert.equal(first.period.calls,String(size+9));assert.equal(first.period.identified_calls,String((dense?size:size/10)+3));
  if(dense)assert.equal(first.summary.operators,'1001');
  const cachedStart=performance.now();assert.deepEqual(await read(r),first);
  const cachedMs=performance.now()-cachedStart;
  const other=await r.read('2026-09-01','2026-09-30') as any;assert.equal(other.period.calls,'1');assert.deepEqual(other.summary,first.summary);
  const baselineSql=await readFile('test/fixtures/admin-reports-before.sql','utf8');
  const baselineValues=[source,'2026-10-01','2026-10-31',reportWhitespace,reportPlaceholder,target];
  const db=await pool.connect();let oldMs:number|null=null,oldError:string|null=null;
  try{
    await db.query("SET statement_timeout='5s'");const oldStart=performance.now();
    try{const old=(await db.query(baselineSql,baselineValues)).rows[0];oldMs=performance.now()-oldStart;
      for(const key of ['summary','period','daily','failed_reads'])assert.deepEqual(first[key],old[key],key);
    }catch(error){if((error as any).code!=='57014')throw error;oldError='statement_timeout';}
    if(process.env.REPORT_BENCH_EXPLAIN==='1'){
      for(const [name,sql,values] of [['new',query,parameters],['before',baselineSql,baselineValues]] as const){
        await db.query(name==='new'?'SET jit=off':'RESET jit');
        await db.query(`SET statement_timeout='${name==='new'?reportStatementTimeoutMs:5000}ms'`);
        try{const plan=(await db.query(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF, FORMAT JSON) ${sql}`,values)).rows[0];
          const path=`/tmp/admin-reports-${name}-${process.pid}.json`;await writeFile(path,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(`REPORT_PLAN ${path}`);
        }catch(error){if((error as any).code!=='57014')throw error;console.log(`REPORT_PLAN ${name}: statement_timeout`);}
      }
    }
  }finally{await db.query('RESET statement_timeout');await db.query('RESET jit');db.release();}
  console.log(`REPORT_BENCH ${JSON.stringify({synthetic_local_records:size+13,dense_1000_operators:dense,after_fixture_checkpoint:true,query_ms:Math.round(duration),cached_ms:Math.round(cachedMs),before_ms:oldMs===null?null:Math.round(oldMs),before_error:oldError,statement_timeout_ms:reportStatementTimeoutMs,before_statement_timeout_ms:5000})}`);
});
