import { test } from 'node:test';
import assert from 'node:assert/strict';
import { date,count,defaultRange,safeEvents,eventLines,terminalRows,reportCsv,renderDashboardMetrics,renderDashboardChart } from '../admin/public/ui.js';
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
  const lines=eventLines([...events,{event:'scheduler_error',error:'RECOVERY_REQUIRED',time:null}], 'scheduler','ERROR');assert.equal(lines.length,1);assert.match(lines[0],/ERROR \| scheduler_error/);
  assert.equal(eventLines(events,'missing','ALL').length,0);
});
test('CSV exports only aggregate schema, all rows, safe cells and unavailable markers',()=>{
  const csv=reportCsv([{day:'2026-10-31',calls:'9007199254740993',identified_calls:'2',operators:'1',with_cpf:'1',with_email:'0',confirmed:null,pending:'2',not_queued:'0',inconsistent:'0',email:'PRIVATE',payload:'PRIVATE'},
    {day:'=HYPERLINK("secret")',calls:'=1+1'}]);
  assert(csv.startsWith('\ufeff'));assert.match(csv,/31\/10\/2026/);assert.match(csv,/9007199254740993/);assert.match(csv,/Indisponível/);assert.doesNotMatch(csv,/PRIVATE|HYPERLINK|=1\+1/);assert.equal(csv.split('\r\n').length,3);
});

test('chart exception and resize failure preserve exact independent dashboard metrics',()=>{
  const nodes=new Map(),element=id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);};
  const snapshot={from:'2026-10-01',to:'2026-10-31',observed_at:'2026-11-01T12:00:00Z',cache_seconds:300,
    summary:{calls:'9007199254740993',identified_calls:'17',confirmed:null,pending:'8',undated:'1',missing_mapping:'1',inconsistent:'2'},failed_reads:'3',daily:[{day:'2026-10-01',calls:'2'}]};
  renderDashboardMetrics(element,snapshot);
  const broken=()=>{throw new Error('SVG rendering failed');};
  renderDashboardChart(element('chart'),snapshot,broken);renderDashboardChart(element('chart'),snapshot,broken);
  assert.equal(element('metric-calls').textContent,'9.007.199.254.740.993');
  assert.equal(element('metric-confirmed').textContent,'Indisponível');assert.equal(element('metric-pending').textContent,'8');
  assert.equal(element('metric-errors').textContent,'3');assert.match(element('metrics-observed').textContent,/300 s/);
  assert.match(element('metrics-error').textContent,/2 recibos divergentes/);assert.match(element('chart').textContent,/indicadores permanecem válidos/);
});

// Contract frozen from the pre-premium terminal; no event family may disappear.
test('complete original event vocabulary and sanitized operational fields remain visible',()=>{
  const names=['admin_listening','scheduler_started','scheduler_interval_changed','scheduler_paused','scheduler_resumed','scheduler_next_run','scheduler_error','poll_retry','batch_completed','recovery_required','reference_cache_refreshed','local_recovery_completed','olos_tls_verification_disabled','corporate_delivery_confirmed','corporate_delivery_deferred'];
  const fields={received:8,inserted:5,updated:1,duplicates:2,duration_ms:90,request_ms:50,persistence_ms:40,interval_ms:120000,retry_ms:2000,port:8080,queued:4,skipped:1,confirmed:3,enabled:false,blocked:true,error:'RECOVERY_REQUIRED',read_id:'00000000-0000-4000-8000-000000000001',next_run_at:'2026-11-04T15:02:00.000Z'};
  const safe=safeEvents(names.map(event=>({event,time:'2026-11-04T15:00:00.000Z',...fields,token:'PRIVATE',password:'PRIVATE',cpf:'PRIVATE',payload:'<script>PRIVATE</script>'})));
  assert.deepEqual(safe.map(e=>e.event),names);
  for(const row of safe)for(const [key,value] of Object.entries(fields))assert.equal(row[key],value);
  const lines=eventLines(safe);assert.equal(lines.length,names.length);
  for(const line of lines){assert.match(line,/04\/11\/2026, 12:00:00 Brasília \| ERROR \|/);assert.match(line,/received=8 inserted=5 updated=1 duplicates=2/);assert.match(line,/skipped=1/);assert.match(line,/next_run_at=04\/11\/2026, 12:02:00 Brasília/);assert.doesNotMatch(line,/PRIVATE|payload|token|password|cpf|script/);}
  assert.equal(eventLines(safe,'recovery_required','ERROR').length,15);
  assert.equal(eventLines(safe,'00000000-0000-4000-8000-000000000001').length,15);
});
test('full retained buffer, stable chronological order and copy share one projection',()=>{
  const safe=safeEvents(Array.from({length:240},(_,i)=>({event:'batch_completed',time:new Date(Date.UTC(2026,10,4,15,0,i)).toISOString(),received:i})));
  const reversed=[...safe].reverse(),rows=terminalRows(reversed);
  assert.equal(rows.length,200);assert.match(rows[0].detail,/received=40$/);assert.match(rows.at(-1).detail,/received=239$/);
  assert.deepEqual(eventLines(reversed),rows.map(r=>r.line));assert.equal(eventLines(reversed,'received=40').length,1);
  const duplicates=terminalRows([safe[0],safe[0]]);assert.equal(duplicates.length,2);assert.notEqual(duplicates[0].key,duplicates[1].key);
  assert.equal(terminalRows(safe.slice(1))[0].key,terminalRows(safe)[1].key);
  assert.deepEqual(eventLines([]),[]);assert.deepEqual(eventLines(safe,'','ERROR'),[]);
});
