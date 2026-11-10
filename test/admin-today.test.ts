import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {AdminReports,TodayRefreshRateLimited} from '../src/admin/reports.js';
const dest={schema:'raw',table:'olos_calls'};
function fixture(options:{count?:string;error?:string;busy?:boolean;gate?:Promise<void>;entered?:()=>void}={}) {
  const sql:string[]=[];let releases=0,counts=0;
  const pool={async connect(){return {on(){},removeListener(){},async query(text:string,values?:unknown[]){
    sql.push(text);
    if(text.includes('pg_try_advisory_xact_lock'))return {rows:[{acquired:!options.busy}]};
    if(text.startsWith('SELECT transaction_timestamp()'))return {rows:[{date:'2026-11-10',observed_at:new Date('2026-11-10T12:00:00Z'),start_at:new Date('2026-11-10T03:00:00Z'),end_at:new Date('2026-11-11T03:00:00Z')}]};
    if(text.startsWith('SELECT count(*)')){counts++;options.entered?.();await options.gate;if(options.error)throw {code:options.error};assert.deepEqual(values?.slice(0,2),['fixture','"raw"."olos_calls"']);return {rows:[{calls:options.count??'900719925474099312345'}]};}
    return {rows:[]};
  },release(){releases++;}};}} as unknown as Pool;
  return {pool,sql,stats:()=>({counts,releases})};
}
test('manual today coalesces sessions, preserves precision and imposes a 60s source-wide cooldown',async()=>{
  let release!:()=>void,entered!:()=>void,now=0;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const db=fixture({gate,entered}),reader=new AdminReports(db.pool,'fixture',dest,()=>now);
  const calls=Array.from({length:20},()=>reader.refreshToday());await started;assert.equal(db.stats().counts,1);release();
  const results=await Promise.all(calls);assert(results.every(r=>r===results[0]));assert.equal(results[0]?.calls,'900719925474099312345');
  assert.equal(results[0]?.observed_at,'2026-11-10T12:00:00.000Z');assert.equal(results[0]?.observation_source,'local_records');
  await assert.rejects(reader.refreshToday(),e=>e instanceof TodayRefreshRateLimited&&e.retryAfterSeconds===60);
  now=59000;await assert.rejects(reader.refreshToday(),e=>e instanceof TodayRefreshRateLimited&&e.retryAfterSeconds===1);
  now=60000;await reader.refreshToday();assert.equal(db.stats().counts,2);assert.equal(db.sql.at(-1),'ROLLBACK');
  assert(!db.sql.some(s=>/JOIN|WITH classified|report_snapshot|corporate_outbox|olos_http.reads|raw\./.test(s)));
});
test('automatic snapshot reads never consume the manual admission window',async()=>{
  let now=0;const db=fixture(),reader=new AdminReports(db.pool,'fixture',dest,()=>now);
  await assert.rejects(reader.today(),/REPORT_SNAPSHOT_INVALID/);await reader.refreshToday();
  now=60000;await assert.rejects(reader.today(),/REPORT_SNAPSHOT_INVALID/);await reader.refreshToday();
  assert.equal(db.stats().counts,2);
});
test('manual failures, busy locks and invalid counts never become zero; failures also consume the cooldown',async()=>{
  for(const [options,code] of [[{error:'57014'},'REPORT_TODAY_TIMEOUT'],[{error:'08006'},'REPORT_TODAY_UNAVAILABLE'],[{count:'1.2'},'REPORT_TODAY_UNAVAILABLE'],[{busy:true},'REPORT_TODAY_BUSY']] as const){
    const db=fixture(options),reader=new AdminReports(db.pool,'fixture',dest,()=>0);
    await assert.rejects(reader.refreshToday(),new RegExp(code));assert.equal(db.stats().releases,1);
    await assert.rejects(reader.refreshToday(),/REPORT_TODAY_RATE_LIMITED/);
  }
});
test('manual wall deadline closes only its connection and releases it exactly once',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let entered!:()=>void,release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const db=fixture({gate,entered,error:'08006'}),reader=new AdminReports(db.pool,'fixture',dest);
  const failure=assert.rejects(reader.refreshToday(),/REPORT_TODAY_TIMEOUT/);await started;t.mock.timers.tick(2000);release();await failure;
  assert.equal(db.stats().releases,1);
});
