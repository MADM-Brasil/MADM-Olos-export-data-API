import { test } from 'node:test';
import assert from 'node:assert/strict';
import { date,count,defaultRange,safeEvents,eventLines,reportCsv } from '../admin/public/ui.js';
test('Brasília dates and exact counts never replace unavailable data with zero',()=>{
  assert.match(date('2026-11-01T02:59:00Z'),/31\/10\/2026.*23:59/);
  assert.equal(date('invalid'),'—');assert.equal(count(null),'Indisponível');assert.equal(count('0'),'0');
  assert.equal(count('9007199254740993'),'9.007.199.254.740.993');
  assert.deepEqual(defaultRange(new Date('2026-11-01T02:00:00Z')),{from:'2026-10-02',to:'2026-10-31'});
});
test('bounded event projection strips PII and arbitrary error text before display/copy',()=>{
  const events=safeEvents(Array.from({length:350},()=>({time:'2026-11-01T03:00:00.000Z',event:'batch_completed',received:4,email:'PRIVATE',cpf:'PRIVATE',payload:{secret:'PRIVATE'},error:'PRIVATE url?token=secret'})));
  assert.equal(events.length,200);assert.doesNotMatch(JSON.stringify(events),/PRIVATE|secret|payload/);
  assert.equal(safeEvents([{event:'unknown-secret'}]).length,0);
  const lines=eventLines([...events,{event:'scheduler_error',error:'RECOVERY_REQUIRED',time:null}], 'scheduler','ERROR');assert.equal(lines.length,1);assert.match(lines[0],/ERROR scheduler_error/);
  assert.equal(eventLines(events,'missing','ALL').length,0);
});
test('CSV exports only aggregate schema, all rows, safe cells and unavailable markers',()=>{
  const csv=reportCsv([{day:'2026-10-31',calls:'9007199254740993',identified_calls:'2',operators:'1',with_cpf:'1',with_email:'0',confirmed:null,pending:'2',not_queued:'0',inconsistent:'0',email:'PRIVATE',payload:'PRIVATE'},
    {day:'=HYPERLINK("secret")',calls:'=1+1'}]);
  assert(csv.startsWith('\ufeff'));assert.match(csv,/31\/10\/2026/);assert.match(csv,/9007199254740993/);assert.match(csv,/Indisponível/);assert.doesNotMatch(csv,/PRIVATE|HYPERLINK|=1\+1/);assert.equal(csv.split('\r\n').length,3);
});
