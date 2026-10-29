import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {LocalStore,type BaselinePlan} from '../src/store.js';
import {localConfig} from '../src/config.js';
import {emptyCache} from '../src/normalization.js';
import type {Prisma} from '../generated/client/index.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

if(!process.env.LOCAL_DATABASE_URL||new URL(process.env.LOCAL_DATABASE_URL).pathname!=='/olos_http_local_test')throw Error('Disposable test database required');
const cfg={...localConfig(),sourceKey:'fixture',batchSize:2};
const plan:BaselinePlan={baseline:'2026-10-28T12:00:00Z',baselineEvidence:'synthetic boundary',identityEvidence:'synthetic scope',contractOrigin:'fixture'};
const row=(id:string,date='2026-10-28T12:00:00.123456Z',extra:Record<string,unknown>={})=>({AttemptsRawDataID:id,CallId:'0001',AgentId:'7',StartDate:date,OriginalPhoneNumber:'000000000000',...extra});
const stores:LocalStore[]=[];
async function open(batchSize=2){const s=new LocalStore({...cfg,batchSize});stores.push(s);await s.open();return s;}
let s:LocalStore;
beforeEach(async()=>{
  for(const store of stores.splice(0))await store.close();s=await open();
  await s.db.normalizedRecord.deleteMany();await s.db.rawRecord.deleteMany();await s.db.ingestionRun.deleteMany();await s.db.checkpoint.deleteMany();
  await s.baseline(plan,JSON.stringify([row('1')]));
});
after(async()=>{for(const store of stores)await store.close();});
const ingest=async(data:unknown[])=>{const run=await s.stage(JSON.stringify(data));return s.process(run.id);};

test('baseline is explicit, immutable and does not advance source state',async()=>{
  assert.equal((await s.status()).committedRecords,0);
  assert.equal((await s.status()).remoteIngestionEnabled,false);
  await s.baseline(plan,JSON.stringify([row('1')]));
  await assert.rejects(s.baseline({...plan,baseline:'2026-10-29T12:00:00Z'},JSON.stringify([row('1')])),/BASELINE_IMMUTABLE/);
});
test('raw body is exact, identity idempotent, distinct IDs with same CallId remain distinct',async()=>{
  const raw='[ {"AttemptsRawDataID":9007199254740993,"CallId":"0001","StartDate":"2026-10-28T12:00:00Z"} ]';
  const run=await s.stage(raw);assert.equal((await s.db.ingestionRun.findUniqueOrThrow({where:{id:run.id}})).responseBody,raw);
  assert.equal((await s.process(run.id)).inserted,1);assert.equal((await s.process(run.id)).inserted,0);
  const same=await s.stage(raw);assert.equal(same.id,run.id);
  await ingest([row('2')]);assert.equal(await s.db.rawRecord.count(),2);
  assert.equal((await s.db.rawRecord.findFirstOrThrow({where:{sourceId:'9007199254740993'}})).sourceId,'9007199254740993');
});
test('duplicates within/across responses do not advance committedRecords twice',async()=>{
  const a=await ingest([row('1'),row('1'),row('2')]);assert.equal(a.inserted,2);assert.equal(a.duplicates,1);
  const b=await ingest([row('2'),row('1')]);assert.equal(b.inserted,0);assert.equal(b.duplicates,2);
  const status=await s.status();assert.equal(status.committedRecords,2);assert.equal(status.completedRuns,2);
});
test('late arrival with smaller ID is included; before-baseline data is preserved and classified',async()=>{
  await ingest([row('100','2026-10-28T15:00:00Z')]);
  await ingest([row('2','2026-10-28T12:01:00Z'),row('1','2026-10-27T23:59:59Z')]);
  assert.equal(await s.db.normalizedRecord.count({where:{disposition:'eligible'}}),2);
  assert.equal(await s.db.normalizedRecord.count({where:{disposition:'before_baseline'}}),1);
  assert.equal((await s.status()).committedRecords,3);
});
test('invalid response is durable and no checkpoint advances',async()=>{
  const body=JSON.stringify([row('1'),{AttemptsRawDataID:'2',StartDate:'invalid'}]);
  const run=await s.stage(body);await assert.rejects(s.process(run.id),/SOURCE_DATE_INVALID/);
  assert.equal((await s.db.ingestionRun.findUniqueOrThrow({where:{id:run.id}})).responseBody,body);
  assert.equal((await s.status()).committedRecords,0);assert.equal(await s.db.rawRecord.count(),0);
  await assert.rejects(s.stage(JSON.stringify([row('3')])),/LOCAL_PENDING_RUN_REQUIRES_RECOVERY/);
});
test('malformed JSON is retained without normalization or progress',async()=>{
  const run=await s.stage('[invalid');await assert.rejects(s.process(run.id),/JSON_INVALID/);
  assert.equal((await s.status()).pendingRuns,1);assert.equal((await s.status()).completedRuns,0);
});
test('same ID with changed payload is quarantined, never overwrites raw or normalized',async()=>{
  await ingest([row('1')]);await assert.rejects(ingest([row('1',undefined,{CallId:'changed'})]),/SOURCE_ID_CONTENT_CONFLICT/);
  const raw=await s.db.rawRecord.findFirstOrThrow();assert.equal((raw.payload as Record<string,unknown>).CallId,'0001');
  assert.equal((await s.status()).committedRecords,1);
});
test('partial failure rolls back raw, normalized and checkpoint in the failed batch; restart resumes',async()=>{
  const run=await s.stage(JSON.stringify([row('1'),row('2'),row('3')]));
  await s.db.$executeRawUnsafe(`CREATE FUNCTION local_olos.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT source_id FROM local_olos.raw_records WHERE id=NEW.raw_id)='3' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`);
  await s.db.$executeRawUnsafe('CREATE TRIGGER fixture_fail BEFORE INSERT ON local_olos.normalized_records FOR EACH ROW EXECUTE FUNCTION local_olos.fixture_fail()');
  try {await assert.rejects(s.process(run.id));}finally{
    await s.db.$executeRawUnsafe('DROP TRIGGER fixture_fail ON local_olos.normalized_records');await s.db.$executeRawUnsafe('DROP FUNCTION local_olos.fixture_fail()');
  }
  assert.equal((await s.status()).committedRecords,2);assert.equal((await s.status()).completedRuns,0);
  assert.equal(await s.db.rawRecord.count(),2);assert.equal(await s.db.normalizedRecord.count(),2);
  assert.equal((await s.db.ingestionRun.findUniqueOrThrow({where:{id:run.id}})).processedCount,2);
  await s.close();stores.splice(stores.indexOf(s),1);s=await open();
  const result=await s.resume();assert.equal(result[0]!.inserted,1);assert.equal((await s.status()).committedRecords,3);assert.equal((await s.status()).completedRuns,1);
});
test('restart after raw staging delivers once',async()=>{
  const run=await s.stage(JSON.stringify([row('1')]));await s.close();stores.splice(stores.indexOf(s),1);s=await open();
  await s.resume();assert.equal((await s.process(run.id)).alreadyCompleted,true);assert.equal((await s.status()).committedRecords,1);
});
test('loss of acknowledgement after actual commit does not duplicate checkpoint or records',async()=>{
  const run=await s.stage(JSON.stringify([row('1'),row('2'),row('3')]));
  const original=s.db.$transaction.bind(s.db);let injected=false;
  s.db.$transaction=(async(fn: (tx:Prisma.TransactionClient)=>Promise<unknown>,options:unknown)=>{
    const result=await (original as (f:typeof fn,o:unknown)=>Promise<unknown>)(fn,options);
    if(!injected){injected=true;throw Error('ack lost');}return result;
  }) as typeof s.db.$transaction;
  try{await assert.rejects(s.process(run.id));}finally{s.db.$transaction=original;}
  assert.equal((await s.status()).committedRecords,2);
  await s.resume();assert.equal((await s.status()).committedRecords,3);assert.equal((await s.status()).completedRuns,1);
});
test('second consumer cannot acquire same source lock',async()=>{
  const other=new LocalStore(cfg);try{await assert.rejects(other.open(),/CONSUMER_ALREADY_ACTIVE/);}finally{await other.close();}
});
test('reprocess regenerates versioned documents without HTTP or advancing checkpoint',async()=>{
  await ingest([row('1')]);const cp=await s.db.checkpoint.findUniqueOrThrow({where:{sourceKey:'fixture'}});
  await s.db.normalizedRecord.deleteMany();const cache=emptyCache();cache.users.set('7','Synthetic agent');
  const result=await s.reprocess(cache);assert.equal(result.processed,1);assert.equal(result.version,1);
  const doc=await s.db.normalizedRecord.findFirstOrThrow();assert.equal((doc.document as Record<string,unknown>).nome_agente,'Synthetic agent');
  assert.deepEqual(await s.db.checkpoint.findUniqueOrThrow({where:{sourceKey:'fixture'}}),cp);
  await s.reprocess(cache);assert.equal(await s.db.normalizedRecord.count(),1);
});
test('empty response completes atomically without inventing source records',async()=>{
  await ingest([]);const state=await s.status();assert.equal(state.committedRecords,0);assert.equal(state.completedRuns,1);
});
test('compiled CLI resumes in a new process and rejects polling commands',async()=>{
  await s.stage(JSON.stringify([row('1')]));await s.close();stores.splice(stores.indexOf(s),1);
  const cli=fileURLToPath(new URL('../dist/local/src/main.js',import.meta.url));
  const execute=promisify(execFile),env={...process.env,LOCAL_SOURCE_KEY:'fixture'};
  const resumed=await execute(process.execPath,[cli,'resume'],{env,timeout:10000});
  assert.match(resumed.stdout,/local_run_resumed/);
  const state=await execute(process.execPath,[cli,'status'],{env,timeout:10000});
  assert.match(state.stdout,/"committedRecords":1/);assert.match(state.stdout,/"remoteIngestionEnabled":false/);
  await assert.rejects(execute(process.execPath,[cli,'start'],{env,timeout:10000}),error=>{
    assert.match((error as {stdout:string}).stdout,/LOCAL_COMMAND_NOT_ALLOWED/);return true;
  });
});
test('performance: bounded batches of 500, 5000 synthetic rows',async()=>{
  await s.close();stores.splice(stores.indexOf(s),1);s=await open(500);
  const start=performance.now();const result=await ingest(Array.from({length:5000},(_,i)=>row(String(i+1))));
  const duration=Math.round(performance.now()-start);
  assert.equal(result.inserted,5000);assert.equal(result.batches,10);assert.equal((await s.status()).committedRecords,5000);
  console.log(JSON.stringify({benchmark:'local_prisma_synthetic',records:5000,batch_size:500,transactions:10,duration_ms:duration,rows_per_second:Math.round(5000000/Math.max(1,duration)),rss_bytes:process.memoryUsage().rss,heap_used_bytes:process.memoryUsage().heapUsed}));
});
