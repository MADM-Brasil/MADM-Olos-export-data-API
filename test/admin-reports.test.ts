import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportRange, reportPlaceholder, reportWhitespace, AdminReports } from '../src/admin/reports.js';
import type { Pool } from 'pg';

test('report period is a real inclusive calendar range, at most 366 days', () => {
  assert.deepEqual(reportRange('2026-09-01','2026-10-31'),{from:'2026-09-01',to:'2026-10-31'});
  for (const [from,to] of [['2026-02-29','2026-03-01'],['2026-10-02','2026-10-01'],['2025-01-01','2026-01-02'],['2026-01-01; DROP TABLE x','2026-10-01'],[null,null]]) assert.throws(()=>reportRange(from,to),/REPORT_PERIOD_INVALID/);
  assert.doesNotThrow(()=>reportRange('2024-01-01','2024-12-31'));
});
test('report-only operator semantics reject placeholders without modifying legitimate names', () => {
  const pattern=new RegExp(reportPlaceholder,'i');
  for(const name of ['123','-1','null','undefined','N/A','UNKNOWN','desconhecido','sem operador','sem agente','não identificado','nao identificado'])assert(pattern.test(name));
  for(const name of ['João Silva','Agent','Ana 2','Unknown Silva'])assert(!pattern.test(name));
  assert.equal(reportWhitespace.trim(),'');assert(reportWhitespace.includes('\u00a0'));
});
test('one snapshot serves simultaneous ranges; failure cooldown prevents polling storms',async()=>{
  let connects=0,releases=0,release!:()=>void,now=0;
  const wait=new Promise<void>(r=>{release=r;});const queries:string[]=[];
  const pool={async connect(){connects++;return {async query(sql:string){queries.push(sql);if(sql.includes('to_regclass')){await wait;throw Object.assign(new Error('private SQL'),{code:'57014'});}return {rows:[]};},release(){releases++;}};}} as unknown as Pool;
  const reader=new AdminReports(pool,'fixture',{schema:'raw',table:'olos_calls'},()=>now);
  const first=reader.read('2026-09-01','2026-09-30'),second=reader.read('2026-10-01','2026-10-31');
  const rejected=Promise.all([assert.rejects(first,/REPORT_TIMEOUT/),assert.rejects(second,/REPORT_TIMEOUT/)]);release();await rejected;
  assert.equal(connects,1);assert.equal(releases,1);
  assert(queries[0]?.includes('READ ONLY'));assert(queries.includes('SET LOCAL jit=off'));assert.equal(queries.at(-1),'ROLLBACK');
  for(now=30000;now<300000;now+=30000)await assert.rejects(reader.read('2026-09-01','2026-09-30'),/REPORT_TIMEOUT/);
  assert.equal(connects,1);
  await assert.rejects(reader.read('2026-09-01','2026-09-30'),/REPORT_TIMEOUT/);assert.equal(connects,2);
});
test('snapshot expires once across periods; exact totals, union of operators, no IDs leaked',async()=>{
  let connects=0,now=0,fail=false;
  const day=(date:string|null,calls:string,ids:string[])=>({day:date,calls,identified_calls:calls,operator_ids:ids,with_cpf:'0',with_email:'0',confirmed:'0',pending:calls,not_queued:'0',inconsistent:'0',missing_mapping:'0'});
  const days=[day('2026-09-30','9007199254740993',['7','9007199254740993']),day('2026-10-01','2',['7']),day(null,'1',['7'])];
  const pool={async connect(){connects++;if(fail)throw new Error('offline');return {async query(sql:string){
    if(sql.includes('to_regclass'))return {rows:[{present:true}]};
    if(sql.startsWith('WITH classified'))return {rows:days};
    if(sql.includes('failed_reads'))return {rows:[{failed_reads:'1',observed_at:new Date('2026-11-01')}]};
    return {rows:[]};},release(){}};}} as unknown as Pool;
  const reader=new AdminReports(pool,'fixture',{schema:'raw',table:'olos_calls'},()=>now);
  const first=await reader.read('2026-09-01','2026-10-31') as any;
  assert.equal(first.summary.calls,'9007199254740996');assert.equal(first.period.calls,'9007199254740995');
  assert.equal(first.summary.operators,'2');assert.equal(first.period.operators,'2');assert.equal(first.summary.undated,'1');
  assert.doesNotMatch(JSON.stringify(first),/operator_ids|identified_agent/);
  for(now=30000;now<300000;now+=30000){
    const r=await reader.read('2026-10-01','2026-10-31') as any;
    assert.equal(r.period.calls,'2');assert.deepEqual(r.summary,first.summary);assert.equal(r.observed_at,first.observed_at);
  }
  assert.equal(connects,1);
  await Promise.all([reader.read('2026-09-01','2026-09-30'),reader.read('2026-10-01','2026-10-31')]);assert.equal(connects,2);
  now+=300000;fail=true;await assert.rejects(reader.read('2026-09-01','2026-10-31'),/offline/);
  now+=30000;await assert.rejects(reader.read('2026-09-01','2026-10-31'),/offline/);assert.equal(connects,3);
  await assert.rejects(reader.read('bad','bad'),/REPORT_PERIOD_INVALID/);assert.equal(connects,3);
});
