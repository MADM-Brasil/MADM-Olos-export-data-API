import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,unlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Worker} from '../src/worker.js';
import {OlosApi} from '../src/api.js';
import {OlosAuthManager} from '../src/auth.js';
import {StaticCache} from '../src/cache.js';
import {HttpTransport} from '../src/http.js';
import {captureToDisk,verifyCaptureOnDisk} from '../src/capture-spool.js';
import {createScheduledConsumer} from '../src/admin/consumer.js';
import {fixture} from './corporate-sync.fixture.js';
import {observeLogs,type LogEntry} from '../src/errors.js';

const url=process.env.TEST_DATABASE_URL!;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_homolog'||process.env.OLOS_DIRECT_DISPOSABLE_TEST!=='true')throw new Error('Use the isolated corporate delivery test runner');
const cache={users:new Map([['7','Synthetic Agent']]),campaigns:new Map([['8','Campaign']]),dispositions:new Map([['9','Disposition']])};
const row=(id:string,extra:Record<string,unknown>={})=>({AttemptsRawDataID:id,CallId:`synthetic-${id}`,AgentId:'7',CampaignId:'8',DispositionId:'9',StartDate:'2026-11-12T10:00:00-03:00',OriginalPhoneNumber:'5500000000000',...extra});
async function* text(value:string){yield Buffer.from(value);}
test('durable capture pipeline with disposable PostgreSQL',async t=>{
  const pool=new pg.Pool({connectionString:url}),stores:Store[]=[],aborts=new Map<Store,AbortController>();
  const root=await mkdtemp(join(tmpdir(),'olos-spool-db-'));
  const migration=await readFile(new URL('../migrations/012_capture_spool.sql',import.meta.url),'utf8');
  const makeConfig=(extra:NodeJS.ProcessEnv={})=>config({DATABASE_URL:url,OLOS_SOURCE_KEY:'synthetic-spool',SOURCE_ID_UNIQUENESS_CONFIRMED:'true',
    CAPTURE_SPOOL_DIRECTORY:join(root,'captures'),SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-01-01T00:00:00Z',BATCH_SIZE:'2',...extra});
  async function open(cfg=makeConfig()){
    const abort=new AbortController(),store=new Store(cfg,()=>abort.abort(),abort.signal);stores.push(store);aborts.set(store,abort);await store.open();return store;
  }
  async function close(store:Store){stores.splice(stores.indexOf(store),1);await store.close();}
  async function reset(spool=true){
    for(const store of stores.splice(0))await store.close();
    await rm(join(root,'captures'),{recursive:true,force:true});
    await pool.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE; DROP SCHEMA IF EXISTS corporate_sync CASCADE');
    await pool.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../migrations/001_ingestion.sql',import.meta.url),'utf8'));
    if(spool)await pool.query(migration);
  }
  t.beforeEach(()=>reset());
  async function staged(store:Store,body:string){
    const id=await store.beginRead({kind:'current'}),capture=await captureToDisk(text(body),store.cfg.captureSpoolDirectory!,id,store.cfg.captureMaxBytes);
    await store.registerCaptureSpool(id,capture,7);return {id,capture};
  }
  async function journal(id:string){return (await pool.query('SELECT * FROM olos_http.reads WHERE id=$1',[id])).rows[0];}
  async function corporateSetup(extra:NodeJS.ProcessEnv={}){
    const destination=process.env.OLOS_DIRECT_TEST_DESTINATION_URL!;assert.equal(new URL(destination).hostname,'localhost');assert.equal(new URL(destination).pathname,'/madm');
    const remote=new pg.Client({connectionString:destination});await remote.connect();
    for(const file of ['corporate-sync/001_control.sql','002_corporate_delivery.sql','003_corporate_outbox_skipped.sql','005_corporate_campaign_policy.sql','006_corporate_collision_recovery.sql','007_corporate_collision_quarantine.sql'])await pool.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    await remote.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS olos_delivery_ids CASCADE');await remote.query(fixture(false));
    const cfg=makeConfig({ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:destination,OLOS_CORPORATE_CA_FILE:process.env.OLOS_DIRECT_TEST_CA_FILE!,
      OLOS_CORPORATE_LEGACY_BINDING:'a'.repeat(64),OLOS_CORPORATE_LEGACY_EXPECTED_COUNT:'0',OLOS_CORPORATE_RECONCILE_CONFIRMATION:'AUTHORIZE_CORPORATE_STATE_RECONCILIATION',...extra});
    await pool.query('INSERT INTO corporate_sync.control(singleton,binding,confirmed_count) VALUES(true,$1,0)',[cfg.corporateDelivery!.legacyBinding]);
    return {cfg,remote};
  }
  async function serverFor(store:Store,count=3,padding=0,interrupted=false){
    let requests=0;
    const expected=createHash('sha256');
    const server=createServer(async(req,res)=>{
      let fields='';for await(const bytes of req)fields+=String(bytes);
      if(req.url==='/api/auth')res.end(JSON.stringify({access_token:'PRIVATE_TOKEN',token_type:'bearer',expires_in:3600}));
      else if(req.url?.endsWith('/available-tables'))res.end(JSON.stringify([
        {TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
        {TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}]));
      else if(req.url?.endsWith('/read-data')){
        if(fields.includes('\r\nUsers\r\n'))res.end('[{"AgentId":"7","UserName":"Synthetic Agent"}]');
        else if(fields.includes('\r\nCampaign\r\n'))res.end('[{"CampaignId":"8","Description":"Campaign"}]');
        else res.end('[{"DispositionId":"9","Description":"Disposition"}]');
      }else if(req.url?.endsWith('/read-data-current-day')){
        requests++;assert.equal(req.method,'POST');
        const waiting=(await pool.query("SELECT count(*)::int n FROM olos_http.reads WHERE state='reading' AND spec->'capture'->>'storage'='spool'")).rows[0].n;assert.equal(waiting,1);
        if(interrupted){res.writeHead(200,{'Content-Length':1000000});res.write('[{"private":"PRIVATE_CALL_DATA"}');setImmediate(()=>res.destroy());return;}
        res.writeHead(200,{'Content-Type':'application/json'});
        const send=async(value:string)=>{expected.update(value);if(!res.write(value))await once(res,'drain');};
        await send('[');
        for(let i=0;i<count;i++){
          const id=String(9007199254740993n+BigInt(i));
          // Source IDs are numeric JSON literals above MAX_SAFE_INTEGER.
          const value=JSON.stringify(row(id,{Padding:'x'.repeat(padding)})).replace(`"AttemptsRawDataID":"${id}"`,`"AttemptsRawDataID":${id}`);
          await send((i?',':'')+value);
        }
        await send(']');res.end();
      }else{res.writeHead(500);res.end();}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
    const credentials={baseUrl:`http://127.0.0.1:${address.port}`,username:'synthetic',password:'PRIVATE_PASSWORD',clientId:'synthetic',clientSecret:'PRIVATE_SECRET'};
    const http=new HttpTransport(credentials.baseUrl,10000,32*1024*1024,aborts.get(store)!.signal);
    const api=new OlosApi(http.request,new OlosAuthManager(http.request,credentials),undefined,
      (path,fields,token,id)=>http.captureToSpool(path,fields,token,store.cfg.captureSpoolDirectory!,id,store.cfg.captureMaxBytes,store.cfg.captureTimeoutMs,aborts.get(store)!.signal));
    return {api,requests:()=>requests,hash:()=>expected.digest('hex'),snapshot:async()=>({revision:0,credentials}),
      close:async()=>{await http.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
  }
  try{
    await t.test('migration preserves the old journal and fails atomically on a second application',async()=>{
      await reset(false);const id=randomUUID();
      await pool.query("INSERT INTO olos_http.reads(id,source_key,target_table,spec,state,response_body) VALUES($1,'synthetic-spool','\"raw\".\"olos_calls\"','{\"kind\":\"current\"}','received','[]')",[id]);
      const before=await journal(id);await pool.query(migration);
      const {response_spool_read_id,...after}=await journal(id);assert.equal(response_spool_read_id,null);assert.deepEqual(after,before);
      const client=await pool.connect();try{await assert.rejects(client.query(migration));}finally{await client.query('ROLLBACK');client.release();}
      const store=await open();await store.drain(cache);assert.equal((await journal(id)).state,'done');
      await assert.rejects(pool.query("INSERT INTO olos_http.reads(id,source_key,target_table,spec,state) VALUES($1,'synthetic-spool','x','{}','received')",[randomUUID()]));
    });
    await t.test('spool mode fails before consumption when migration or storage permission is absent',async()=>{
      await reset(false);const store=new Store(makeConfig());try{await assert.rejects(store.open(),/MIGRATION_REQUIRED/);}finally{await store.close();}
      await pool.query(migration);const forbidden=await mkdtemp(join(root,'forbidden-'));await chmod(forbidden,0o500);
      const blocked=new Store(makeConfig({CAPTURE_SPOOL_DIRECTORY:forbidden}));
      try{await assert.rejects(blocked.open());}finally{await blocked.close();await chmod(forbidden,0o700);}
      assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.reads')).rows[0].n,0);
    });
    await t.test('an unrecognized legacy body constraint aborts the migration without weakening the journal',async()=>{
      await reset(false);
      const constraint=(await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='olos_http.reads'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid) LIKE '%response_body%'")).rows[0].conname;
      assert.match(constraint,/^[a-z_0-9]+$/);
      await pool.query(`ALTER TABLE olos_http.reads DROP CONSTRAINT ${constraint}, ADD CONSTRAINT custom_body CHECK (state NOT IN ('received','done') OR (response_body IS NOT NULL AND length(response_body)>1))`);
      const client=await pool.connect();try{await assert.rejects(client.query(migration),/READS_BODY_CONSTRAINT_NOT_UNIQUE/);}finally{await client.query('ROLLBACK');client.release();}
      assert.equal((await pool.query("SELECT to_regclass('olos_http.capture_spool') AS relation")).rows[0].relation,null);
      assert.equal((await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='olos_http.reads'::regclass AND conname='custom_body'")).rows[0].n,1);
    });
    await t.test('empty arrays finish locally and a lost completion acknowledgement is idempotent',async()=>{
      const store=await open(),{id,capture}=await staged(store,'[]'),query=store.client!.query.bind(store.client!);
      store.client!.query=(async(sql:string,parameters?:unknown[])=>{const result=await query(sql,parameters);if(sql.startsWith("UPDATE olos_http.reads SET state='done'"))throw new Error('synthetic completion ACK loss');return result;}) as typeof query;
      await assert.rejects(store.drain(cache));store.client!.query=query;
      assert.equal((await journal(id)).state,'done');assert.equal((await journal(id)).processed_count,0);
      await close(store);const resumed=await open();await resumed.registerCaptureSpool(id,capture);assert.equal((await resumed.drain(cache)).received,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
    });
    await t.test('complete capture registers atomically and normalizes through the real HTTP worker',async()=>{
      const store=await open(),http=await serverFor(store);
      try{
        const worker=new Worker(store,http.api,new StaticCache(http.api,3600000)),report=await worker.cycle();
        assert.equal(report.received,3);assert.equal(report.inserted,3);assert.equal(http.requests(),1);
        const read=await journal(report.read_id);assert.equal(read.state,'done');assert.equal(read.response_body,null);assert.equal(read.response_spool_read_id,read.id);assert.equal(read.processed_count,3);
        const capture=await store.inspectCaptureSpool(read.id);assert.equal(capture.sha256,http.hash());await verifyCaptureOnDisk(capture);
        assert.equal((await pool.query("SELECT count(*)::int n FROM olos_http.records WHERE source_id IN ('9007199254740993','9007199254740994','9007199254740995')")).rows[0].n,3);
      }finally{await http.close();}
    });
    await t.test('an interrupted consumptive response remains blocked after restart, without leaking provider data',async()=>{
      const store=await open(),http=await serverFor(store,3,0,true),logs:LogEntry[]=[],stop=observeLogs(entry=>logs.push(entry));
      try{
        await assert.rejects(new Worker(store,http.api,new StaticCache(http.api,3600000)).cycle(),/RECOVERY_REQUIRED/);
        const reads=(await pool.query('SELECT id,state,response_body,processed_count,response_spool_read_id FROM olos_http.reads')).rows;
        assert.equal(reads.length,1);assert.equal(reads[0].state,'reading');assert.equal(reads[0].response_body,null);assert.equal(reads[0].response_spool_read_id,null);assert.equal(reads[0].processed_count,0);
        await close(store);const resumed=await open();
        await assert.rejects(new Worker(resumed,http.api,new StaticCache(http.api,3600000)).cycle(),/RECOVERY_REQUIRED/);
        assert.equal(http.requests(),1);assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
        assert(!/PRIVATE_CALL_DATA|PRIVATE_PASSWORD|PRIVATE_TOKEN|PRIVATE_SECRET/.test(JSON.stringify(logs)));
      }finally{stop();await http.close();}
    });
    for(const committed of [false,true])await t.test(`registration COMMIT uncertainty (committed=${committed}) recovers without POST`,async()=>{
      const store=await open(),id=await store.beginRead({kind:'current'}),capture=await captureToDisk(text(JSON.stringify([row('1')])),store.cfg.captureSpoolDirectory!,id,102400);
      const query=store.client!.query.bind(store.client!);
      store.client!.query=(async(sql:string,parameters?:unknown[])=>{if(sql==='COMMIT'&&!committed)throw new Error('synthetic transport failure');const r=await query(sql,parameters);if(sql==='COMMIT')throw new Error('synthetic ACK loss');return r;}) as typeof query;
      await assert.rejects(store.registerCaptureSpool(id,capture,5),/COMMIT_UNKNOWN/);store.client!.query=query;
      assert.equal((await journal(id)).state,committed?'received':'reading');await close(store);
      const resumed=await open();await resumed.recoverPublishedCaptures();await resumed.registerCaptureSpool(id,capture);await resumed.drain(cache);
      assert.equal((await journal(id)).state,'done');assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,1);
    });
    await t.test('published orphan is adoptable; a partial or a final file without completion receipt is not',async()=>{
      const store=await open(),id=await store.beginRead({kind:'current'}),capture=await captureToDisk(text('[]'),store.cfg.captureSpoolDirectory!,id,1024);
      await unlink(capture.path+'.complete');await assert.rejects(store.recoverCaptureSpool(id));await store.recoverPublishedCaptures();assert.equal((await journal(id)).state,'reading');
      await writeFile(capture.path+'.partial','[]',{mode:0o600});await assert.rejects(store.recoverCaptureSpool(id));assert.equal((await journal(id)).response_body,null);
    });
    for(const failure of ['missing','corrupt','metadata'] as const)await t.test(`${failure} spool blocks all writes and completion`,async()=>{
      const store=await open(),{id,capture}=await staged(store,JSON.stringify([row('1')]));
      if(failure==='missing')await unlink(capture.path);
      if(failure==='corrupt')await writeFile(capture.path,JSON.stringify([row('9')]));
      if(failure==='metadata')await pool.query("UPDATE olos_http.capture_spool SET sha256=repeat('b',64) WHERE read_id=$1",[id]);
      await assert.rejects(store.drain(cache));assert.equal((await journal(id)).state,'received');assert.equal((await journal(id)).processed_count,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
    });
    for(const bad of ['truncated','duplicate','later invalid object'] as const)await t.test(`whole-file validation catches ${bad} before business rows`,async()=>{
      const store=await open();let body:string;
      if(bad==='truncated')body=JSON.stringify([row('1'),row('2'),row('3')]).slice(0,-1);
      else if(bad==='duplicate')body=JSON.stringify([row('1'),row('2'),row('1',{CallId:'changed'})]);
      else body=JSON.stringify([row('1'),row('2'),{CallId:'missing identity'}]);
      const {id}=await staged(store,body);await assert.rejects(store.drain(cache));
      assert.equal((await journal(id)).processed_count,0);assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,0);
    });
    await t.test('a source hash conflict in a later batch blocks all new business rows',async()=>{
      const store=await open();await staged(store,JSON.stringify([row('3')]));await store.drain(cache);
      const {id}=await staged(store,JSON.stringify([row('1'),row('2'),row('3',{CallId:'conflicting'})]));
      await assert.rejects(store.drain(cache),/SOURCE_ID_CONTENT_CONFLICT/);assert.equal((await journal(id)).processed_count,0);
      assert.deepEqual((await pool.query('SELECT source_id FROM olos_http.records ORDER BY source_id')).rows,[{source_id:'3'}]);
    });
    for(const corporate of [false,true])await t.test(`large HTTP spool resumes a committed prefix after restart (corporate=${corporate}), without replay`,async()=>{
      const setup=corporate?await corporateSetup({BATCH_SIZE:'16'}):undefined;
      const cfg=setup?.cfg??makeConfig({BATCH_SIZE:'16'}),store=await open(cfg);if(corporate)await store.reconcileCorporate();
      const http=await serverFor(store,128,512*1024);
      try{
        const id=await new Worker(store,http.api,new StaticCache(http.api,3600000)).captureOnce(),capture=await store.inspectCaptureSpool(id);
        assert(capture.bytes>64*1024*1024);assert.equal(capture.sha256,http.hash());
        const query=store.client!.query.bind(store.client!);let lost=false;
        store.client!.query=(async(sql:string,parameters?:unknown[])=>{const r=await query(sql,parameters);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('synthetic processing ACK loss');}return r;}) as typeof query;
        await assert.rejects(store.drain(cache));store.client!.query=query;assert.equal((await journal(id)).processed_count,16);await close(store);
        const consumer=await createScheduledConsumer(cfg,http.snapshot);await consumer.close();
        assert.equal(http.requests(),1);assert.equal((await journal(id)).state,'done');assert.equal((await journal(id)).processed_count,128);
        assert.equal((await pool.query('SELECT count(*)::int n FROM olos_http.records')).rows[0].n,128);
        if(corporate){
          assert.equal((await pool.query("SELECT count(*)::int n FROM olos_http.corporate_outbox WHERE state='pending'")).rows[0].n,128);
          assert.equal((await pool.query('SELECT confirmed_count::text FROM olos_http.corporate_control')).rows[0].confirmed_count,'0');
          assert.equal((await setup!.remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
        }
        const rss=process.resourceUsage().maxRSS*1024;console.log(JSON.stringify({synthetic:true,test:'large_stream_restart',bytes:capture.bytes,records:128,max_rss_bytes:rss}));assert(rss<1536*1024*1024);
      }finally{await http.close();await setup?.remote.end();}
    });
    await t.test('exclusive source ownership and local drain exclusion remain enforced',async()=>{
      const store=await open();await staged(store,JSON.stringify([row('1'),row('2')]));
      const second=new Store(makeConfig());try{await assert.rejects(second.open(),/CONSUMER_ALREADY_ACTIVE/);}finally{await second.close();}
      const first=store.drain(cache);await assert.rejects(store.drain(cache),/PERSISTENCE_ALREADY_ACTIVE/);await first;
    });
    await t.test('the historic uncertain parent is never adopted or bypassed by environment flags',async()=>{
      const store=await open(),id='2523225a-a46d-407a-ad5a-d1ff771e576e';
      await pool.query("INSERT INTO olos_http.reads(id,source_key,target_table,spec,error_code) VALUES($1,$2,$3,'{\"kind\":\"current\"}','RESPONSE_TOO_LARGE')",[id,store.cfg.sourceKey,store.target]);
      await assert.rejects(store.recoverCaptureSpool(id),/CAPTURE_INTENT_MISMATCH/);await store.recoverPublishedCaptures();await assert.rejects(store.beginRead({kind:'current'}),/RECOVERY_REQUIRED/);
      assert.equal((await journal(id)).state,'reading');assert.equal((await journal(id)).processed_count,0);assert.equal((await journal(id)).response_body,null);
    });
    await t.test('real HTTP to spool to corporate outbox preserves confirmed counters, hashes and quarantine',async()=>{
      const {cfg,remote}=await corporateSetup();
      try{
        const store=await open(cfg);await store.reconcileCorporate();const before=(await pool.query('SELECT * FROM olos_http.corporate_control')).rows;
        const quarantine=(await pool.query('SELECT * FROM olos_http.corporate_collision_quarantine')).rows,http=await serverFor(store,3);
        try{
          const report=await new Worker(store,http.api,new StaticCache(http.api,3600000)).cycle();assert.equal(report.queued,3);assert.equal(http.requests(),1);
          const outbox=(await pool.query('SELECT source_id,source_hash,payload_hash,state FROM olos_http.corporate_outbox ORDER BY source_id')).rows;assert.equal(outbox.length,3);assert(outbox.every(row=>row.state==='pending'));
          assert.deepEqual((await pool.query('SELECT * FROM olos_http.corporate_control')).rows,before);assert.deepEqual((await pool.query('SELECT * FROM olos_http.corporate_collision_quarantine')).rows,quarantine);
          assert.equal((await remote.query('SELECT count(*)::int n FROM raw.olos_calls')).rows[0].n,0);
          assert.equal((await store.drain(cache)).received,0);assert.deepEqual((await pool.query('SELECT source_id,source_hash,payload_hash,state FROM olos_http.corporate_outbox ORDER BY source_id')).rows,outbox);
        }finally{await http.close();}
      }finally{await remote.end();}
    });
  }finally{for(const store of stores)await store.close();await pool.end();await rm(root,{recursive:true,force:true});}
});
