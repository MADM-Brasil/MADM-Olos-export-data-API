import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ServerClock,countdownView,todayView,brasiliaDay,newerTodayObservation,retryAfterMs,todayRefreshState} from '../admin/public/dashboard.js';
const now=Date.parse('2026-11-01T12:00:00Z');
const active={state:'RUNNING',cycle_in_progress:false,next_run_at:new Date(now+102000).toISOString()};
test('Retry-After accepts seconds and HTTP dates without depending on browser clock accuracy',()=>{
  assert.equal(retryAfterMs('60',null,now),60000);assert.equal(retryAfterMs('0',null,now),0);
  assert.equal(retryAfterMs('Sun, 01 Nov 2026 12:01:00 GMT','Sun, 01 Nov 2026 12:00:00 GMT',now+86400000),60000);
  assert.equal(retryAfterMs('Sun, 01 Nov 2026 12:01:00 GMT',null,now),60000);
  assert.equal(retryAfterMs('Sun, 01 Nov 2026 11:59:00 GMT',null,now),0);
  for(const invalid of [null,'','invalid','-1','1.5','999999999999999999999999'])assert.equal(retryAfterMs(invalid,null,now),60000);
});
test('manual cooldown expires using monotonic time and loading remains independently disabled',()=>{
  assert.deepEqual(todayRefreshState(false,60000,0),{busy:false,seconds:60,disabled:true});
  assert.equal(todayRefreshState(false,60000,30000).seconds,30);
  assert.equal(todayRefreshState(false,60000,59999).seconds,1);
  assert.deepEqual(todayRefreshState(false,60000,60000),{busy:false,seconds:0,disabled:false});
  assert.equal(todayRefreshState(true,0,60000).disabled,true);
});
test('old automatic snapshots cannot overwrite a newer manual observation, even with a larger count',()=>{
  const manual={date:'2026-11-01',observed_at:'2026-11-01T12:00:00Z',calls:'20'};
  assert.equal(newerTodayObservation(manual,{...manual,observed_at:'2026-11-01T11:59:00Z',calls:'999'}),false);
  assert.equal(newerTodayObservation(manual,{...manual}),false);
  assert.equal(newerTodayObservation(manual,{...manual,observed_at:'2026-11-01T12:01:00Z',calls:'19'}),true);
  assert.equal(newerTodayObservation(manual,{...manual,date:'2026-11-02',observed_at:'2026-11-02T03:00:00Z'}),true);
});
test('countdown uses actual due timestamp, no assumed interval, hours and expired deadlines',()=>{
  assert.equal(countdownView(active,now).value,'01:42');
  assert.equal(countdownView(active,now+1000).value,'01:41');
  assert.equal(countdownView(active,now+102000).value,'Aguardando execução');
  assert.equal(countdownView({...active,next_run_at:new Date(now+3665000).toISOString()},now).value,'61:05');
  assert.equal(countdownView({...active,next_run_at:new Date(now+45000).toISOString()},now).value,'00:45');
});
test('all supported states and unavailable schedule suppress fictitious countdowns',()=>{
  for(const [state,value]of [['PAUSED','Pausado'],['STOPPED','Parado'],['ERROR','Erro operacional'],['PAUSING','Pausando'],['STOPPING','Finalizando']])assert.equal(countdownView({...active,state},now).value,value);
  assert.equal(countdownView({...active,cycle_in_progress:true},now).value,'Em leitura');
  for(const next_run_at of [null,'bad'])assert.equal(countdownView({...active,next_run_at},now).value,'Sem agendamento');
  assert.equal(countdownView(active,now,true).value,'Sem conexão');
  assert.equal(countdownView(null,now).state,'loading');
});
test('server reference and monotonic elapsed time resist local clock jumps and resynchronize',()=>{
  let mono=10,wall=now+86400000;const clock=new ServerClock(()=>mono,()=>wall);
  assert.equal(clock.now(),wall);assert.equal(clock.synchronized,false);
  clock.sync(new Date(now).toISOString());wall+=86400000;mono+=1000;
  assert.equal(clock.now(),now+1000);assert.equal(clock.synchronized,true);
  clock.sync(new Date(now+5000).toISOString());mono+=500;assert.equal(clock.now(),now+5500);
  clock.sync('bad');assert.equal(clock.now(),now+5500);
});
test('daily value is exact, stale on failure/age, and never carries yesterday into today',()=>{
  const snapshot={date:'2026-11-01',calls:'9007199254740993',observed_at:new Date(now).toISOString(),cache_seconds:300};
  assert.equal(todayView(snapshot,now).value,'9.007.199.254.740.993');
  assert.equal(todayView({...snapshot,calls:'0'},now).value,'0');
  assert.equal(todayView(snapshot,now,true).state,'stale');
  assert.match(todayView(snapshot,now,true).detail,/falha ao atualizar.*atualização a cada 5 min/);
  assert.match(todayView(snapshot,now).detail,/Observado em.*atualização a cada 5 min/);
  assert.equal(todayView(snapshot,now+300001).state,'stale');
  assert.equal(todayView(null,now,true).state,'unavailable');
  assert.equal(todayView({...snapshot,calls:null},now).value,'—');
  const midnight=Date.parse('2026-11-02T03:00:00Z');
  assert.equal(brasiliaDay(midnight-1),'2026-11-01');assert.equal(brasiliaDay(midnight),'2026-11-02');
  assert.equal(todayView(snapshot,midnight).state,'rollover');assert.equal(todayView(snapshot,midnight).value,'—');
  assert.equal(todayView({...snapshot,date:'2026-11-02',calls:'2',observed_at:new Date(midnight).toISOString()},midnight).value,'2');
});
