import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { AdminReports, reportRange } from '../src/admin/reports.js';
import { countFields, sealReportData, validateReportData, reportDataHash, reportValidationMetadata, type ReportDay } from '../src/admin/report-snapshot.js';
import { reportRetryMs } from '../src/admin/report-updater.js';
const date='2026-11-10',checked=new Date(date+'T12:00:00Z');
function day(at:string|null,calls:string,ids:string[]):ReportDay {
  return {...Object.fromEntries(countFields.map(f=>[f,'0'])),day:at,calls,identified_calls:ids.length?'1':'0',operator_ids:ids.length?ids:null,
    pending:calls,collected_today:'0'} as ReportDay;
}
function row() {
  const data=sealReportData({days:[day('2026-11-09','9007199254740993',['9007199254740993123']),day(date,'2',['7']),day(null,'1',['7'])],
    failed_reads:'2',observed_at:date+'T11:59:00.000Z',outbox_available:true,collection_date:date});
  return {id:'11111111-1111-4111-8111-111111111111',published_id:'11111111-1111-4111-8111-111111111111',contract_version:1,contract_name:'olos-admin-reports/v1',timezone:'America/Sao_Paulo',data,
    observed_at:new Date(data.observed_at),published_at:new Date(date+'T11:59:10Z'),collection_date:date,data_hash:reportDataHash(data),checked_at:checked,
    incompatible:false,validation:reportValidationMetadata(data),refresh_status:'ready',last_error:null,next_attempt_at:null,payload_bytes:Buffer.byteLength(JSON.stringify(data))};
}
function fake(value:unknown,gate:Promise<void>=Promise.resolve(),onSelect:()=>void=()=>{}) {
  let selects=0,connects=0;const queries:string[]=[];
  const pool={async connect(){connects++;return {on(){},removeListener(){},async query(sql:string){queries.push(sql);if(sql.startsWith('SELECT s.id')){selects++;onSelect();await gate;return {rows:[value]};}return {rows:[]};},release(){}};}} as unknown as Pool;
  return {pool,queries,counts:()=>({selects,connects})};
}
test('persistent reader: exact BigInt totals, private IDs, union, no historical SQL and restart without refresh',async()=>{
  const stored=row(),db=fake(stored),reader=new AdminReports(db.pool,'fixture',{schema:'raw',table:'olos_calls'});
  const result=await reader.read('2026-11-09',date) as {summary:{calls:string;operators:string;undated:string};period:{calls:string;operators:string};snapshot_state:string};
  assert.equal(result.summary.calls,'9007199254740996');assert.equal(result.period.calls,'9007199254740995');assert.equal(result.period.operators,'2');assert.equal(result.summary.operators,'2');assert.equal(result.summary.undated,'1');
  assert.equal(result.snapshot_state,'READY');assert.doesNotMatch(JSON.stringify(result),/operator_ids|9007199254740993123/);
  assert.equal((await reader.today()).calls,'0');
  assert(!db.queries.some(sql=>/WITH classified|raw\.|olos_http\.records|corporate_outbox/.test(sql)));
  assert.deepEqual((await new AdminReports(db.pool,'fixture',{schema:'raw',table:'olos_calls'}).read('2026-11-09',date)),result);
});
test('HTTP cache coalesces periods for 1s; it does not start a refresh and notices a new durable observation',async()=>{
  let release!:()=>void,now=0;const gate=new Promise<void>(r=>{release=r;}),db=fake(row(),gate);
  const reader=new AdminReports(db.pool,'fixture',{schema:'raw',table:'olos_calls'},()=>now);
  const requests=[reader.read(date,date),reader.read('2026-11-09',date),reader.today()];release();await Promise.all(requests);
  assert.equal(db.counts().selects,1);now=999;await reader.today();assert.equal(db.counts().selects,1);
  now=1000;await reader.today();assert.equal(db.counts().selects,2);
  assert(db.queries.includes('BEGIN READ ONLY'));assert.equal(db.queries.at(-1),'ROLLBACK');
});
test('missing, incompatible, migration absent and failed reads never fabricate a zero or query raw history',async()=>{
  for(const [value,code]of [[{...row(),id:null,published_id:null},'REPORT_INITIALIZING'],[{...row(),id:null,published_id:null,incompatible:true},'REPORT_SNAPSHOT_INCOMPATIBLE'],[{...row(),data_hash:'bad'},'REPORT_SNAPSHOT_INVALID']]) {
    const db=fake(value),reader=new AdminReports(db.pool,'fixture',{schema:'raw',table:'olos_calls'});
    await assert.rejects(reader.read(date,date),new RegExp(code as string));assert.equal(db.counts().selects,1);
    await assert.rejects(reader.today(),new RegExp(code as string));assert.equal(db.counts().selects,1);
  }
  const pool={async connect(){return {on(){},removeListener(){},async query(sql:string){if(sql.startsWith('SELECT s.id'))throw {code:'42P01'};return {rows:[]};},release(){}};}} as unknown as Pool;
  await assert.rejects(new AdminReports(pool,'fixture',{schema:'raw',table:'olos_calls'}).read(date,date),/REPORT_SNAPSHOT_MIGRATION_REQUIRED/);
});
test('old observations are explicitly stale, expire at 900s and cannot masquerade as today after midnight',async()=>{
  const stored=row();stored.checked_at=new Date(stored.observed_at.getTime()+301000);
  let now=0;const reader=new AdminReports(fake(stored).pool,'fixture',{schema:'raw',table:'olos_calls'},()=>now);
  assert.equal((await reader.read(date,date) as {snapshot_state:string}).snapshot_state,'STALE');
  stored.checked_at=new Date(stored.observed_at.getTime()+901000);now=1001;await assert.rejects(reader.read(date,date),/REPORT_SNAPSHOT_STALE/);
  const midnight=row();midnight.data.observed_at='2026-11-11T02:59:59.000Z';midnight.observed_at=new Date(midnight.data.observed_at);midnight.published_at=new Date('2026-11-11T02:59:59.500Z');midnight.data_hash=reportDataHash(midnight.data);midnight.checked_at=new Date('2026-11-11T03:00:00Z');
  const next=new AdminReports(fake(midnight).pool,'fixture',{schema:'raw',table:'olos_calls'});
  await assert.rejects(next.today(),/REPORT_SNAPSHOT_STALE/);assert.equal((await next.read(date,date) as {snapshot_state:string}).snapshot_state,'STALE');
});
test('snapshot validator rejects corruption, inconsistent partitions, duplicate IDs, personal fields and unknown shapes',()=>{
  const valid=row().data;assert.equal(reportDataHash(validateReportData(JSON.parse(JSON.stringify(valid)))),reportDataHash(valid));
  const variants:unknown[]=[{...valid,phone:'PRIVATE'}, {...valid,today_calls:'1'}, {...valid,summary:{...valid.summary,calls:'0'}}];
  variants.push({...valid,days:[{...valid.days[0],operator_ids:['7','7']}]});
  variants.push({...valid,days:[{...valid.days[0],pending:'0'}]});
  variants.push({...valid,days:[{...valid.days[0],operator_ids:null}]});
  for(const corrupt of variants)assert.throws(()=>validateReportData(corrupt),/REPORT_SNAPSHOT_INVALID/);
  for(const range of [['2026-02-30',date],[date,'2026-11-09'],['2025-01-01',date]])assert.throws(()=>reportRange(...range as [string,string]),/REPORT_PERIOD_INVALID/);
  assert.deepEqual([1,2,3,4].map(reportRetryMs),[30000,60000,300000,300000]);
});

test('whole-build deadline cancels only the updater connection and cannot publish after expiry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let enter!:()=>void,release!:()=>void,destroyed=0;
  const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
  const pool={async connect(){return {on(){},removeListener(){},async query(sql:string){
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{acquired:true}]};
    if(sql.startsWith('UPDATE olos_http.report_snapshot_state SET status=\'building\''))return {rows:[{failure_count:1}]};
    if(sql.includes('to_regclass'))return {rows:[{present:true,collection_date:'2026-11-10',start_at:checked,end_at:checked}]};
    if(sql.startsWith('WITH classified')){enter();await gate;throw new Error('closed connection');}
    return {rows:[]};
  },release(discard:boolean){assert(discard);destroyed++;}};}} as unknown as Pool;
  const {ReportUpdater}=await import('../src/admin/report-updater.js');
  const updater=new ReportUpdater(pool,'fixture',{schema:'raw',table:'olos_calls'}),pending=updater.refreshOnce();await entered;
  t.mock.timers.tick(40000);release();const result=await pending;
  assert.equal(result.state,'failed');assert.equal(result.code,'REPORT_BUILD_DEADLINE_EXCEEDED');assert.equal(destroyed,1);await updater.stop();
  assert.equal((await updater.refreshOnce()).state,'stopped');
});
test('new operational events expose only approved analytical metadata',async()=>{
  const {OperationalEvents}=await import('../src/admin/events.js');const events=new OperationalEvents();
  events.record({event:'report_snapshot_published',report_source:'a'.repeat(16),snapshot_id:'11111111-1111-4111-8111-111111111111',bytes:123,days:2,duration_ms:10,payload:'PRIVATE',source_key:'PRIVATE'});
  const output=events.snapshot();assert.equal(output.length,1);assert.equal(output[0]?.bytes,123);assert.doesNotMatch(JSON.stringify(output),/PRIVATE|payload|source_key/);
});

test('freshness includes time spent reading and decoding, so slow reads cannot extend the 900s limit',async()=>{
  const stored=row();stored.checked_at=new Date(stored.observed_at.getTime()+899500);
  let now=0,release!:()=>void,enter!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{enter=r;});
  const db=fake(stored,gate,enter),reader=new AdminReports(db.pool,'fixture',{schema:'raw',table:'olos_calls'},()=>now);
  const pending=assert.rejects(reader.read(date,date),/REPORT_SNAPSHOT_STALE/);await entered;now=1000;release();await pending;
});

test('a cached immutable generation is revalidated by header; changed hashes cannot reuse its data',async()=>{
  const value=row();let now=0;const db=fake(value),reader=new AdminReports(db.pool,'fixture',{schema:'raw',table:'olos_calls'},()=>now);
  await reader.read(date,date);now=1001;value.data_hash='corrupt';await assert.rejects(reader.read(date,date),/REPORT_SNAPSHOT_INVALID/);
});

test('HTTP read deadline bounds an unresponsive socket and releases it exactly once',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let enter!:()=>void,release!:()=>void,destroyed=0;
  const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
  const pool={async connect(){return {on(){},removeListener(){},async query(sql:string){if(sql.startsWith('SELECT s.id')){enter();await gate;throw new Error('socket unresponsive');}return {rows:[]};},release(discard:boolean){assert(discard);destroyed++;}};}} as unknown as Pool;
  const reader=new AdminReports(pool,'fixture',{schema:'raw',table:'olos_calls'});const failed=assert.rejects(reader.read(date,date),/REPORT_TIMEOUT/);await entered;
  t.mock.timers.tick(5000);release();await failed;assert.equal(destroyed,1);
});
