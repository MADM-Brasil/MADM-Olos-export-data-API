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
test('report failures rollback/release, do not cache failures, and coalesce identical concurrent requests',async()=>{
  let connects=0,releases=0,release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});const queries:string[]=[];
  const pool={async connect(){connects++;return {async query(sql:string){queries.push(sql);if(sql.includes('to_regclass')){await wait;throw new Error('fixture');}return {rows:[]};},release(){releases++;}};}} as unknown as Pool;
  const reader=new AdminReports(pool,'fixture',{schema:'raw',table:'olos_calls'});
  const first=reader.read('2026-09-01','2026-09-30'),second=reader.read('2026-09-01','2026-09-30');
  assert.equal(first,second);await assert.rejects(reader.read('2026-10-01','2026-10-31'),/REPORT_BUSY/);release();
  await assert.rejects(first,/fixture/);assert.equal(connects,1);assert.equal(releases,1);
  assert(queries[0]?.includes('READ ONLY'));assert.equal(queries.at(-1),'ROLLBACK');
  await assert.rejects(reader.read('2026-09-01','2026-09-30'));assert.equal(connects,2);
});
