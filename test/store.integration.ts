import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,writeFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Store } from '../src/store.js';
import { config, type Config } from '../src/config.js';
import type { Cache } from '../src/mapping.js';
import { OlosApi } from '../src/api.js';
import { OlosAuthManager } from '../src/auth.js';
import { StaticCache } from '../src/cache.js';
import { Worker } from '../src/worker.js';
import { createScheduledConsumer } from '../src/admin/consumer.js';
import { WorkerError, HttpError } from '../src/errors.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fingerprint,type RecoveryManifest,type RecoveryRange,type ProgressiveRecoveryManifest } from '../src/read-recovery.js';

const execute=promisify(execFile);

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('Use bash scripts/test-integration.sh; TEST_DATABASE_URL is required');
const parsed=new URL(url);
if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/olos_admin_homolog')throw new Error('Disposable local database required');
const pool=new pg.Pool({connectionString:url});
const cfg:Config=config({DATABASE_URL:url,OLOS_SOURCE_KEY:'olos-admin-homolog',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',BATCH_SIZE:'2'});
const cache:Cache={users:new Map([['7','Agent']]),campaigns:new Map([['8','Campaign']]),dispositions:new Map([['9','Disposition']])};
const empty:Cache={users:new Map(),campaigns:new Map(),dispositions:new Map()};
const row=(id:string,extra:Record<string,unknown>={})=>({AttemptsRawDataID:id,CallId:'same-call-id',AgentId:'7',CampaignId:'8',DispositionId:'9',StartDate:'2026-10-01T10:00:00.123456-03:00',OriginalPhoneNumber:'001100000000',...extra});
const stores:Store[]=[];
async function store(options:Partial<Config>={}){const s=new Store({...cfg,...options});stores.push(s);await s.open();return s;}
async function stage(s:Store,data:unknown[],kind:'current'|'previous'='current') {const id=await s.beginRead({kind});await s.stage(id,JSON.stringify(data),12);return id;}
before(async()=>{await pool.query('SELECT 1');});
beforeEach(async()=>{
  for(const s of stores.splice(0))await s.close();
  await pool.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE');
  await pool.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../migrations/001_ingestion.sql',import.meta.url),'utf8'));
});
after(async()=>{for(const s of stores)await s.close();await pool.end();});

test('atomic batched insert, exact source ID, same CallId is not a unique key, duplicate replay',async()=>{
  const s=await store();await stage(s,[row('9007199254740993'),row('2'),row('3'),row('2')]);
  assert.deepEqual(await s.drain(cache),{received:4,inserted:3,updated:0,duplicates:1});
  const result=await pool.query("SELECT count(*)::int AS count,min(data_ligacao::text) AS date FROM raw.olos_calls");
  assert.equal(result.rows[0].count,3);assert.match(result.rows[0].date,/\.123456/);
  assert.equal((await pool.query('SELECT source_id FROM olos_http.records WHERE source_id=$1',['9007199254740993'])).rowCount,1);
  await stage(s,[row('3'),row('2')],'previous');
  assert.deepEqual(await s.drain(cache),{received:2,inserted:0,updated:0,duplicates:2});
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,3);
});
test('HTTP 200 [] is a successful durable completed read',async()=>{
  const s=await store();await stage(s,[]);assert.deepEqual(await s.drain(cache),{received:0,inserted:0,updated:0,duplicates:0});
  assert.equal((await s.unresolved()).length,0);
});
test('restart after staging, partial commit and final commit cannot duplicate',async()=>{
  const s=await store();const id=await stage(s,[row('1'),row('2'),row('3')]);
  await s.close();stores.splice(stores.indexOf(s),1);
  const resumed=await store();assert.equal((await resumed.unresolved())[0]!.id,id);
  await pool.query("CREATE FUNCTION raw.fail_third() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.internal_id_olos > 2 THEN RAISE EXCEPTION 'simulated'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_third BEFORE INSERT ON raw.olos_calls FOR EACH ROW EXECUTE FUNCTION raw.fail_third()");
  await assert.rejects(resumed.drain(cache));
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,2);
  assert.equal((await resumed.unresolved())[0]!.processed_count,2);
  await pool.query('DROP TRIGGER fail_third ON raw.olos_calls');
  await resumed.close();stores.splice(stores.indexOf(resumed),1);
  const next=await store();const counts=await next.drain(cache);assert.equal(counts.inserted,1);
  await stage(next,[row('1'),row('2'),row('3')]);assert.equal((await next.drain(cache)).inserted,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,3);
});
test('failed destination transaction retains raw response and rolls back marker',async()=>{
  const s=await store();await stage(s,[row('1'),row('2')]);
  await pool.query("ALTER TABLE raw.olos_calls ADD CONSTRAINT synthetic_failure CHECK (nome_agente IS NULL)");
  await assert.rejects(s.drain(cache));
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
  assert.equal((await s.unresolved())[0]!.state,'received');
  await pool.query('ALTER TABLE raw.olos_calls DROP CONSTRAINT synthetic_failure');
  assert.equal((await s.drain(cache)).inserted,2);
});
test('source ID collision fails without overwriting target',async()=>{
  const s=await store();await stage(s,[row('1')]);await s.drain(cache);
  await stage(s,[row('1',{CallId:'changed'})]);await assert.rejects(s.drain(cache),/SOURCE_ID_CONTENT_CONFLICT/);
  assert.equal((await pool.query('SELECT olos_call_id FROM raw.olos_calls')).rows[0].olos_call_id,'same-call-id');
  assert.equal((await s.unresolved()).length,1);
});
test('unknown reference IDs persist and names can be reconciled without remote reread',async()=>{
  const s=await store();await stage(s,[row('1')]);await s.drain(empty);
  assert.equal((await pool.query('SELECT nome_agente FROM raw.olos_calls')).rows[0].nome_agente,null);
  assert.equal(await s.reconcileNames(cache),3);
  assert.equal((await pool.query('SELECT nome_agente FROM raw.olos_calls')).rows[0].nome_agente,'Agent');
  await stage(s,[row('1')]);assert.equal((await s.drain({...cache,users:new Map([['7','Updated']])})).updated,1);
});
test('advisory lock prevents a second consumer and unresolved read survives session loss',async()=>{
  const s=await store();await s.beginRead({kind:'current'});
  const second=new Store(cfg);await assert.rejects(second.open(),/CONSUMER_ALREADY_ACTIVE/);await second.close();
  await s.close();stores.splice(stores.indexOf(s),1);
  const next=await store();await assert.rejects(next.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
});
test('backfill and controlled reread share dedup; unresolved original stays blocked until evidence',async()=>{
  const s=await store();await stage(s,[row('1')]);await s.drain(cache);
  const plan=await recoveryPlan(s,[{start:'1',end:'2',expectedIds:['1','2']}]),lost=plan.parent;
  const recovery=await plan.capture();
  await s.stage(recovery,JSON.stringify([row('1'),row('2')]),10);
  assert.deepEqual(await s.drain(cache),{received:2,inserted:1,updated:0,duplicates:1});
  await assert.rejects(s.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
  await s.resolve(lost,`recovery:${(await s.verifyRecovery(lost)).verification_digest}`);
  await stage(s,[row('2'),row('3')],'previous');assert.equal((await s.drain(cache)).inserted,1);
});
test('schema fails closed for legacy ungenerated ID and required unknown field',async()=>{
  await pool.query('ALTER TABLE raw.olos_calls ALTER internal_id_olos DROP IDENTITY');
  const s=new Store(cfg);await assert.rejects(s.open(),/DESTINATION_ID_GENERATOR_REQUIRED/);await s.close();
  await pool.query('ALTER TABLE raw.olos_calls ALTER internal_id_olos ADD GENERATED ALWAYS AS IDENTITY; ALTER TABLE raw.olos_calls ALTER tma_origem SET NOT NULL');
  const t=new Store(cfg);await assert.rejects(t.open(),/DESTINATION_COLUMN_REVIEW_tma_origem/);await t.close();
});
test('existing untracked data cannot be ingested over',async()=>{
  await pool.query("INSERT INTO raw.olos_calls(olos_call_id) VALUES ('legacy')");
  const s=new Store(cfg);await assert.rejects(s.open(),/EXISTING_DESTINATION_REQUIRES_BASELINE/);await s.close();
});
test('large response uses bounded SQL batches',async()=>{
  const s=await store({batchSize:500});await stage(s,Array.from({length:1201},(_,i)=>row(String(i+1))));
  const start=performance.now();const counts=await s.drain(cache);
  assert.equal(counts.inserted,1201);
  console.log(JSON.stringify({test:'synthetic_1201_rows',duration_ms:Math.round(performance.now()-start)}));
  assert.equal((await pool.query('SELECT processed_count FROM olos_http.reads')).rows[0].processed_count,1201);
});

function fakeApi(response:()=>Promise<string>) {
  let consuming=0;
  const catalog=[{TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},{TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}];
  const auth=new OlosAuthManager(async()=>JSON.stringify({access_token:'a',refresh_token:'r',expires_in:3600,token_type:'bearer'}),{username:'u',password:'p',clientId:'i',clientSecret:'s'});
  const api=new OlosApi(async(path)=>{
    if(path.endsWith('available-tables'))return JSON.stringify(catalog);
    if(path.endsWith('/read-data'))return '[]';
    consuming++;return response();
  },auth,async()=>{});
  return {api,count:()=>consuming};
}
test('worker PostgreSQL failure before read sends no consuming HTTP request',async()=>{
  const s=await store();const mock=fakeApi(async()=>JSON.stringify([row('1')]));
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await s.close();stores.splice(stores.indexOf(s),1);
  await assert.rejects(worker.cycle(),/DATABASE_SESSION_LOST/);assert.equal(mock.count(),0);
});
test('worker ambiguous network/500 creates persistent block, never automatic reconsume',async()=>{
  const s=await store();const mock=fakeApi(async()=>{throw new WorkerError('NETWORK_OR_RESPONSE_FAILURE',true);});
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.cycle(),/RECOVERY_REQUIRED/);await assert.rejects(worker.cycle(),/RECOVERY_REQUIRED/);
  assert.equal(mock.count(),1);assert.equal((await s.unresolved())[0]!.state,'reading');
});
test('worker 403 preserves uncertain read without a documented no-consumption guarantee',async()=>{
  const s=await store();const mock=fakeApi(async()=>{throw new HttpError(403);});
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.cycle(),/RECOVERY_REQUIRED/);assert.equal(mock.count(),1);assert.equal((await s.unresolved())[0]!.state,'reading');
});
test('worker concurrent cycle is rejected',async()=>{
  const s=await store();let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const mock=fakeApi(async()=>{await gate;return JSON.stringify([row('1')]);});
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  const running=worker.cycle();await assert.rejects(worker.cycle(),/POLL_ALREADY_ACTIVE/);
  release();await running;assert.equal(mock.count(),1);
});

test('database loss after HTTP leaves durable intent; restart cannot read again',async()=>{
  const s=await store();
  const mock=fakeApi(async()=>{
    const pid=(await s.client!.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await pool.query('SELECT pg_terminate_backend($1)',[pid]);
    await new Promise(r=>setTimeout(r,10));
    return JSON.stringify([row('1')]);
  });
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.cycle(),/RECOVERY_REQUIRED/);
  await s.close();stores.splice(stores.indexOf(s),1);
  const next=await store();assert.equal((await next.unresolved())[0]!.state,'reading');
  await assert.rejects(next.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);assert.equal(mock.count(),1);
});

test('commit acknowledgement loss replays local durable state without duplicate insertion',async()=>{
  const s=await store();await stage(s,[row('1'),row('2')]);
  const original=s.client!.query.bind(s.client!);
  let injected=false;
  // Execute the actual COMMIT, then lose its acknowledgement from the caller's perspective.
  s.client!.query=(async(...args:unknown[])=>{
    const result=await (original as (...a:unknown[])=>Promise<unknown>)(...args);
    if(args[0]==='COMMIT'&&!injected){injected=true;throw new Error('simulated acknowledgement loss');}
    return result;
  }) as pg.PoolClient['query'];
  await assert.rejects(s.drain(cache));
  s.client!.query=original;
  await s.close();stores.splice(stores.indexOf(s),1);
  const next=await store();assert.equal((await next.drain(cache)).inserted,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,2);
  assert.equal((await next.unresolved()).length,0);
});

test('malformed record remains durable without target writes',async()=>{
  const s=await store();const id=await stage(s,[row('1'),{CallId:'missing-id'}]);
  await assert.rejects(s.drain(cache),/SOURCE_ID_INVALID/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
  assert.equal((await s.unresolved())[0]!.id,id);
});

test('recovery validates the requested PK range before writing',async()=>{
  const s=await store();const id=await s.beginRead({kind:'reread',date:'2026-10-01',start:'1',end:'2'},true);
  await s.stage(id,JSON.stringify([row('3')]),1);
  await assert.rejects(s.drain(cache),/RECOVERY_RESPONSE_OUTSIDE_RANGE/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
});

test('compiled check succeeds with read-only PostgreSQL sessions and sends zero HTTP requests',async()=>{
  let requests=0;
  const http=createServer((_req,res)=>{requests++;res.writeHead(500);res.end();});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const address=http.address();assert(address&&typeof address!=='string');
  const readonly=new URL(url!);readonly.searchParams.set('options','-c default_transaction_read_only=on');
  try {
    const result=await execute(process.execPath,['dist/main.js','check'],{env:{...process.env,
      DATABASE_URL:readonly.href,OLOS_SOURCE_KEY:'olos-admin-homolog',OLOS_BASE_URL:`http://127.0.0.1:${address.port}`,
      OLOS_USERNAME:'fixture',OLOS_PASSWORD:'fixture',OLOS_CLIENT_ID:'fixture',OLOS_CLIENT_SECRET:'fixture',
      DESTINATION_SCHEMA:'raw',DESTINATION_TABLE:'olos_calls'},timeout:10000});
    assert.match(result.stdout,/database_preflight_passed/);assert.equal(requests,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.reads')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
    assert.equal((await pool.query('SELECT is_called FROM raw.olos_calls_internal_id_olos_seq')).rows[0].is_called,false);
  } finally {await new Promise<void>((resolve,reject)=>http.close(e=>e?reject(e):resolve()));}
});

test('homologation probe only authenticates, refreshes, discovers and reads three static tables; outputs no secrets',async()=>{
  const calls:string[]=[];
  const catalog=[{TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
    {TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}];
  const http=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    const body=Buffer.concat(chunks).toString();
    if(req.url==='/api/auth') {
      const refresh=body.includes('\r\nrefresh_token\r\n');calls.push(refresh?'refresh':'password');
      res.end(JSON.stringify({access_token:'TOKEN_MUST_NOT_APPEAR',refresh_token:'REFRESH_MUST_NOT_APPEAR',token_type:'bearer',expires_in:3600}));
    } else if(req.url==='/api/export-data/available-tables') {calls.push('catalog');res.end(JSON.stringify(catalog));}
    else if(req.url==='/api/export-data/read-data') {
      const table=['Users','Campaign','Disposition'].find(name=>body.includes(`\r\n${name}\r\n`));calls.push(table??'invalid');
      if(table==='Users')res.end('[{"UserId":"1","AgentId":"7","UserName":"NAME_MUST_NOT_APPEAR","Password":"PASSWORD_MUST_NOT_APPEAR"}]');
      else if(table==='Campaign')res.end('[{"CampaignId":"8","Description":"NAME_MUST_NOT_APPEAR","CampaignCode":"08"}]');
      else res.end('[{"DispositionId":"9","Description":"NAME_MUST_NOT_APPEAR"}]');
    } else {calls.push('FORBIDDEN');res.writeHead(400);res.end('{}');}
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const address=http.address();assert(address&&typeof address!=='string');
  try {
    const result=await execute(process.execPath,['scripts/homologate-http.mjs'],{env:{...process.env,
      OLOS_BASE_URL:`http://127.0.0.1:${address.port}`,OLOS_USERNAME:'fixture',OLOS_PASSWORD:'PASSWORD_MUST_NOT_APPEAR',
      OLOS_CLIENT_ID:'fixture',OLOS_CLIENT_SECRET:'SECRET_MUST_NOT_APPEAR'},timeout:10000});
    assert.deepEqual(calls,['password','refresh','catalog','Disposition','Campaign','Users']);
    assert.doesNotMatch(result.stdout+result.stderr,/MUST_NOT_APPEAR|Password/);
    assert.match(result.stdout,/available_tables_passed/);
    assert.equal(result.stdout.split('\n').filter(line=>line.includes('static_table_result')).length,3);
  } finally {await new Promise<void>((resolve,reject)=>http.close(e=>e?reject(e):resolve()));}
});

test('baseline descarta registros antigos e preserva os novos', async () => {
  const s = await store({
    ingestionBaseline: '2026-10-01T10:00:00-03:00'
  });

  const id = await stage(s, [
    row('100', { StartDate: '2026-10-01T09:59:59-03:00' }),
    row('101', { StartDate: '2026-10-01T10:00:00-03:00' }),
    row('102', { StartDate: '2026-10-01T10:00:01-03:00' })
  ]);

  const result = await s.drain(cache);

  assert.equal(result.inserted, 2);

  const saved = await pool.query(
    'SELECT olos_call_id FROM raw.olos_calls'
  );

  assert.equal(saved.rowCount, 2);

  const progress = await pool.query(
    'SELECT processed_count, state FROM olos_http.reads WHERE id=$1',
    [id]
  );

  assert.equal(progress.rows[0].processed_count, 3);
  assert.equal(progress.rows[0].state, 'done');
});

test('baseline com lote totalmente antigo avança checkpoint', async () => {
  const s = await store({
    ingestionBaseline: '2026-10-02T00:00:00Z'
  });

  const id = await stage(s, [
    row('200'),
    row('201')
  ]);

  const result = await s.drain(cache);

  assert.equal(result.inserted, 0);

  const calls = await pool.query(
    'SELECT count(*)::int AS total FROM raw.olos_calls'
  );

  assert.equal(calls.rows[0].total, 0);

  const markers = await pool.query(
    'SELECT count(*)::int AS total FROM olos_http.records'
  );

  assert.equal(markers.rows[0].total, 0);

  const progress = await pool.query(
    'SELECT processed_count, state FROM olos_http.reads WHERE id=$1',
    [id]
  );

  assert.equal(progress.rows[0].processed_count, 2);
  assert.equal(progress.rows[0].state, 'done');
});

// Exercise the production consumer with real local HTTP and durable recovery state.
async function simulatedOlos() {
  let consuming = 0;
  const catalog = [
    {TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
    {TableName:'Users',Columns:['AgentId','UserName']}, {TableName:'Campaign',Columns:['CampaignId','Description']},
    {TableName:'Disposition',Columns:['DispositionId','Description']},
  ];
  const server = createServer(async (req,res) => {
    for await (const _ of req) { /* consume multipart */ }
    if (req.url === '/api/auth') res.end(JSON.stringify({access_token:'fixture',token_type:'bearer',expires_in:3600}));
    else if (req.url?.endsWith('/available-tables')) res.end(JSON.stringify(catalog));
    else if (req.url?.endsWith('/read-data')) res.end('[]');
    else { consuming++; res.end('[]'); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return {count:()=>consuming, snapshot:async()=>({revision:0,credentials:{baseUrl:`http://127.0.0.1:${address.port}`,username:'u',password:'p',clientId:'i',clientSecret:'s'}}),
    close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
const managedConfig = () => ({...cfg,ingestionBaseline:'2026-10-01T00:00:00Z',sourceTimeZone:'UTC'});
for (const [emptyResponse,kind] of [[false,'current'],[true,'current'],[false,'previous']] as const) test(`scheduler consumer recovers durable received ${kind} (${emptyResponse ? 'empty' : 'rows'}) before admitting any POST`, async () => {
  const s=await store(); await stage(s,emptyResponse ? [] : [row('1'),row('2'),row('3')],kind);
  await s.close(); stores.splice(stores.indexOf(s),1);
  const mock=await simulatedOlos();
  try {
    const consumer=await createScheduledConsumer(managedConfig(),mock.snapshot);
    try {
      assert.equal(mock.count(),0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM olos_http.reads WHERE state='received'")).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,emptyResponse?0:3);
      await consumer.cycle(); assert.equal(mock.count(),1);
    } finally {await consumer.close();}
    const again=await createScheduledConsumer(managedConfig(),mock.snapshot); await again.close();
    assert.equal(mock.count(),1);
  } finally {await mock.close();}
});
test('response received but stage never committed remains blocked across restart', async()=>{
  const s=await store(); const mock=fakeApi(async()=>JSON.stringify([row('1')]));
  s.stage=async()=>{throw new WorkerError('DATABASE_SESSION_LOST');};
  await assert.rejects(new Worker(s,mock.api,new StaticCache(mock.api,3600000)).cycle(),/RECOVERY_REQUIRED/);
  await s.close(); stores.splice(stores.indexOf(s),1);
  let snapshots=0;
  await assert.rejects(createScheduledConsumer(managedConfig(),async()=>{snapshots++; throw new Error('must not load');}),/RECONCILIATION_REQUIRED/);
  assert.equal(snapshots,0); assert.equal(mock.count(),1);
  assert.equal((await pool.query('SELECT state FROM olos_http.reads')).rows[0].state,'reading');
});
test('stage committed but acknowledgement lost recovers automatically without reconsumption', async()=>{
  const s=await store(); const mock=fakeApi(async()=>JSON.stringify([row('1')])); const stageOriginal=s.stage.bind(s);
  s.stage=async(...args)=>{await stageOriginal(...args);throw new Error('lost stage acknowledgement');};
  await assert.rejects(new Worker(s,mock.api,new StaticCache(mock.api,3600000)).cycle(),/RECOVERY_REQUIRED/);
  await s.close(); stores.splice(stores.indexOf(s),1);
  const http=await simulatedOlos();
  try {const consumer=await createScheduledConsumer(managedConfig(),http.snapshot);await consumer.close();assert.equal(http.count(),0);}
  finally {await http.close();}
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,1);
  assert.equal((await pool.query('SELECT state FROM olos_http.reads')).rows[0].state,'done');
});

test('pre-intent authentication timeout leaves no journal intent and permits a later safe cycle',async()=>{
  const s=await store();const mock=fakeApi(async()=>'[]');
  const getToken=mock.api.auth.getToken.bind(mock.api.auth);
  mock.api.auth.getToken=async()=>{throw new WorkerError('NETWORK_OR_RESPONSE_FAILURE',true);};
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.cycle(),/AUTH_UNAVAILABLE/);
  assert.equal((await s.unresolved()).length,0);assert.equal(mock.count(),0);
  mock.api.auth.getToken=getToken;await worker.cycle();assert.equal(mock.count(),1);
});

async function recoveryPlan(s:Store,ranges:RecoveryRange[]=[{start:'1',end:'3',expectedIds:['1','2','3']}],approve=true) {
  const parent=await s.beginRead({kind:'current'});await s.markError(parent,'RESPONSE_TOO_LARGE');
  await pool.query("UPDATE olos_http.reads SET started_at='2026-11-12T13:00:00Z' WHERE id=$1",[parent]);
  const manifest:RecoveryManifest={version:1,sourceKey:s.cfg.sourceKey,targetTable:s.target,parentId:parent,parentStartedAt:'2026-11-12T13:00:00.000Z',date:'2026-11-12',
    evidenceRef:'SYNTHETIC-OLOS-TICKET',evidenceSha256:fingerprint('synthetic official evidence'),remoteOperationComplete:true,rereadCursorSafe:true,exactIdsConfirmed:true,
    operation:{start:ranges[0]!.start,end:ranges.at(-1)!.end,quantity:String(ranges.reduce((n,r)=>n+r.expectedIds.length,0)),dateRead:'2026-11-12T10:00:00.123'},ranges};
  const hash=approve?await s.authorizeRecovery(manifest):fingerprint(JSON.stringify(manifest));
  const capture=(range=ranges[0]!)=>s.beginRecoveryRead(parent,{kind:'reread',date:manifest.date,start:range.start,end:range.end},hash);
  return {parent,manifest,hash,capture};
}
test('scoped rereads preserve preexisting calls, exact BigInt IDs, duplicates and complete coverage before resolution',async()=>{
  const s=await store();await stage(s,[row('2')]);await s.drain(cache);
  const original=(await pool.query('SELECT * FROM raw.olos_calls')).rows;
  const ranges=[{start:'1',end:'2',expectedIds:['1','2']},{start:'9007199254740993',end:'9007199254740993',expectedIds:['9007199254740993']}];
  const p=await recoveryPlan(s,ranges);
  assert.equal(await s.authorizeRecovery(p.manifest),p.hash);
  await assert.rejects(s.authorizeRecovery({...p.manifest,evidenceRef:'SYNTHETIC-OTHER'}),/AUTHORIZATION_CHANGED/);
  await assert.rejects(s.resolve(p.parent,'unverified operator evidence'),/COVERAGE_NOT_PROVEN/);
  await assert.rejects(s.beginRead({kind:'reread',date:p.manifest.date,start:'1',end:'2'},true),/AUTHORIZATION_REQUIRED/);
  const first=await p.capture();await s.stage(first,JSON.stringify([row('1'),row('2'),row('1')]),1);
  const result=await s.drain(cache);assert.equal(result.inserted,1);assert.equal(result.duplicates,2);
  await assert.rejects(p.capture(),/RANGE_OVERLAP/);assert.equal((await s.verifyRecovery(p.parent)).complete,false);
  const second=await p.capture(ranges[1]!);await s.stage(second,JSON.stringify([row('9007199254740993')]),1);await s.drain(cache);
  const report=await s.verifyRecovery(p.parent);assert.equal(report.complete,true);assert.equal(report.covered,3);
  assert.deepEqual(await s.verifyRecovery(p.parent),report);
  await s.resolve(p.parent,`recovery:${report.verification_digest}`);
  const parent=(await pool.query('SELECT state,response_body,processed_count,error_code FROM olos_http.reads WHERE id=$1',[p.parent])).rows[0];
  assert.deepEqual(parent,{state:'resolved',response_body:null,processed_count:0,error_code:'RESPONSE_TOO_LARGE'});
  assert.deepEqual((await pool.query('SELECT * FROM raw.olos_calls WHERE internal_id_olos=$1',[original[0].internal_id_olos])).rows,original);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,3);
});
for(const [name,data] of [
  ['empty',[]],['missing',[row('1')]],['unexpected',[row('1'),row('2'),row('3'),row('4')]],
  ['conflicting duplicate',[row('1'),row('2'),row('3'),row('1',{CallId:'different'})]],
] as const)test(`a ${name} reread response never advances a checkpoint or completes`,async()=>{
  const s=await store(),p=await recoveryPlan(s),child=await p.capture();await s.stage(child,JSON.stringify(data),1);
  await assert.rejects(s.drain(cache),/RECOVERY_RESPONSE_COVERAGE_MISMATCH|SOURCE_ID_CONTENT_CONFLICT/);
  const state=(await pool.query('SELECT state,processed_count,response_body IS NOT NULL AS durable FROM olos_http.reads WHERE id=$1',[child])).rows[0];
  assert.deepEqual(state,{state:'received',processed_count:0,durable:true});
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
  assert.equal((await s.verifyRecovery(p.parent)).complete,false);
  await assert.rejects(s.resolve(child,'discard child to resume capture'),/CHILD_RESOLUTION_FORBIDDEN/);
});
test('reread validates conflicts in later batches before the first write',async()=>{
  const s=await store({ingestionBaseline:'2026-09-01T00:00:00Z'});await stage(s,[row('3')]);await s.drain(cache);
  const p=await recoveryPlan(s),child=await p.capture();await s.stage(child,JSON.stringify([row('1'),row('2'),row('3',{CallId:'changed'})]),1);
  await assert.rejects(s.drain(cache),/SOURCE_ID_CONTENT_CONFLICT/);
  assert.equal((await pool.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[child])).rows[0].processed_count,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,1);
});
test('a baseline cannot silently discard any expected recovery record',async()=>{
  const s=await store({ingestionBaseline:'2026-11-01T00:00:00Z'}),p=await recoveryPlan(s),child=await p.capture();
  await s.stage(child,JSON.stringify([row('1'),row('2'),row('3')]),1);
  await assert.rejects(s.drain(cache),/BASELINE_EXCLUDES_RECORD/);
  assert.equal((await pool.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[child])).rows[0].processed_count,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
});
test('reread processing resumes confirmed batches after a failed transaction and restart without losing records',async()=>{
  const s=await store(),p=await recoveryPlan(s),child=await p.capture();await s.stage(child,JSON.stringify([row('1'),row('2'),row('3')]),1);
  // Inject a real transaction failure after exactly one batch has committed.
  await pool.query("CREATE FUNCTION raw.fail_recovery_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM raw.olos_calls)>=2 THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_recovery BEFORE INSERT ON raw.olos_calls FOR EACH ROW EXECUTE FUNCTION raw.fail_recovery_count()");
  await assert.rejects(s.drain(cache));
  assert.equal((await pool.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[child])).rows[0].processed_count,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,2);
  await s.close();stores.splice(stores.indexOf(s),1);await pool.query('DROP TRIGGER fail_recovery ON raw.olos_calls');
  const next=await store();assert.equal((await next.drain(cache)).inserted,1);
  assert.equal((await next.drain(cache)).inserted,0);assert.equal((await next.verifyRecovery(p.parent)).complete,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,3);
});
test('oversized reread stays uncertain across restart and never retries or resolves the child',async()=>{
  const s=await store(),p=await recoveryPlan(s),mock=fakeApi(async()=>{throw new WorkerError('RESPONSE_TOO_LARGE');});
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.captureReread(p.parent,p.manifest.date,'1','3',p.hash),/RECOVERY_REQUIRED/);assert.equal(mock.count(),1);
  const child=(await pool.query("SELECT id,state,processed_count,response_body,error_code FROM olos_http.reads WHERE id<>$1",[p.parent])).rows[0];
  assert.equal(child.state,'reading');assert.equal(child.processed_count,0);assert.equal(child.response_body,null);assert.equal(child.error_code,'RESPONSE_TOO_LARGE');
  await s.close();stores.splice(stores.indexOf(s),1);const next=await store();
  await assert.rejects(next.beginRecoveryRead(p.parent,{kind:'reread',date:p.manifest.date,start:'1',end:'3'},p.hash),/RECOVERY_REQUIRED/);
  await assert.rejects(next.resolve(child.id,'unverified retry or discard'),/CHILD_RESOLUTION_FORBIDDEN/);
  assert.equal((await next.verifyRecovery(p.parent)).complete,false);assert.equal(mock.count(),1);
});
test('lost staging and batch COMMIT acknowledgements recover durable children without another HTTP request',async()=>{
  const s=await store(),p=await recoveryPlan(s,[{start:'1',end:'2',expectedIds:['1','2']}]),mock=fakeApi(async()=>JSON.stringify([row('1'),row('2')]));
  const stageOriginal=s.stage.bind(s);s.stage=async(...args)=>{await stageOriginal(...args);throw new Error('synthetic staging ACK loss');};
  await assert.rejects(new Worker(s,mock.api,new StaticCache(mock.api,3600000)).captureReread(p.parent,p.manifest.date,'1','2',p.hash),/RECOVERY_REQUIRED/);
  const query=s.client!.query.bind(s.client!);let lost=false;
  s.client!.query=(async(sql:string,parameters?:unknown[])=>{const result=await query(sql,parameters);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('synthetic COMMIT ACK loss');}return result;}) as typeof query;
  await assert.rejects(s.drain(cache));s.client!.query=query;
  await s.close();stores.splice(stores.indexOf(s),1);const next=await store();
  assert.equal((await next.drain(cache)).inserted,0);assert.equal((await next.verifyRecovery(p.parent)).complete,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,2);assert.equal(mock.count(),1);
});
test('coverage detects missing destination rows and changed hashes before authorizing resolution',async()=>{
  const s=await store(),p=await recoveryPlan(s),child=await p.capture();await s.stage(child,JSON.stringify([row('1'),row('2'),row('3')]),1);await s.drain(cache);
  const complete=await s.verifyRecovery(p.parent);assert.equal(complete.complete,true);
  await pool.query("UPDATE olos_http.records SET source_hash=repeat('b',64) WHERE source_id='3'");
  assert.equal((await s.verifyRecovery(p.parent)).conflicts,1);
  await assert.rejects(s.resolve(p.parent,`recovery:${complete.verification_digest}`),/COVERAGE_NOT_PROVEN/);
  await pool.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=(SELECT target_id FROM olos_http.records WHERE source_id=$1)',['2']);
  assert.equal((await s.verifyRecovery(p.parent)).missing,1);
});
test('wrong scopes never consume and concurrent capture processes cannot share the source',async()=>{
  const s=await store(),p=await recoveryPlan(s,[{start:'1',end:'1',expectedIds:['1']}]);
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const mock=fakeApi(async()=>{entered();await waiting;return JSON.stringify([row('1')]);});
  const worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.captureReread(p.parent,'2026-10-28','1','1',p.hash),/OUTSIDE_AUTHORIZED_RANGE/);
  await assert.rejects(worker.captureReread(p.parent,p.manifest.date,'1','1','b'.repeat(64)),/OUTSIDE_AUTHORIZED_RANGE/);assert.equal(mock.count(),0);
  const pending=worker.captureReread(p.parent,p.manifest.date,'1','1',p.hash);await started;
  try{
    await assert.rejects(worker.captureReread(p.parent,p.manifest.date,'1','1',p.hash),/POLL_ALREADY_ACTIVE/);
    const second=new Store(cfg);try{await assert.rejects(second.open(),/CONSUMER_ALREADY_ACTIVE/);}finally{await second.close();}
  }finally{release();await pending;}
  assert.equal(mock.count(),1);
});
for(const committed of [false,true])test(`uncertain first authorization COMMIT (committed=${committed}) is reusable without partial approval`,async()=>{
  const s=await store(),p=await recoveryPlan(s,undefined,false);const query=s.client!.query.bind(s.client!);
  s.client!.query=(async(sql:string,parameters?:unknown[])=>{
    if(sql==='COMMIT'&&!committed)throw new Error('synthetic COMMIT transport failure');
    const result=await query(sql,parameters);if(sql==='COMMIT')throw new Error('synthetic authorization ACK loss');return result;
  }) as typeof query;
  await assert.rejects(s.authorizeRecovery(p.manifest),/AUTHORIZATION_COMMIT_UNKNOWN/);s.client!.query=query;
  assert.equal((await pool.query("SELECT spec ? 'recovery_authorization' AS approved FROM olos_http.reads WHERE id=$1",[p.parent])).rows[0].approved,committed);
  await s.close();stores.splice(stores.indexOf(s),1);const next=await store();
  assert.equal(await next.authorizeRecovery(p.manifest),p.hash);assert.equal((await next.verifyRecovery(p.parent)).complete,false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.reads')).rows[0].n,1);
});
test('a lost child intent acknowledgement sends no HTTP and blocks a second capture after restart',async()=>{
  const s=await store(),p=await recoveryPlan(s),mock=fakeApi(async()=>JSON.stringify([row('1'),row('2'),row('3')]));
  const query=s.client!.query.bind(s.client!);
  s.client!.query=(async(sql:string,parameters?:unknown[])=>{const result=await query(sql,parameters);if(sql.startsWith('INSERT INTO olos_http.reads'))throw new Error('synthetic intent ACK loss');return result;}) as typeof query;
  await assert.rejects(new Worker(s,mock.api,new StaticCache(mock.api,3600000)).captureReread(p.parent,p.manifest.date,'1','3',p.hash));s.client!.query=query;
  assert.equal(mock.count(),0);await s.close();stores.splice(stores.indexOf(s),1);
  const next=await store();await assert.rejects(next.beginRecoveryRead(p.parent,{kind:'reread',date:p.manifest.date,start:'1',end:'3'},p.hash),/RECOVERY_REQUIRED/);
  assert.equal((await next.verifyRecovery(p.parent)).complete,false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM olos_http.reads WHERE state='reading' AND response_body IS NULL AND processed_count=0")).rows[0].n,2);
});
test('a lost resolution acknowledgement is reconciled by the same proof without rewriting history',async()=>{
  const s=await store(),p=await recoveryPlan(s),child=await p.capture();await s.stage(child,JSON.stringify([row('1'),row('2'),row('3')]),1);await s.drain(cache);
  const proof=`recovery:${(await s.verifyRecovery(p.parent)).verification_digest}`,query=s.client!.query.bind(s.client!);
  s.client!.query=(async(sql:string,parameters?:unknown[])=>{const result=await query(sql,parameters);if(sql.startsWith("UPDATE olos_http.reads SET state='resolved'"))throw new Error('synthetic resolution ACK loss');return result;}) as typeof query;
  await assert.rejects(s.resolve(p.parent,proof));s.client!.query=query;
  const before=(await pool.query('SELECT * FROM olos_http.reads WHERE id=$1',[p.parent])).rows;
  await s.close();stores.splice(stores.indexOf(s),1);const next=await store();
  assert.equal((await next.verifyRecovery(p.parent)).parent_state,'resolved');await next.resolve(p.parent,proof);
  assert.deepEqual((await pool.query('SELECT * FROM olos_http.reads WHERE id=$1',[p.parent])).rows,before);
});
test('scheduler stays blocked until verified resolution, then admits the next normal cycle',async()=>{
  const options=managedConfig(),s=await store(options),p=await recoveryPlan(s),child=await p.capture();
  await s.stage(child,JSON.stringify([row('1'),row('2'),row('3')]),1);await s.drain(cache);
  await s.close();stores.splice(stores.indexOf(s),1);
  let snapshots=0;
  await assert.rejects(createScheduledConsumer(options,async()=>{snapshots++;throw new Error('must not authenticate');}),/RECONCILIATION_REQUIRED/);assert.equal(snapshots,0);
  const next=await store(options),report=await next.verifyRecovery(p.parent);assert.equal(report.complete,true);
  await next.resolve(p.parent,`recovery:${report.verification_digest}`);await next.resolve(p.parent,`recovery:${report.verification_digest}`);
  await next.close();stores.splice(stores.indexOf(next),1);
  const http=await simulatedOlos();
  try{const consumer=await createScheduledConsumer(options,http.snapshot);try{await consumer.cycle();assert.equal(http.count(),1);}finally{await consumer.close();}}
  finally{await http.close();}
});
test('a near-budget synthetic recovery uses bounded batches and stays below the Admin memory limit',async()=>{
  const s=await store({batchSize:500}),ids=Array.from({length:2000},(_,i)=>String(i+1));
  const p=await recoveryPlan(s,[{start:'1',end:'2000',expectedIds:ids}]),child=await p.capture();
  const body=JSON.stringify(ids.map(id=>row(id,{CampaignData:'x'.repeat(3000)})));
  assert(Buffer.byteLength(body)>6*1024*1024&&Buffer.byteLength(body)<s.cfg.recoveryMaxResponseBytes);
  const start=performance.now();await s.stage(child,body,1);const result=await s.drain(cache);assert.equal(result.inserted,2000);
  assert.equal((await s.verifyRecovery(p.parent)).complete,true);
  const maxRss=process.resourceUsage().maxRSS*1024;
  console.log(JSON.stringify({test:'synthetic_scoped_reread_2000_rows',response_bytes:Buffer.byteLength(body),batch_size:s.cfg.batchSize,duration_ms:Math.round(performance.now()-start),max_rss_bytes:maxRss}));
  assert(maxRss<1536*1024*1024);
});
for(const version of [1,2])test(`compiled administrative CLI v${version} captures once and preserves its resolution policy with local HTTP and PostgreSQL`,async()=>{
  let rereads=0,current=0;
  const catalog=[{TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
    {TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}];
  const http=createServer(async(req,res)=>{
    for await(const _ of req){ /* consume multipart */ }
    if(req.url==='/api/auth')res.end(JSON.stringify({access_token:'PRIVATE_FIXTURE_TOKEN',token_type:'bearer',expires_in:3600}));
    else if(req.url?.endsWith('/available-tables'))res.end(JSON.stringify(catalog));
    else if(req.url?.endsWith('/read-data'))res.end('[]');
    else if(req.url?.endsWith('/re-read-data')){
      rereads++;res.end(JSON.stringify([row('1'),row('2'),row('3')]));
    }else{current++;res.writeHead(500);res.end();}
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');const address=http.address();assert(address&&typeof address!=='string');
  const dir=await mkdtemp(join(tmpdir(),'olos-recovery-cli-'));
  const env={DATABASE_URL:url!,OLOS_SOURCE_KEY:cfg.sourceKey,SOURCE_ID_UNIQUENESS_CONFIRMED:'true',
    OLOS_BASE_URL:`http://127.0.0.1:${address.port}`,OLOS_USERNAME:'fixture',OLOS_PASSWORD:'PRIVATE_FIXTURE_PASSWORD',OLOS_CLIENT_ID:'fixture',OLOS_CLIENT_SECRET:'PRIVATE_FIXTURE_SECRET',
    SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-09-01T00:00:00Z',BATCH_SIZE:'2'};
  const cli=(args:string[],authorized=false)=>execute(process.execPath,['dist/main.js',...args],{env:{...env,...(authorized?{OLOS_REREAD_CONFIRMATION:'AUTHORIZE_EXPORTDATA_REREAD_RECOVERY'}:{})},timeout:10000});
  try{
    const s=await store(config(env)),p=await recoveryPlan(s,undefined,false);await s.close();stores.splice(stores.indexOf(s),1);
    const evidence=JSON.stringify([{TableName:'AttemptsRawData',PKColumnName:'AttemptsRawDataID',DateExport:'2026-11-12T00:00:00',
      PKIDStart:1,PKIDEnd:3,Quantity:3,DateRead:p.manifest.operation.dateRead}]);
    p.manifest.evidenceSha256=fingerprint(evidence);
    const {remoteOperationComplete,rereadCursorSafe,exactIdsConfirmed,ranges,...base}=p.manifest;
    const progressive={...base,version:2,mode:'progressive',documentationRef:'ExportDataV3-v1.1.0/re-read-data',ranges:ranges.map(({start,end})=>({start,end}))};
    const raw=JSON.stringify(version===1?p.manifest:progressive),mp=join(dir,'manifest.json'),ep=join(dir,'official-log.json');
    await writeFile(mp,raw,{mode:0o600});await writeFile(ep,evidence,{mode:0o600});
    const args=['recovery-authorize',mp,ep,fingerprint(raw)];
    await assert.rejects(cli(args),(error:unknown)=>typeof error==='object'&&error!==null&&'stdout' in error&&String(error.stdout).includes('RECOVERY_NOT_AUTHORIZED'));
    const approved=JSON.parse((await cli(args,true)).stdout.trim());assert.equal(approved.event,'recovery_authorized');
    const captured=await cli(['capture-reread',p.parent,'2026-11-12','1','3','--authorization',approved.authorization_hash]);
    assert.match(captured.stdout,/capture_reread_received/);
    await cli(['recover-local']);const output=join(dir,'audit.json');
    let stdout='';
    try{stdout=(await cli(['recovery-verify',p.parent,'--output',output])).stdout;}
    catch(error){assert.equal(version,2);assert(error&&typeof error==='object'&&'stdout' in error);stdout=String(error.stdout);}
    const coverage=JSON.parse(stdout.trim());assert.equal(coverage.complete,version===1);assert.equal(coverage.covered,3);
    const audit=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(audit.unobserved_ranges,[]);assert.equal((await stat(output)).mode&0o077,0);
    assert(!('unobserved_ranges' in coverage));assert(audit.verified_at);
    if(version===1){
      await cli(['resolve',p.parent,`recovery:${coverage.verification_digest}`]);assert.equal((await cli(['status'])).stdout,'');
      assert.equal(JSON.parse((await cli(['recovery-verify',p.parent])).stdout.trim()).parent_state,'resolved');
    }else{
      assert.equal(coverage.coverage_complete,true);assert.equal(coverage.resolution_allowed,false);
      await assert.rejects(cli(['resolve',p.parent,`recovery:${coverage.coverage_digest}`]),(error:unknown)=>!!error&&typeof error==='object'&&'stdout' in error&&String(error.stdout).includes('COVERAGE_NOT_PROVEN'));
      assert.match((await cli(['status'])).stdout,/reading/);
    }
    assert.equal(rereads,1);assert.equal(current,0);assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,3);
  }finally{await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

async function progressivePlan(s:Store,ranges=[{start:'1',end:'3'}],quantity='3') {
  const parent=await s.beginRead({kind:'current'});await s.markError(parent,'RESPONSE_TOO_LARGE');
  await pool.query("UPDATE olos_http.reads SET started_at='2026-11-12T13:00:00Z' WHERE id=$1",[parent]);
  const manifest:ProgressiveRecoveryManifest={version:2,sourceKey:s.cfg.sourceKey,targetTable:s.target,parentId:parent,parentStartedAt:'2026-11-12T13:00:00.000Z',date:'2026-11-12',
    evidenceRef:'SYNTHETIC-OLOS-LOG',evidenceSha256:fingerprint('synthetic official evidence'),mode:'progressive',documentationRef:'ExportDataV3-v1.1.0/re-read-data',
    operation:{start:ranges[0]!.start,end:ranges.at(-1)!.end,quantity,dateRead:'2026-11-12T10:00:00.123'},ranges};
  const hash=await s.authorizeRecovery(manifest);
  const capture=(start=ranges[0]!.start,end=ranges[0]!.end,missingOnly=false)=>s.beginRecoveryRead(parent,{kind:'reread',date:manifest.date,start,end},hash,missingOnly);
  return {parent,manifest,hash,capture};
}
test('progressive recovery distinguishes raw count and extremes from exhaustive observed coverage',async()=>{
  const s=await store(),p=await progressivePlan(s),child=await p.capture();
  const original=(await pool.query('SELECT state,response_body,processed_count,error_code,started_at FROM olos_http.reads WHERE id=$1',[p.parent])).rows;
  // Three rows and both official extremes still leave the interior ID unobserved.
  await s.stage(child,JSON.stringify([row('1'),row('3'),row('1')]),1);const result=await s.drain(cache);
  assert.equal(result.inserted,2);assert.equal(result.duplicates,1);
  const report=await s.verifyRecovery(p.parent);assert.equal(report.complete,false);
  assert('coverage_complete' in report);assert.equal(report.coverage_complete,false);assert.equal(report.observed_unique,2);assert.equal(report.covered,2);
  assert.deepEqual(report.unobserved_ranges,[{start:'2',end:'2'}]);assert.equal(report.verification_digest,null);
  await assert.rejects(p.capture('1','1',true),/RANGE_ALREADY_OBSERVED/);
  await assert.rejects(p.capture('2','2'),/OUTSIDE_AUTHORIZED_RANGE/);
  const supplement=await p.capture('2','2',true);await s.stage(supplement,JSON.stringify([row('2')]),1);await s.drain(cache);
  const complete=await s.verifyRecovery(p.parent);assert('coverage_complete' in complete);assert.equal(complete.coverage_complete,true);
  assert.equal(complete.covered,3);assert.equal(complete.complete,false);assert.equal(complete.resolution_allowed,false);assert(complete.coverage_digest);
  await assert.rejects(s.resolve(p.parent,`recovery:${complete.coverage_digest}`),/COVERAGE_NOT_PROVEN/);
  await assert.rejects(p.capture('2','2',true),/RANGE_OVERLAP/);
  assert.deepEqual((await pool.query('SELECT state,response_body,processed_count,error_code,started_at FROM olos_http.reads WHERE id=$1',[p.parent])).rows,original);
});
test('empty progressive observations permit other planned blocks but never establish absence or resolution',async()=>{
  const s=await store(),p=await progressivePlan(s,[{start:'1',end:'2'},{start:'3',end:'4'}],'4');
  await assert.rejects(p.capture('1','1',true),/MISSING_ONLY_REQUIRES_OBSERVATION/);
  const empty=await p.capture('1','2');await s.stage(empty,'[]',1);await s.drain(cache);
  const next=await p.capture('3','4');await s.stage(next,JSON.stringify([row('3'),row('4')]),1);await s.drain(cache);
  const supplement=await p.capture('1','2',true);await s.stage(supplement,'[]',1);await s.drain(cache);
  const report=await s.verifyRecovery(p.parent);assert('coverage_complete' in report);assert.equal(report.coverage_complete,false);assert.equal(report.covered,2);
  assert.deepEqual(report.unobserved_ranges,[{start:'1',end:'2'}]);assert.equal(report.complete,false);
  await assert.rejects(p.capture('1','2',true),/RANGE_OVERLAP/);
  await assert.rejects(s.resolve(p.parent,'unobserved positions do not prove absence'),/COVERAGE_NOT_PROVEN/);
});
test('a sparse observation matching official quantity and both extremes does not prove the intervening position absent',async()=>{
  const s=await store(),p=await progressivePlan(s,[{start:'1',end:'3'}],'2'),child=await p.capture();await s.stage(child,JSON.stringify([row('1'),row('3')]),1);await s.drain(cache);
  const report=await s.verifyRecovery(p.parent);assert('coverage_complete' in report);assert.equal(report.covered,report.expected);
  assert.equal(report.unobserved_positions,1);assert.equal(report.coverage_complete,false);assert.equal(report.complete,false);
  assert.deepEqual(report.unobserved_ranges,[{start:'2',end:'2'}]);
});
for(const failure of ['NETWORK_OR_RESPONSE_FAILURE','RESPONSE_TOO_LARGE'])test(`progressive ${failure} never triggers a second HTTP request or another block`,async()=>{
  const s=await store(),p=await progressivePlan(s,[{start:'1',end:'1'},{start:'2',end:'3'}]);
  const mock=fakeApi(async()=>{throw new WorkerError(failure,true);}),worker=new Worker(s,mock.api,new StaticCache(mock.api,3600000));
  await assert.rejects(worker.captureReread(p.parent,p.manifest.date,'1','1',p.hash),/RECOVERY_REQUIRED/);
  await assert.rejects(worker.captureReread(p.parent,p.manifest.date,'2','3',p.hash),/RECOVERY_REQUIRED/);
  assert.equal(mock.count(),1);const read=(await s.unresolved()).find(read=>read.id!==p.parent)!;
  assert.equal(read.state,'reading');assert.equal(read.response_body,null);assert.equal(read.processed_count,0);
  await assert.rejects(p.capture('1','1',true),/RECOVERY_REQUIRED/);
});
for(const data of [[row('1'),row('4')],[row('1'),row('2'),row('1',{CallId:'changed'})]])test('progressive integrity failures preserve the body and write no processing checkpoint',async()=>{
  const s=await store(),p=await progressivePlan(s),child=await p.capture();await s.stage(child,JSON.stringify(data),1);
  await assert.rejects(s.drain(cache),/RESPONSE_OUTSIDE_RANGE|SOURCE_ID_CONTENT_CONFLICT/);
  const read=(await s.unresolved()).find(read=>read.id===child)!;assert.equal(read.state,'received');assert.equal(read.processed_count,0);assert(read.response_body);
  assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
});
test('progressive durable observations resume after restart without recapture or premature completion',async()=>{
  const s=await store(),p=await progressivePlan(s),child=await p.capture();await s.stage(child,JSON.stringify([row('1'),row('2'),row('3')]),1);
  const query=s.client!.query.bind(s.client!);let lost=false;
  s.client!.query=(async(sql:string,parameters?:unknown[])=>{const result=await query(sql,parameters);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('synthetic lost processing ACK');}return result;}) as typeof query;
  await assert.rejects(s.drain(cache));s.client!.query=query;await s.close();stores.splice(stores.indexOf(s),1);
  const next=await store();assert.equal((await next.drain(cache)).inserted,1);assert.equal((await next.drain(cache)).inserted,0);
  const report=await next.verifyRecovery(p.parent);assert('coverage_complete' in report);assert.equal(report.coverage_complete,true);assert.equal(report.complete,false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,3);
});
