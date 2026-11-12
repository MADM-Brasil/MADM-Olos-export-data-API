import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { DateTime } from 'luxon';
import { columns, digest, type Row } from '../src/corporate-sync/mapping.js';
import { corporateReportFormat, reportRowProof, type CorporateReportData } from '../src/admin/corporate-reports.js';
import { ReportUpdater } from '../src/admin/report-updater.js';
import { AdminReports } from '../src/admin/reports.js';
import { reportHttp } from './fixtures/report-http.js';
import { reportContract, reportDataHash } from '../src/admin/report-snapshot.js';
// @ts-expect-error Static browser JavaScript is checked separately by typecheck:admin.
import { reportModel, reportCsv, chartRange, reportQuickRange } from '../admin/public/ui.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_reports_test')throw new Error('Use disposable scripts/test-admin-reports.sh');
const local=new pg.Pool({connectionString:url,max:6});
const remoteUrl=new URL(url);remoteUrl.pathname='/madm_reports_test';
const owner=new pg.Pool({connectionString:remoteUrl.toString(),max:3});
const source='corporate-report-fixture',dest={schema:'raw',table:'olos_calls'},target='"raw"."olos_calls"';
let remote:pg.Pool;
let today:string;
const rows:Row[]=[];
const format=()=>corporateReportFormat(remote,'test-corporate-source','America/Sao_Paulo');
const reader=()=>new AdminReports(local,source,dest,undefined,format());
const force=()=>local.query("UPDATE olos_http.report_snapshot_state SET next_attempt_at='-infinity' WHERE source_key=$1 AND contract_version=2",[source]);
async function publish(pool=local,f=format()) {
  await force();const updater=new ReportUpdater(pool,source,dest,f);
  try{const result=await updater.refreshOnce();assert.equal(result.state,'published',JSON.stringify(result));return result;}finally{await updater.stop();}
}
function intercept(pool:pg.Pool,hook:(sql:string,values:unknown[]|undefined,db:pg.PoolClient)=>Promise<pg.QueryResult|undefined>) {
  return {async connect(){const db=await pool.connect();return {on:db.on.bind(db),removeListener:db.removeListener.bind(db),async query(sql:string,values?:unknown[]){return await hook(sql,values,db)??db.query(sql,values);},release(destroy?:boolean){db.release(destroy);}};}} as unknown as pg.Pool;
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function authorities() {
  return JSON.stringify([(await local.query(`SELECT (SELECT jsonb_agg(r ORDER BY source_id) FROM olos_http.records r) records,
    (SELECT jsonb_agg(o ORDER BY source_id) FROM olos_http.corporate_outbox o) outbox,
    (SELECT jsonb_agg(q ORDER BY source_id) FROM olos_http.corporate_collision_quarantine q) quarantine,
    (SELECT jsonb_agg(d ORDER BY internal_id_olos) FROM raw.olos_calls d) calls,
    (SELECT jsonb_agg(r ORDER BY id) FROM olos_http.reads r) reads`)).rows,
    (await owner.query('SELECT jsonb_agg(d ORDER BY raw_olos_call_id) calls FROM raw.olos_calls d')).rows]);
}
const range=(days:number)=>({from:DateTime.fromISO(today).minus({days:days-1}).toISODate()!,to:today});
before(async()=>{
  await local.query('CREATE DATABASE madm_reports_test');
  await local.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE');
  await local.query(await readFile('test/fixtures/admin-reports.sql','utf8'));
  await local.query(await readFile('admin/migrations/003_report_snapshots.sql','utf8'));
  await local.query('CREATE TABLE olos_http.corporate_collision_quarantine(source_key text,source_id text,PRIMARY KEY(source_key,source_id))');
  await owner.query(`CREATE SCHEMA raw;CREATE TABLE raw.olos_calls (
    raw_olos_call_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,internal_id_olos integer UNIQUE,
    olos_call_id text,data_ligacao timestamptz,telefone text,nome_agente text,id_campanha_olos text,nome_campanha_olos text,
    id_tabulacao_olos text,nome_tabulacao_olos text,cpf text,lead_id_origem text,tma_origem integer,razao_desligamento text,email text)`);
  await owner.query('CREATE ROLE corporate_reports_reader LOGIN;GRANT USAGE ON SCHEMA raw TO corporate_reports_reader;GRANT SELECT ON raw.olos_calls TO corporate_reports_reader;GRANT SET ON PARAMETER temp_file_limit TO corporate_reports_reader');
  const readUrl=new URL(remoteUrl);readUrl.username='corporate_reports_reader';
  remote=new pg.Pool({connectionString:readUrl.toString(),max:1,options:'-c default_transaction_read_only=on'});
  today=(await local.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS day")).rows[0].day;
  for(let i=1;i<=12;i++) {
    const row=Object.fromEntries(columns.map(c=>[c,null])) as Row;
    Object.assign(row,{internal_id_olos:String(i),olos_call_id:'SAME_CALL_ID',data_ligacao:DateTime.fromISO(today,{zone:'America/Sao_Paulo'}).minus({days:i-1}).set({hour:12}).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'000Z'"),
      nome_agente:i===2?' UNKNOWN ':i===3?'\u00a0Unknown Silva\u00a0':`PRIVATE Nome ${i}`,telefone:'PRIVATE_PHONE',cpf:i%2?' \u00a0 ':'PRIVATE_CPF',email:i%3?'PRIVATE_EMAIL':null,
      id_campanha_olos:'9',nome_campanha_olos:'Campanha',tma_origem:'10'});
    rows.push(row);
    const remoteId=(await owner.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,n)=>'$'+(n+1)).join(',')}) RETURNING raw_olos_call_id::text`,columns.map(c=>row[c]))).rows[0].raw_olos_call_id;
    const agent=i===4?'007':i===5?'0':i===6?null:i===3?'9007199254740993':'7';
    await local.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) VALUES($1,$2,$3,$4,repeat('a',64),$5)",[source,String(i),target,i,agent]);
    const confirmed=i<=6||i===10;
    await local.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at)
      VALUES($1,$2,$3,repeat('a',64),$4,$5,$6,'capture',$7,$8)`,[source,String(i),i,JSON.stringify(row),digest(row),confirmed?'confirmed':i===12?'skipped':'pending',confirmed?remoteId:null,confirmed?new Date():null]);
  }
  // Local destination stopped long ago; it must never govern corporate dates or totals.
  await local.query("INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente) OVERRIDING SYSTEM VALUE VALUES(1,'2000-01-01','Local old')");
  await local.query("INSERT INTO olos_http.corporate_collision_quarantine VALUES($1,'11')",[source]);
  await local.query("INSERT INTO olos_http.reads(id,source_key,target_table,spec,error_code) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'{}','FIXTURE')",[source,target]);
  // Manual rows have no local record, some share CallId. NULL internal IDs are not identities.
  await owner.query("INSERT INTO raw.olos_calls(internal_id_olos,olos_call_id,data_ligacao,nome_agente,cpf,email) VALUES(NULL,'SAME_CALL_ID',$1,'PRIVATE Nome 1','PRIVATE_CPF','PRIVATE_EMAIL'),(NULL,'SAME_CALL_ID',$1,'PRIVATE Nome 1',NULL,NULL),(NULL,'UNDATED',NULL,'PRIVATE Nome 1',NULL,NULL)",[rows[0]!.data_ligacao]);
});
after(async()=>{await remote?.end();await owner.end();await local.end();});

test('v2 corporate totals include NULL IDs and repeated CallId; v1 generations remain byte-for-byte intact',async()=>{
  const v1=new ReportUpdater(local,source,dest);assert.equal((await v1.refreshOnce()).state,'published');await v1.stop();
  const old=JSON.stringify((await local.query('SELECT * FROM olos_http.report_snapshots WHERE contract_version=1')).rows);
  await assert.rejects(reader().read(today,today),/REPORT_INITIALIZING/);
  const before=await authorities();await publish();const r=await reader().read(range(30).from,today) as any;
  assert.equal(r.snapshot_contract_version,2);assert.equal(r.calls_source,'madm.raw.olos_calls');
  assert.equal(r.period.calls,'14');assert.equal(r.summary.calls,'15');assert.equal(r.summary.undated,'1');
  assert.equal(r.period.identified_calls,'8');assert.equal(r.period.operators,'2');
  assert.equal(r.period.confirmed,'7');assert.equal(r.period.pending,'4');assert.equal(r.summary.inconsistent,'1');
  assert.equal(r.operational.quarantined,'1');assert.equal(r.operational.summary.calls,'12');assert.equal(r.failed_reads,'1');
  assert.equal((await reader().today()).calls,'12');assert.equal(await authorities(),before);
  const data=(await local.query('SELECT data FROM olos_http.report_snapshots WHERE contract_version=2')).rows[0].data;
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE|SAME_CALL_ID|Nome|PHONE|EMAIL|CPF/);
  assert.equal(JSON.stringify((await local.query('SELECT * FROM olos_http.report_snapshots WHERE contract_version=1')).rows),old);
  assert.equal((await new AdminReports(local,source,dest).read('2000-01-01','2000-01-01') as any).snapshot_contract_version,1);assert.equal(reportContract,'olos-admin-reports/v1');
});
test('daily totals, presets/custom, graphs/tables and CSV agree with direct corporate SQL',async()=>{
  for(const days of [1,7,14,15,30,65]) {
    const {from,to}=range(days),r=await reader().read(from,to) as any;
    const expected=(await owner.query(`SELECT count(*)::text calls,count(*) FILTER(WHERE btrim(cpf,$3)<>'')::text with_cpf,
      count(*) FILTER(WHERE btrim(email,$3)<>'')::text with_email FROM raw.olos_calls
      WHERE (data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2`,[from,to,' \u00a0'])).rows[0];
    for(const key of ['calls','with_cpf','with_email'])assert.equal(r.period[key],expected[key],`${days} ${key}`);
    const model=reportModel(r);assert.equal(model.total.toString(),r.period.calls);assert.equal(model.series.length,days);
    const daily=(await owner.query(`SELECT (data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,count(*)::text AS calls
      FROM raw.olos_calls WHERE (data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2 GROUP BY day`,[from,to])).rows;
    for(const d of daily)assert.equal(r.daily.find((v:any)=>v.day===d.day).calls,d.calls);
    const csv=reportCsv(r.daily,2);assert.match(csv,/Chamadas únicas \(MADM\)/);assert.match(csv,/Confirmadas.*\(local\)/);assert.doesNotMatch(csv,/PRIVATE|operator_ids/);
    assert.equal(csv.split('\r\n').length,r.daily.length+1);
  }
  for(const days of [1,7,14,30])assert.equal(chartRange(days,new Date(today+'T12:00:00Z')).from,range(days).from);
  for(const days of [1,7,15,30])assert.equal(reportQuickRange(days,new Date(today+'T12:00:00Z')).from,range(days).from);
});
test('Brazil midnight boundaries and historical inserts/updates/deletes are recomputed without high-watermark assumptions',async()=>{
  const from=range(60).from;
  await owner.query("INSERT INTO raw.olos_calls(data_ligacao,nome_agente) VALUES(($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')-interval '1 microsecond','PRIVATE'),($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo','PRIVATE')",[from]);
  await publish();let r=await reader().read(from,from) as any;assert.equal(r.period.calls,'1');
  await owner.query("UPDATE raw.olos_calls SET data_ligacao=$1::date::timestamp AT TIME ZONE 'America/Sao_Paulo' WHERE data_ligacao=($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')-interval '1 microsecond'",[from]);
  await publish();r=await reader().read(from,from) as any;assert.equal(r.period.calls,'2');
  await owner.query("DELETE FROM raw.olos_calls WHERE data_ligacao=$1::date::timestamp AT TIME ZONE 'America/Sao_Paulo'",[from]);
  await publish();assert.equal((await reader().read(from,from) as any).period.calls,'0');
});
test('payload divergence or an ID collision cannot confer AgentId; corporate rows remain counted',async()=>{
  await owner.query("UPDATE raw.olos_calls SET olos_call_id='DIFFERENT_CALL' WHERE internal_id_olos=1");
  await publish();const r=await reader().read(today,today) as any;
  assert.equal(r.period.calls,'3');assert.equal(r.period.identified_calls,'0');assert.equal(r.period.confirmed,'1');
  await owner.query("UPDATE raw.olos_calls SET olos_call_id='SAME_CALL_ID' WHERE internal_id_olos=1");await publish();
  assert.equal((await reader().read(today,today) as any).period.identified_calls,'1');
});
test('only snapshots are needed after reader restart and no HTTP request contacts MADM or scans historical sources',async()=>{
  await local.query('CREATE ROLE corporate_snapshot_http LOGIN;GRANT USAGE ON SCHEMA olos_http TO corporate_snapshot_http;GRANT SELECT ON olos_http.report_snapshots,olos_http.report_snapshot_state TO corporate_snapshot_http');
  const u=new URL(url!);u.username='corporate_snapshot_http';const pool=new pg.Pool({connectionString:u.toString(),max:1});
  const forbidden={connect(){throw new Error('HTTP MUST NOT CONTACT MADM');}} as unknown as pg.Pool;
  const r=new AdminReports(pool,source,dest,undefined,corporateReportFormat(forbidden,'test-corporate-source'));
  try{assert.equal((await r.read(today,today) as any).period.calls,'3');assert.equal((await r.today()).calls,'12');
    const server=await reportHttp(r);try{const result=await server.request(`/api/reports?from=${today}&to=${today}`);assert.equal(result.status,200);assert.equal((result.data.period as any).calls,'3');}finally{await server.close();}
    await assert.rejects(pool.query('SELECT * FROM olos_http.records'),/permission denied/);
  }finally{await pool.end();}
});
test('corporate connection loss retains pointer and recovers on next generation; corrupt frozen payload blocks publication',async()=>{
  const prior=(await local.query('SELECT published_id FROM olos_http.report_snapshot_state WHERE contract_version=2')).rows[0].published_id;
  const failing={async connect(){throw new Error('PRIVATE credentials');}} as unknown as pg.Pool;
  await force();const updater=new ReportUpdater(local,source,dest,corporateReportFormat(failing,'test-corporate-source'));
  const result=await updater.refreshOnce();await updater.stop();assert.equal(result.state,'failed');assert.doesNotMatch(result.code!,/PRIVATE/);
  assert.equal((await local.query('SELECT published_id FROM olos_http.report_snapshot_state WHERE contract_version=2')).rows[0].published_id,prior);await publish();
  await local.query("UPDATE olos_http.corporate_outbox SET payload_hash=repeat('0',64) WHERE source_id='1'");
  try{await force();const invalid=new ReportUpdater(local,source,dest,format());assert.equal((await invalid.refreshOnce()).code,'REPORT_LOCAL_PAYLOAD_INVALID');await invalid.stop();}
  finally{await local.query('UPDATE olos_http.corporate_outbox SET payload_hash=$1 WHERE source_id=\'1\'',[digest(rows[0]!)]);}
  await publish();
});
test('two updaters exclude each other; readers see the complete previous generation until atomic commit',async()=>{
  const old=(await reader().read(today,today) as any).snapshot_id,entered=deferred(),release=deferred();
  const blocking=intercept(local,async sql=>{if(sql==='COMMIT'){entered.resolve();await release.promise;}return undefined;});
  await force();const a=new ReportUpdater(blocking,source,dest,format()),b=new ReportUpdater(local,source,dest,format());
  const pending=a.refreshOnce();await entered.promise;
  try{assert.equal((await b.refreshOnce()).state,'busy');assert.equal((await reader().read(today,today) as any).snapshot_id,old);}
  finally{release.resolve();}
  assert.equal((await pending).state,'published');await a.stop();await b.stop();
  assert.notEqual((await reader().read(today,today) as any).snapshot_id,old);
});
test('failed local publication rolls back all new aggregates; uncertain COMMIT is reconciled through the durable pointer',async()=>{
  const prior=(await reader().read(today,today) as any).snapshot_id;
  const broken=intercept(local,async sql=>{if(sql.startsWith('UPDATE olos_http.report_snapshot_state SET published_id'))throw new Error('publication failed');return undefined;});
  await force();const a=new ReportUpdater(broken,source,dest,format());assert.equal((await a.refreshOnce()).state,'failed');await a.stop();assert.equal((await reader().read(today,today) as any).snapshot_id,prior);
  const ackLost=intercept(local,async(sql,values,db)=>{if(sql==='COMMIT'){await db.query(sql,values);throw new Error('lost ack');}return undefined;});
  await force();const b=new ReportUpdater(ackLost,source,dest,format());assert.equal((await b.refreshOnce()).state,'commit_unknown');await b.stop();
  assert.notEqual((await reader().read(today,today) as any).snapshot_id,prior);
  const restart=new ReportUpdater(local,source,dest,format());assert.equal((await restart.refreshOnce()).state,'not_due');await restart.stop();
});
test('remote queries are read only and least-privilege; source mismatch and malformed snapshot are refused',async()=>{
  await assert.rejects(remote.query("UPDATE raw.olos_calls SET nome_agente='corrupt'"),/read-only|permission denied/);
  await assert.rejects(remote.query('CREATE TABLE public.forbidden(id integer)'),/read-only|permission denied/);
  await assert.rejects(new AdminReports(local,source,dest,undefined,corporateReportFormat(remote,'wrong-source')).read(today,today),/REPORT_SNAPSHOT_INVALID/);
  const data=(await local.query('SELECT data FROM olos_http.report_snapshots WHERE id=(SELECT published_id FROM olos_http.report_snapshot_state WHERE contract_version=2)')).rows[0].data as CorporateReportData;
  assert.equal(reportDataHash(format().validate(data)),reportDataHash(data));
  for(const invalid of [{...data,cpf:'PRIVATE'},{...data,quarantined:'-1'},{...data,operational:{...data.operational,today_calls:'999'}},{...data,corporate_source:'wrong'}])assert.throws(()=>format().validate(invalid),/REPORT_SNAPSHOT_INVALID/);
  const special={...rows[0]!,nome_agente:'É "\n名',email:null} as Row;assert.equal(reportRowProof(special).length,64);
});
test('wall timestamps demand explicit semantics; RLS and wrong corporate key cannot yield a partial total',async()=>{
  await owner.query('ALTER TABLE raw.olos_calls ALTER COLUMN data_ligacao TYPE timestamp USING data_ligacao AT TIME ZONE \'America/Sao_Paulo\'');
  try{
    await force();const uncertain=new ReportUpdater(local,source,dest,corporateReportFormat(remote,'test-corporate-source'));assert.equal((await uncertain.refreshOnce()).code,'REPORT_TIMESTAMP_SEMANTICS_REQUIRED');await uncertain.stop();
    // Existing payloads are UTC; changing corporate timestamp semantics must not
    // silently preserve operator attribution, but all corporate totals remain exact.
    await publish();assert.equal((await reader().read(today,today) as any).period.calls,'3');
  }finally{await owner.query('ALTER TABLE raw.olos_calls ALTER COLUMN data_ligacao TYPE timestamptz USING data_ligacao AT TIME ZONE \'America/Sao_Paulo\'');}
  await owner.query('ALTER TABLE raw.olos_calls ENABLE ROW LEVEL SECURITY');
  try{await force();const rls=new ReportUpdater(local,source,dest,format());assert.equal((await rls.refreshOnce()).code,'REPORT_CORPORATE_SCHEMA_INVALID');await rls.stop();}
  finally{await owner.query('ALTER TABLE raw.olos_calls DISABLE ROW LEVEL SECURITY');}
  await publish();
});
test('missing optional outbox/quarantine is unavailable, never fabricated zero; MADM totals continue',async()=>{
  await local.query('ALTER TABLE olos_http.corporate_outbox RENAME TO hidden_outbox;ALTER TABLE olos_http.corporate_collision_quarantine RENAME TO hidden_quarantine');
  try{await publish();const r=await reader().read(today,today) as any;assert.equal(r.period.calls,'3');assert.equal(r.outbox_available,false);assert.equal(r.period.confirmed,null);assert.equal(r.operational.quarantined,null);assert.equal(r.operational.summary.undated,'11');assert.equal((await reader().today()).calls,'12');}
  finally{await local.query('ALTER TABLE olos_http.hidden_outbox RENAME TO corporate_outbox;ALTER TABLE olos_http.hidden_quarantine RENAME TO corporate_collision_quarantine');}
  await publish();
});

test('remote session termination, timeout and lost privileges preserve the last generation and recover',async()=>{
  const previous=(await reader().read(today,today) as any).snapshot_id;
  const entered=deferred(),release=deferred();let pid=0;
  const killed=intercept(remote,async(sql,values,db)=>{
    if(sql.startsWith('WITH proofs')){pid=(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;entered.resolve();await release.promise;}
    return undefined;
  });
  await force();const updater=new ReportUpdater(local,source,dest,corporateReportFormat(killed,'test-corporate-source','America/Sao_Paulo'));
  const pending=updater.refreshOnce();await entered.promise;
  await owner.query('SELECT pg_terminate_backend($1)',[pid]);release.resolve();assert.equal((await pending).state,'failed');await updater.stop();
  assert.equal((await reader().read(today,today) as any).snapshot_id,previous);
  const timeout=intercept(remote,async sql=>{if(sql.startsWith('WITH proofs'))throw Object.assign(new Error('SQL/private timeout'),{code:'57014'});return undefined;});
  await force();const timed=new ReportUpdater(local,source,dest,corporateReportFormat(timeout,'test-corporate-source','America/Sao_Paulo'));
  assert.equal((await timed.refreshOnce()).code,'REPORT_CORPORATE_TIMEOUT');await timed.stop();
  await owner.query('REVOKE SELECT ON raw.olos_calls FROM corporate_reports_reader');
  try{await force();const denied=new ReportUpdater(local,source,dest,format());assert.equal((await denied.refreshOnce()).code,'REPORT_CORPORATE_PERMISSION_REQUIRED');await denied.stop();}
  finally{await owner.query('GRANT SELECT ON raw.olos_calls TO corporate_reports_reader');}
  assert.equal((await reader().read(today,today) as any).snapshot_id,previous);await publish();
});
test('shutdown during remote collection never publishes a partial generation; restart rebuilds once',async()=>{
  const old=(await reader().read(today,today) as any).snapshot_id,entered=deferred(),release=deferred();
  const blocked=intercept(remote,async sql=>{if(sql.startsWith('WITH proofs')){entered.resolve();await release.promise;}return undefined;});
  await force();const updater=new ReportUpdater(local,source,dest,corporateReportFormat(blocked,'test-corporate-source','America/Sao_Paulo'));
  const pending=updater.refreshOnce();await entered.promise;const stopping=updater.stop();release.resolve();
  assert.equal((await pending).state,'stopped');await stopping;assert.equal((await reader().read(today,today) as any).snapshot_id,old);
  await publish();assert.notEqual((await reader().read(today,today) as any).snapshot_id,old);
  const again=new ReportUpdater(local,source,dest,format());assert.equal((await again.refreshOnce()).state,'not_due');await again.stop();
});
test('UTF-8 proof parity and invalid frozen dates are handled without exposing names or losing corporate rows',async()=>{
  const original=rows[0]!,special={...original,nome_agente:'\u00a0É "\n名 😀\u00a0'};
  await local.query('UPDATE olos_http.corporate_outbox SET payload=$1,payload_hash=$2 WHERE source_id=\'1\'',[JSON.stringify(special),digest(special)]);
  await owner.query('UPDATE raw.olos_calls SET nome_agente=$1 WHERE internal_id_olos=1',[special.nome_agente]);
  try{await publish();assert.equal((await reader().read(today,today) as any).period.identified_calls,'1');}
  finally{await local.query('UPDATE olos_http.corporate_outbox SET payload=$1,payload_hash=$2 WHERE source_id=\'1\'',[JSON.stringify(original),digest(original)]);await owner.query('UPDATE raw.olos_calls SET nome_agente=$1 WHERE internal_id_olos=1',[original.nome_agente]);}
  const pending=rows[10]!,bad={...pending,data_ligacao:'2026-99-99T12:00:00.000000Z'};
  await local.query('UPDATE olos_http.corporate_outbox SET payload=$1,payload_hash=$2 WHERE source_id=\'11\'',[JSON.stringify(bad),digest(bad)]);
  try{await publish();const r=await reader().read(range(30).from,today) as any;assert.equal(r.period.calls,'14');assert.equal(r.operational.summary.undated,'1');assert.equal(r.period.pending,'3');}
  finally{await local.query('UPDATE olos_http.corporate_outbox SET payload=$1,payload_hash=$2 WHERE source_id=\'11\'',[JSON.stringify(pending),digest(pending)]);}
  await publish();
});

test('ambiguous receipts refuse publication; inconsistent local source hash remains visible without assigning an operator',async()=>{
  const duplicate={...rows[0]!,internal_id_olos:'97'};
  await owner.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>duplicate[c]));
  await local.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id) VALUES($1,'ambiguous',$2,97,repeat('a',64),'7')",[source,target]);
  await local.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at)
    SELECT source_key,'ambiguous',97,source_hash,$1,$2,'confirmed','capture',remote_raw_id,confirmed_at FROM olos_http.corporate_outbox WHERE source_id='1'`,[JSON.stringify(duplicate),digest(duplicate)]);
  try{await force();const updater=new ReportUpdater(local,source,dest,format());assert.equal((await updater.refreshOnce()).code,'REPORT_IDENTITY_AMBIGUOUS');await updater.stop();}
  finally{await local.query("DELETE FROM olos_http.corporate_outbox WHERE source_id='ambiguous';DELETE FROM olos_http.records WHERE source_id='ambiguous'");await owner.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=97');}
  await local.query("UPDATE olos_http.records SET source_hash='DIVERGENT' WHERE source_id='1'");
  try{await publish();const r=await reader().read(today,today) as any;assert.equal(r.period.calls,'3');assert.equal(r.period.identified_calls,'0');assert.equal(r.period.confirmed,'0');assert.equal(r.period.inconsistent,'1');}
  finally{await local.query("UPDATE olos_http.records SET source_hash=repeat('a',64) WHERE source_id='1'");}
  await publish();
});
test('operational rows without outbox preserve a known local date and never enter MADM call totals',async()=>{
  await local.query("INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao) OVERRIDING SYSTEM VALUE VALUES(90,'2020-05-01T12:00:00Z')");
  await local.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,created_at) VALUES($1,'90',$2,90,'legacy','2000-01-01')",[source,target]);
  try{await publish();const r=await reader().read('2020-05-01','2020-05-01') as any;assert.equal(r.period.calls,'0');assert.equal(r.period.not_queued,'1');assert.equal(r.operational.period.calls,'1');assert.equal(r.daily[0].day,'2020-05-01');assert.equal(r.daily[0].calls,'0');reportModel(r);}
  finally{await local.query("DELETE FROM olos_http.records WHERE source_id='90';DELETE FROM raw.olos_calls WHERE internal_id_olos=90");}
  await publish();
});

test('mapped legacy rows without outbox retain AgentId only after complete normalized corporate equivalence',async()=>{
  const payload={...rows[0]!,internal_id_olos:'91',data_ligacao:'2020-05-02T12:00:00.000000Z',nome_agente:'Legacy operador',tma_origem:'11'};
  await owner.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>payload[c]));
  await local.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) OVERRIDING SYSTEM VALUE VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>c==='tma_origem'?'10.5':payload[c]));
  await local.query("INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,created_at) VALUES($1,'91',$2,91,'legacy','21','2000-01-01')",[source,target]);
  try{
    await publish();let r=await reader().read('2020-05-02','2020-05-02') as any;assert.equal(r.period.calls,'1');assert.equal(r.period.identified_calls,'1');assert.equal(r.period.operators,'1');assert.equal(r.period.confirmed,'0');assert.equal(r.period.not_queued,'1');
    await owner.query("UPDATE raw.olos_calls SET email='CHANGED' WHERE internal_id_olos=91");
    await publish();r=await reader().read('2020-05-02','2020-05-02') as any;assert.equal(r.period.calls,'1');assert.equal(r.period.identified_calls,'0');
  }finally{await local.query("DELETE FROM olos_http.records WHERE source_id='91';DELETE FROM raw.olos_calls WHERE internal_id_olos=91");await owner.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=91');}
  await publish();
});

if(process.env.REPORT_CORPORATE_BENCH==='1')test('synthetic scale: 2M local records and 50K verified corporate calls; persisted HTTP remains bounded',async()=>{
  const benchSource='corporate-report-benchmark',count=50_000;
  const template={...rows[0]!,nome_agente:'Synthetic operador',telefone:'SYNTHETIC',cpf:null,email:'synthetic@example.invalid'};
  const inserted=(await owner.query(`INSERT INTO raw.olos_calls(${columns.join(',')})
    SELECT (1000000+n)::integer,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::integer,$12,$13
    FROM generate_series(1,$14) n RETURNING raw_olos_call_id::text,internal_id_olos::text`,[...columns.filter(c=>c!=='internal_id_olos').map(c=>template[c]),count])).rows;
  for(let i=0;i<inserted.length;i+=1000){
    const batch=inserted.slice(i,i+1000).map(r=>{const payload={...template,internal_id_olos:r.internal_id_olos};return {raw_id:r.raw_olos_call_id,target_id:r.internal_id_olos,payload,payload_hash:digest(payload)};});
    await local.query(`WITH batch AS (SELECT * FROM jsonb_to_recordset($1::jsonb) b(target_id bigint,raw_id bigint,payload jsonb,payload_hash text)),
      records AS (INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,created_at)
        SELECT $2,target_id::text,$3,target_id,repeat('a',64),'7','2000-01-01' FROM batch RETURNING source_id)
      INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at)
        SELECT $2,target_id::text,target_id,repeat('a',64),payload,payload_hash,'confirmed','capture',raw_id,now() FROM batch`,[JSON.stringify(batch),benchSource,target]);
  }
  await local.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,created_at)
    SELECT $1,'unmapped-'||n,$2,1000000000+n,repeat('b',64),'2000-01-01' FROM generate_series(1,2000000) n`,[benchSource,target]);
  await local.query('ANALYZE olos_http.records;ANALYZE olos_http.corporate_outbox');await owner.query('ANALYZE raw.olos_calls');
  const started=performance.now(),updater=new ReportUpdater(local,benchSource,dest,format());
  const result=await updater.refreshOnce(),refreshMs=performance.now()-started;await updater.stop();assert.equal(result.state,'published',JSON.stringify(result));
  const r=new AdminReports(local,benchSource,dest,undefined,format()),server=await reportHttp(r),samples:number[]=[];
  try{for(let i=0;i<60;i++){const start=performance.now(),response=await server.request(`/api/reports?from=${today}&to=${today}`);assert.equal(response.status,200);assert.equal((response.data.period as any).calls,'50003');assert.equal((response.data.period as any).identified_calls,String(count));assert.equal((response.data.period as any).operators,'1');samples.push(performance.now()-start);}}
  finally{await server.close();}
  samples.sort((a,b)=>a-b);
  const evidence={synthetic:true,local_records:2_050_000,verified_corporate_calls:count,refresh_ms:refreshMs,http_p95_ms:samples[Math.ceil(samples.length*.95)-1],http_max_ms:samples.at(-1),http_requests:samples.length,process_rss_mib:process.memoryUsage().rss/1048576,
    limits:'Two disposable databases on one PostgreSQL 16 instance; loopback, warm cache. Driver RSS includes fixture creation. No WAN, OLOS, delivery or sustained ingestion load.'};
  console.log('CORPORATE_REPORT_BENCHMARK '+JSON.stringify(evidence));
  assert(refreshMs<20_000,JSON.stringify(evidence));assert(evidence.http_p95_ms!<500,JSON.stringify(evidence));assert(evidence.http_max_ms!<1000,JSON.stringify(evidence));
});
