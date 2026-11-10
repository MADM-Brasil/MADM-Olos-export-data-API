import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicScheduler, type ScheduledConsumer } from '../src/scheduler.js';
import { type Settings, type SchedulerRepository, type State, type Mode, interval } from '../src/admin/repository.js';
import { AuthUnavailable, HttpError, WorkerError } from '../src/errors.js';

const flush = async () => { for (let i=0; i<15; i++) await new Promise(r=>setImmediate(r)); };
function gate() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;}); return { promise, resolve }; }
function clock() {
  let now=1700000000000;
  const waits=new Set<{at:number;done:()=>void}>();
  return {
    now:()=>now,
    wait(ms:number,signal:AbortSignal) { return new Promise<void>(resolve=>{
      const done=()=>{waits.delete(entry);signal.removeEventListener('abort',done);resolve();};
      const entry={at:now+ms,done};waits.add(entry);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
    }); },
    async advance(ms:number) { now+=ms; for(const item of [...waits])if(item.at<=now)item.done();await flush(); },
  };
}
function repository(mode:Mode='RUNNING',ms=120000) {
  const saved:Settings={enabled:mode==='RUNNING',desired_state:mode,interval_ms:ms,runtime_state:'STOPPED',last_error:null,updated_at:'fixture',updated_by:'admin'};
  const audit:{actor:string;mode?:Mode;interval_ms?:number;state?:State}[]=[];
  let fail=false;
  const repo:SchedulerRepository={
    async settings(){if(fail)throw new WorkerError('ADMIN_DATABASE_SESSION_LOST');return {...saved};},
    async change(actor,patch){if(fail)throw new WorkerError('ADMIN_DATABASE_SESSION_LOST');if(patch.interval_ms!==undefined)saved.interval_ms=interval(patch.interval_ms);if(patch.mode){saved.desired_state=patch.mode;saved.enabled=patch.mode==='RUNNING';}saved.updated_by=actor;audit.push({actor,...patch});},
    async state(state,error){if(fail)throw new WorkerError('ADMIN_DATABASE_SESSION_LOST');saved.runtime_state=state;saved.last_error=error??null;audit.push({actor:'system:scheduler',state});},
  };
  return {saved,audit,repo,outage:()=>{fail=true;},restore:()=>{fail=false;}};
}
async function setup(t:TestContext,options:{mode?:Mode;ms?:number;cycle?:()=>Promise<void>;close?:()=>Promise<void>;factory?:()=>Promise<ScheduledConsumer>;maxFailures?:number}={}) {
  const c=clock(),r=repository(options.mode,options.ms);let cycles=0,active=0,maxActive=0,closed=0;
  const events:{event:string;fields:Record<string,unknown>}[]=[];
  const consumer={async cycle(){cycles++;active++;maxActive=Math.max(maxActive,active);try{await options.cycle?.();}finally{active--;}}
    ,async close(){closed++;await options.close?.();}};
  const scheduler=new DynamicScheduler(r.repo,options.factory??(async()=>consumer),options.maxFailures??5,true,c,(event,fields={})=>{events.push({event,fields});});
  const running=scheduler.run();running.catch(()=>{});
  t.after(async()=>{scheduler.shutdown();await running;});
  await flush();
  return {scheduler,r,c,events,running,cycles:()=>cycles,maxActive:()=>maxActive,closed:()=>closed};
}
for(const minutes of [1,2,3,5])test(`dynamic interval ${minutes} minute(s) counted after completion`,async t=>{
  const f=await setup(t,{ms:minutes*60000});assert.equal(f.cycles(),1);
  await f.c.advance(minutes*60000-1);assert.equal(f.cycles(),1);
  await f.c.advance(1);assert.equal(f.cycles(),2);assert.equal(f.maxActive(),1);
  assert(f.events.some(e=>e.event==='scheduler_started'));assert(f.events.some(e=>e.event==='scheduler_next_run'));
});
test('interval change while waiting recalculates due time without container restart',async t=>{
  const f=await setup(t,{ms:300000});await f.c.advance(30000);
  await f.scheduler.request('admin:ana',{interval_ms:60000});await flush();
  await f.c.advance(29999);assert.equal(f.cycles(),1);await f.c.advance(1);assert.equal(f.cycles(),2);
  assert.equal(f.r.saved.updated_by,'admin:ana');assert(f.events.some(e=>e.event==='scheduler_interval_changed'));
  await f.scheduler.request('admin:ana',{interval_ms:300000});await flush();await f.c.advance(120000);assert.equal(f.cycles(),2);
});
test('pause during read does not interrupt cycle; resume cannot overlap',async t=>{
  const read=gate();const f=await setup(t,{cycle:()=>read.promise});
  await f.scheduler.request('admin:ana',{mode:'PAUSED'});
  assert.equal(f.scheduler.status().state,'PAUSING');assert.equal(f.scheduler.status().cycle_in_progress,true);
  await f.c.advance(300000);assert.equal(f.cycles(),1);
  read.resolve();await flush();assert.equal(f.scheduler.status().state,'PAUSED');
  await f.c.advance(300000);assert.equal(f.cycles(),1);
  await f.scheduler.request('admin:ana',{mode:'RUNNING'});await flush();assert.equal(f.cycles(),2);assert.equal(f.maxActive(),1);
  assert(f.events.some(e=>e.event==='scheduler_paused'));assert(f.events.some(e=>e.event==='scheduler_resumed'));
});
test('stop waits for both active cycle and resource close before STOPPED',async t=>{
  const read=gate(),close=gate();const f=await setup(t,{cycle:()=>read.promise,close:()=>close.promise});
  await f.scheduler.request('admin:ana',{mode:'STOPPED'});assert.equal(f.scheduler.status().state,'STOPPING');assert.equal(f.closed(),0);
  read.resolve();await flush();assert.equal(f.closed(),1);assert.equal(f.scheduler.status().state,'STOPPING');
  close.resolve();await flush();assert.equal(f.scheduler.status().state,'STOPPED');
  await f.c.advance(600000);assert.equal(f.cycles(),1);assert.equal(f.r.saved.desired_state,'STOPPED');
});
test('restart respects persisted STOPPED/PAUSED and saved interval',async t=>{
  const f=await setup(t,{mode:'STOPPED',ms:180000});assert.equal(f.cycles(),0);assert.equal(f.scheduler.status().interval_ms,180000);
  await f.scheduler.request('admin:ana',{mode:'RUNNING'});await flush();assert.equal(f.cycles(),1);
  await f.scheduler.request('admin:ana',{mode:'STOPPED'});await flush();f.scheduler.shutdown();await f.running;
  const next=new DynamicScheduler(f.r.repo,async()=>{throw new Error('must stay stopped');},5,true,f.c,()=>{});
  const run=next.run();await flush();assert.equal(next.status().state,'STOPPED');next.shutdown();await run;
  const paused=await setup(t,{mode:'PAUSED'});assert.equal(paused.cycles(),0);assert.equal(paused.scheduler.status().state,'PAUSED');
});
test('parallel run is rejected and competing consumer lock failure enters ERROR',async t=>{
  const f=await setup(t);await assert.rejects(f.scheduler.run(),/SCHEDULER_ALREADY_ACTIVE/);
  const blocked=await setup(t,{factory:async()=>{throw new WorkerError('CONSUMER_ALREADY_ACTIVE');}});
  assert.equal(blocked.scheduler.status().state,'ERROR');assert.equal(blocked.cycles(),0);
});
test('ambiguous pending read never automatically retries or resumes',async t=>{
  const f=await setup(t,{cycle:async()=>{throw new WorkerError('RECONCILIATION_REQUIRED');}});
  assert.equal(f.scheduler.status().state,'ERROR');await f.c.advance(3600000);assert.equal(f.cycles(),1);
  assert.equal(f.scheduler.status().error,'RECONCILIATION_REQUIRED');
});
test('backoff preserves Retry-After even when operator shortens interval',async t=>{
  let calls=0;const f=await setup(t,{cycle:async()=>{if(++calls===1)throw new AuthUnavailable(new HttpError(429,300000));}});
  await f.scheduler.request('admin:ana',{interval_ms:60000});await flush();
  await f.c.advance(299999);assert.equal(f.cycles(),1);await f.c.advance(1);assert.equal(f.cycles(),2);
  assert(f.events.some(e=>e.event==='poll_retry'&&e.fields.retry_ms===300000));
});
test('bounded auth failure retries and DB outage never cause aggressive reads',async t=>{
  const f=await setup(t,{maxFailures:2,cycle:async()=>{throw new AuthUnavailable(new HttpError(503));}});
  await f.c.advance(120000);assert.equal(f.cycles(),2);assert.equal(f.scheduler.status().state,'ERROR');
  const db=await setup(t);db.r.outage();await db.c.advance(120000);assert.equal(db.cycles(),1);assert.equal(db.scheduler.status().state,'ERROR');db.r.restore();
});
for (const mode of ['STOPPED','PAUSED'] as const) test(`${mode} requested while source preflight awaits prevents first consuming cycle`,async t=>{
  const ready=gate();let cycles=0;
  const f=await setup(t,{factory:async()=>{await ready.promise;return {async cycle(){cycles++;},async close(){}};}});
  await f.scheduler.request('admin:ana',{mode});ready.resolve();await flush();
  assert.equal(cycles,0);assert.equal(f.scheduler.status().state,mode);
});
test('explicit start re-arms ERROR only through consumer preflight',async t=>{
  let create=0,cycles=0;
  const f=await setup(t,{factory:async()=>{if(++create===1)throw new WorkerError('RECOVERY_REQUIRED');return {async cycle(){cycles++;},async close(){}};}});
  assert.equal(f.scheduler.status().state,'ERROR');await f.scheduler.request('admin:ana',{mode:'RUNNING'});await flush();
  assert.equal(cycles,1);assert.equal(create,2);assert.equal(f.scheduler.status().state,'RUNNING');
});
test('interval rejects values outside 1–60 minutes and accepts boundaries',()=>{
  for(const value of [0,59999,3600001,NaN,60000.1,'60000',null,undefined])assert.throws(()=>interval(value),/SCHEDULER_INTERVAL_INVALID/);
  assert.equal(interval(60000),60000);assert.equal(interval(3600000),3600000);
});

test('safe recovery reopens consumer with bounded delay and resumes automatically', async t => {
  let created = 0, calls = 0;
  const f = await setup(t, {factory: async () => {
    created++;
    return {async cycle() { if (++calls === 1) throw new WorkerError('RECOVERY_REQUIRED'); }, async close() {}};
  }});
  assert.equal(created, 1);
  await flush(); assert.equal(created, 1);
  await f.c.advance(120000); assert.equal(created, 2); assert.equal(calls, 2);
  assert.equal(f.scheduler.status().state, 'RUNNING');
});
for (const mode of ['PAUSED','STOPPED'] as const) test(`recovery respects ${mode} and shutdown preserves intent`, async t => {
  let created = 0;
  const f = await setup(t, {factory: async () => { created++; throw new WorkerError('RECOVERY_REQUIRED'); }});
  await f.scheduler.request('operator', {mode}); await flush();
  await f.c.advance(3600000); assert.equal(created, 1); assert.equal(f.scheduler.status().state, mode);
  f.scheduler.shutdown(); await f.running; assert.equal(f.r.saved.desired_state, mode);
});
test('repeated recovery failures exhaust a finite attempt budget', async t => {
  let created = 0;
  const f = await setup(t, {maxFailures: 3, factory: async () => { created++; throw new WorkerError('RECOVERY_REQUIRED'); }});
  for (let i=0;i<5;i++) await f.c.advance(120000);
  assert.equal(created,3); assert.equal(f.scheduler.status().state,'ERROR');
});
test('database settings failure recovers after bounded wait', async t => {
  const f = await setup(t); f.r.outage(); await f.c.advance(120000);
  f.r.restore();
  await f.c.advance(120000);
  assert.equal(f.scheduler.status().state,'RUNNING');
});

for (const last_error of ['UNCLEAN_SCHEDULER_EXIT','RECOVERY_REQUIRED']) test(`restart revalidates ${last_error} before resuming`,async()=>{
  const r=repository();r.saved.runtime_state='ERROR';r.saved.last_error=last_error;
  const c=clock();let cycles=0;
  const scheduler=new DynamicScheduler(r.repo,async()=>({async cycle(){cycles++;},async close(){}}),5,true,c,()=>{});
  const running=scheduler.run();await flush();assert.equal(cycles,1);
  scheduler.shutdown();await running;assert.equal(r.saved.desired_state,'RUNNING');
});

test('permanent authentication rejection never schedules automatic recovery',async t=>{
  const f=await setup(t,{cycle:async()=>{throw new AuthUnavailable(new HttpError(403));}});
  await f.c.advance(120000);await f.c.advance(120000);
  assert.equal(f.cycles(),1);assert.equal(f.scheduler.status().state,'ERROR');
});
for(const mode of ['PAUSED','STOPPED'] as const)test(`committed ${mode} with lost acknowledgement is observed from terminal ERROR`,async t=>{
  const f=await setup(t,{cycle:async()=>{throw new WorkerError('RECONCILIATION_REQUIRED');}});
  const change=f.r.repo.change.bind(f.r.repo);
  t.mock.method(f.r.repo,'change',async(actor:string,patch:{interval_ms?:number;mode?:Mode})=>{
    await change(actor,patch);throw new Error('lost commit acknowledgement');
  });
  await assert.rejects(f.scheduler.request('operator',{mode}));await flush();
  assert.equal(f.r.saved.desired_state,mode);assert.equal(f.scheduler.status().state,mode);
  await f.c.advance(3600000);assert.equal(f.cycles(),1);
});

test('lost acknowledgement of RUNNING state COMMIT revalidates consumer before first read',async t=>{
  let created=0,cycles=0;
  const f=await setup(t,{mode:'PAUSED',factory:async()=>{
    created++;return {async cycle(){cycles++;},async close(){}};
  }});
  const state=f.r.repo.state.bind(f.r.repo);let injected=false;
  t.mock.method(f.r.repo,'state',async(value:State,error?:string)=>{
    await state(value,error);
    if(value==='RUNNING'&&!injected){injected=true;throw new WorkerError('ADMIN_COMMIT_UNKNOWN',true);}
  });
  await f.scheduler.request('operator',{mode:'RUNNING'});await flush();
  assert.equal(cycles,0);assert.equal(created,1);assert.equal(f.scheduler.status().state,'ERROR');
  await f.c.advance(120000);assert.equal(created,2);assert.equal(cycles,1);
});
test('failed administrative mutation before COMMIT cannot rearm a terminal ERROR',async t=>{
  const f=await setup(t,{cycle:async()=>{throw new WorkerError('RECONCILIATION_REQUIRED');}});
  t.mock.method(f.r.repo,'change',async()=>{throw new Error('before commit');});
  await assert.rejects(f.scheduler.request('operator',{mode:'PAUSED'}));await flush();
  assert.equal(f.r.saved.desired_state,'RUNNING');assert.equal(f.scheduler.status().state,'ERROR');
  await f.c.advance(3600000);assert.equal(f.cycles(),1);
});
