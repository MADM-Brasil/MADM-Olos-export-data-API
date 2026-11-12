import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {HttpTransport} from '../src/http.js';
import {OlosAuthManager} from '../src/auth.js';
import {OlosApi} from '../src/api.js';
import {StaticCache} from '../src/cache.js';
import {Worker} from '../src/worker.js';
import {CorporateDelivery} from '../src/corporate-delivery/delivery.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { columns, digest } from '../src/corporate-sync/mapping.js';
import { observeLogs,type LogEntry } from '../src/errors.js';
import { corporateControl } from '../src/corporate-delivery/commands.js';
import { logVerification, recoverCollision, recoveryRequest, verifyPending, type RecoveryHooks } from '../src/corporate-delivery/recovery.js';
import { adoptAllocator, adoptionRequest, reserveIds } from '../src/corporate-delivery/allocator.js';
import { legacyReversionRequest, revertAllocator, type ReversionHooks } from '../src/corporate-delivery/legacy-recovery.js';
import { lockLegacyIdSpace, nextLegacyId } from '../src/corporate-delivery/legacy-sequence.js';
import { allocatorContract } from '../src/corporate-delivery/allocator-contract.js';
import { validateReadoption,activateReadoption,readoptionStatus,abortReadoption } from '../src/corporate-delivery/readoption-activation.js';
import type { ReadoptionRequest,ReadoptionActivation,ReadoptionHooks } from '../src/corporate-delivery/readoption-contract.js';
import { prepareCorporateReadoption } from '../src/corporate-delivery/readoption.js';
import { fixture, row as corporateRow } from './corporate-sync.fixture.js';
import { fingerprint,type RecoveryManifest } from '../src/read-recovery.js';

const enabled = process.env.OLOS_DIRECT_DISPOSABLE_TEST === 'true';
const authorization = { OLOS_CORPORATE_RECOVERY_CONFIRMATION: 'AUTHORIZE_CORPORATE_COLLISION_RECOVERY' };
const quarantineAuthorization = { OLOS_CORPORATE_QUARANTINE_CONFIRMATION: 'AUTHORIZE_CORPORATE_COLLISION_QUARANTINE' };
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
test('collision recovery with disposable PostgreSQL and verified TLS', { skip: !enabled }, async t => {
  const sourceUrl = new URL(process.env.OLOS_DIRECT_TEST_SOURCE_URL!);
  const destinationUrl = new URL(process.env.OLOS_DIRECT_TEST_DESTINATION_URL!);
  assert.equal(sourceUrl.hostname, '127.0.0.1'); assert.equal(sourceUrl.pathname, '/olos_direct_test');
  assert.equal(destinationUrl.hostname, 'localhost'); assert.equal(destinationUrl.pathname, '/madm');
  const local = new pg.Client({ connectionString: sourceUrl.toString() });
  const remote = new pg.Client({ connectionString: destinationUrl.toString() });
  const pool = new pg.Pool({ connectionString: sourceUrl.toString(), max: 4, statement_timeout: 3000, lock_timeout: 1000 });
  await local.connect(); await remote.connect();
  const env = { DATABASE_URL: sourceUrl.toString(), OLOS_SOURCE_KEY: 'synthetic-recovery', SOURCE_ID_UNIQUENESS_CONFIRMED: 'true',
    ATTEMPTS_PERSISTENCE_MODE: 'corporate', OLOS_CORPORATE_DATABASE_URL: destinationUrl.toString(),
    OLOS_CORPORATE_CA_FILE: process.env.OLOS_DIRECT_TEST_CA_FILE!, OLOS_CORPORATE_RECONCILE_CONFIRMATION: 'AUTHORIZE_CORPORATE_STATE_RECONCILIATION',
    OLOS_CORPORATE_LEGACY_BINDING: 'a'.repeat(64), OLOS_CORPORATE_LEGACY_EXPECTED_COUNT: '0', OLOS_CORPORATE_BATCH_SIZE: '2',
    OLOS_CORPORATE_TIMEOUT_MS: '1000', OLOS_CORPORATE_WRITE_ENABLED: 'true', OLOS_CORPORATE_WRITE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY' };
  const cfg = config(env), dc = cfg.corporateDelivery!, source = cfg.sourceKey, target = '"raw"."olos_calls"';
  const references = { users: new Map([['7', 'Private Agent']]), campaigns: new Map([['8', 'Campaign']]), dispositions: new Map([['9', 'Disposition']]) };
  const row = (id: number, extra: Record<string, unknown> = {}) => ({ AttemptsRawDataID: String(id), CallId: `private-call-${id}`, AgentId: '7', CampaignId: '8', DispositionId: '9',
    StartDate: '2026-10-01T10:00:00.123456-03:00', OriginalPhoneNumber: `55119000${id}`, Email: 'private@example.test', ...extra });
  let store: Store | undefined;
  async function stage(id: number, extra: Record<string, unknown> = {}) {
    const read = await store!.beginRead({ kind: 'current' }); await store!.stage(read, JSON.stringify([row(id, extra)]), 1); await store!.drain(references);
  }
  async function reset(n = 5) {
    await store?.close(); store = undefined;
    await local.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE; DROP SCHEMA IF EXISTS corporate_sync CASCADE; DROP SCHEMA IF EXISTS olos_billing CASCADE');
    await remote.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS olos_delivery_ids CASCADE');
    await local.query(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8'));
    for (const name of ['001_ingestion.sql','corporate-sync/001_control.sql','002_corporate_delivery.sql','003_corporate_outbox_skipped.sql','005_corporate_campaign_policy.sql','006_corporate_collision_recovery.sql','007_corporate_collision_quarantine.sql']) {
      await local.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    await remote.query(fixture(false));
    await local.query('INSERT INTO corporate_sync.control(singleton,binding,confirmed_count) VALUES(true,$1,0)', [dc.legacyBinding]);
    store = new Store(cfg); await store.open(); await store.reconcileCorporate();
    for (let i = 1; i <= n; i++) await stage(8000 + i);
    await local.query("UPDATE olos_http.corporate_control SET blocked=true,paused=false,last_code='INTERNAL_ID_COLLISION',failure_count=1 WHERE singleton");
  }
  async function client<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect(); db.on('error', () => {}); try { return await fn(db); } finally { db.release(true); }
  }
  const verify = () => client(db => verifyPending(db, dc, source, target));
  const args = (proof: string, id = randomUUID(), evidence = 'INC-42') => ['--confirm-source', source, '--verification', proof, '--request-id', id, '--evidence', evidence];
  const recover = (input: string[], hooks: RecoveryHooks = {}) => client(db => recoverCollision(db, dc, source, target, recoveryRequest(input, authorization, source), hooks));
  const quarantine = (input: string[], hooks: RecoveryHooks = {}) => client(db => recoverCollision(db, dc, source, target, recoveryRequest(input, quarantineAuthorization, source, true), hooks, true));
  const quarantineRows = async () => (await local.query('SELECT * FROM olos_http.corporate_collision_quarantine ORDER BY target_id')).rows;
  const quarantineRuns = async () => (await local.query('SELECT * FROM olos_http.corporate_collision_quarantine_runs ORDER BY request_id')).rows;
  const control = async () => (await local.query('SELECT * FROM olos_http.corporate_control')).rows[0];
  const entries = async () => (await local.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows;
  const evidenceCount = async () => (await local.query('SELECT count(*)::int AS n FROM olos_http.corporate_collision_recoveries')).rows[0].n;
  async function snapshot() {
    return { control: await control(), quarantine: await quarantineRows(), quarantineRuns: await quarantineRuns(), allocator: (await local.query('SELECT * FROM raw.olos_calls_internal_id_olos_seq')).rows, entries: await entries(), records: (await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows,
      reads: (await local.query('SELECT * FROM olos_http.reads ORDER BY id')).rows,
      remote: (await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows,
      sequence: (await remote.query('SELECT * FROM raw.olos_calls_raw_olos_call_id_seq')).rows };
  }
  async function insertRemote(index: number, changes: Record<string, unknown> = {}) {
    const payload = { ...(await entries())[index]!.payload, ...changes };
    await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(name => payload[name]));
  }
  async function importedHistory(id: number, sourceId: string) {
    const payload={...((await entries())[0]?.payload??corporateRow(String(id))),internal_id_olos:String(id),olos_call_id:`historical-${sourceId}`,telefone:`55${String(id).padStart(11,'0')}`};
    const sourceHash=digest(payload);
    await local.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,campaign_id,disposition_id)
      VALUES($1,$2,$3,$4,$5,'7','8','9')`,[source,sourceId,target,id,sourceHash]);
    await local.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,origin)
      VALUES($1,$2,$3,$4,$5,$6,'legacy_backlog')`,[source,sourceId,id,sourceHash,payload,digest(payload)]);
    await local.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) OVERRIDING SYSTEM VALUE VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(name=>payload[name]));
    return payload;
  }
  const allocationAuthorization = { OLOS_CORPORATE_ID_ALLOCATOR_CONFIRMATION: 'AUTHORIZE_CORPORATE_ID_ALLOCATOR' };
  const allocationArgs = (request:string = randomUUID()) => ['--confirm-source', source, '--request-id', request, '--evidence', 'INC-ALLOCATOR'];
  const adopt = (input: string[], hooks = {}) => client(db => adoptAllocator(db, dc, source, target, adoptionRequest(input, allocationAuthorization, source), hooks));
  const allocatorMigration = async () => local.query(await readFile(new URL('../migrations/008_corporate_id_allocator.sql', import.meta.url), 'utf8'));
  const remoteAllocatorMigration = async () => remote.query(await readFile(new URL('../migrations/corporate/001_id_allocator.sql', import.meta.url), 'utf8'));
  const admissions = async () => (await local.query('SELECT * FROM olos_http.corporate_id_admissions ORDER BY source_id')).rows;
  const assignments = async () => (await local.query('SELECT * FROM olos_http.corporate_id_assignments ORDER BY target_id')).rows;
  async function prepare(input = allocationArgs()) {
    await allocatorMigration(); await corporateControl(cfg, 'corporate-pause');
    await corporateControl(cfg, 'corporate-prepare-id-allocator', input, allocationAuthorization);
    return input;
  }
  async function enableAllocator() {
    const input = await prepare(); await remoteAllocatorMigration(); await adopt(input); return input;
  }
  const reversionAuthorization = { OLOS_CORPORATE_LEGACY_REVERSION_CONFIRMATION: 'AUTHORIZE_CORPORATE_LEGACY_REVERSION' };
  const reversionArgs = (adoption: string[], id = randomUUID(), maxBatches?: number) => ['--confirm-source',source,'--adoption-request',adoption[3]!,
    '--request-id',id,'--evidence','INC-LEGACY',...(maxBatches ? ['--max-batches',String(maxBatches)] : [])];
  const reversalMigration = async () => local.query(await readFile(new URL('../migrations/009_corporate_allocator_reversion.sql', import.meta.url), 'utf8'));
  const revert = (input: string[], hooks: ReversionHooks = {}) => client(db => revertAllocator(db,cfg,store!.delivery!,legacyReversionRequest(input,reversionAuthorization,source),hooks));
  const reversionRuns = async () => (await local.query('SELECT * FROM olos_http.corporate_id_reversions')).rows;
  const reversionBatches = async () => (await local.query('SELECT * FROM olos_http.corporate_id_reversion_batches ORDER BY batch_no')).rows;
  async function insertForeign(id: string) {
    const payload = corporateRow(id);
    await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(name => payload[name]));
  }
  try {
    for(const mode of ['quarantined legacy queue','unmaterialized admission'] as const)await t.test(`capture recovery preserves corporate receipts and quarantine with ${mode}`,async()=>{
      await reset(mode==='quarantined legacy queue'?2:0);
      if(mode==='quarantined legacy queue'){
        await insertRemote(0,{telefone:'5511999999999'});await quarantine(args((await verify()).verification_digest));
      }else await enableAllocator();
      const queue=await entries(),quarantined=await quarantineRows(),runs=await quarantineRuns(),before=await control();
      const destination=(await remote.query('SELECT * FROM raw.olos_calls')).rows;
      const parent=await store!.beginRead({kind:'current'});await store!.markError(parent,'RESPONSE_TOO_LARGE');
      await local.query("UPDATE olos_http.reads SET started_at='2026-11-12T13:00:00Z' WHERE id=$1",[parent]);
      const manifest:RecoveryManifest={version:1,sourceKey:source,targetTable:target,parentId:parent,parentStartedAt:'2026-11-12T13:00:00.000Z',date:'2026-11-12',
        evidenceRef:'SYNTHETIC-OLOS-TICKET',evidenceSha256:fingerprint('synthetic official evidence'),remoteOperationComplete:true,rereadCursorSafe:true,exactIdsConfirmed:true,
        operation:{start:'9001',end:'9001',quantity:'1',dateRead:'2026-11-12T10:00:00.123'},ranges:[{start:'9001',end:'9001',expectedIds:['9001']}]};
      const hash=await store!.authorizeRecovery(manifest),child=await store!.beginRecoveryRead(parent,{kind:'reread',date:manifest.date,start:'9001',end:'9001'},hash);
      await store!.stage(child,JSON.stringify([row(9001)]),1);assert.equal((await store!.drain(references)).queued,1);
      assert.equal((await store!.verifyRecovery(parent)).complete,true);
      assert.deepEqual((await entries()).filter(entry=>entry.source_id!=='9001'),queue);
      assert.deepEqual(await quarantineRows(),quarantined);assert.deepEqual(await quarantineRuns(),runs);
      assert.deepEqual(await control(),before);assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls')).rows,destination);
      if(mode==='unmaterialized admission')assert.equal((await admissions()).filter(entry=>!entry.materialized).length,1);
    });
    await t.test('diagnostics identify local failure stages without changing rollback or exposing database details', async () => {
      await reset(1); const input=args((await verify()).verification_digest),before=await snapshot();
      const cases:[string,string][]=[
        ['pg_try_advisory_xact_lock_shared','local_locks'],
        ['SELECT * FROM olos_http.corporate_control','state'],
        ["to_regclass('olos_http.corporate_collision_quarantine_runs')",'quarantine'],
        ['SELECT * FROM olos_http.corporate_collision_recoveries','idempotency'],
        ['INSERT INTO olos_http.corporate_collision_recoveries','insert'],
        ['UPDATE olos_http.corporate_control SET blocked=false','update_control'],
      ];
      for(const [query,stage] of cases){
        const failure=Object.assign(new pg.DatabaseError('PRIVATE SQL payload password',0,'error'),{code:'42501',detail:'PRIVATE phone email',where:'PRIVATE query',stack:'PRIVATE stack'});
        const events:LogEntry[]=[],stop=observeLogs(entry=>{if(entry.event==='corporate_collision_recovery_failed')events.push(entry);});
        try{
          await assert.rejects(client(db=>{
            const failing=new Proxy(db,{get(connection,key){
              if(key==='query')return (sql:string,parameters?:unknown[])=>{if(sql.includes(query))throw failure;return connection.query(sql,parameters);};
              return Reflect.get(connection,key);
            }});
            return recoverCollision(failing,dc,source,target,recoveryRequest(input,authorization,source));
          }),error=>error===failure);
        }finally{stop();}
        assert.equal(events.length,1);assert.equal(events[0]!.stage,stage);assert.equal(events[0]!.category,'database');assert.equal(events[0]!.sqlstate,'42501');
        assert.deepEqual(Object.keys(events[0]!).sort(),['category','event','sqlstate','stage','table','time']);
        assert.doesNotMatch(JSON.stringify(events),/PRIVATE|payload|password|phone|email|stack|INC-42/);
        assert.deepEqual(await snapshot(),before);assert.equal(await evidenceCount(),0);
      }
    });
    await t.test('diagnostics distinguish remote lock timeout from connection and inspection failures',async()=>{
      await reset(1);const input=args((await verify()).verification_digest),before=await snapshot(),events:LogEntry[]=[];
      let lockSqlstate:string|undefined;
      const stop=observeLogs(entry=>{if(entry.event==='corporate_collision_recovery_failed')events.push(entry);});
      try{
        await remote.query('BEGIN');await remote.query('LOCK TABLE raw.olos_calls IN ACCESS EXCLUSIVE MODE');
        // The configured lock and statement deadlines are equal; either PostgreSQL cancellation may win.
        try{await assert.rejects(recover(input),error=>{
          if(!(error instanceof pg.DatabaseError)||!['55P03','57014'].includes(error.code??''))return false;
          lockSqlstate=error.code;return true;
        });}finally{await remote.query('ROLLBACK');}
        const url=dc.connection.destinationUrl;dc.connection.destinationUrl='postgresql://postgres@localhost:1/madm';
        try{await assert.rejects(recover(input));}finally{dc.connection.destinationUrl=url;}
        await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN email TYPE varchar(80)');
        await assert.rejects(recover(input),/SCHEMA_CHANGED/);
      }finally{stop();}
      assert.deepEqual(events.map(({stage,category,sqlstate})=>({stage,category,sqlstate})),[
        {stage:'remote_lock',category:'database',sqlstate:lockSqlstate},
        {stage:'remote_connection',category:'connection',sqlstate:null},
        {stage:'inspection',category:'policy',sqlstate:null},
      ]);
      assert.deepEqual(await snapshot(),before);assert.equal(await evidenceCount(),0);
    });
    await t.test('legacy recovery identifies the reversion UPDATE failure and preserves completed history without migrations 010/011',async()=>{
      await reset(1);const adoption=await prepare();await reversalMigration();await revert(reversionArgs(adoption));
      const input=args((await verify()).verification_digest),before=await snapshot(),history=await reversionRuns(),batches=await reversionBatches(),events:LogEntry[]=[];
      const failure=Object.assign(new pg.DatabaseError('PRIVATE reversion SQL credentials',0,'error'),{code:'42501',detail:'PRIVATE payload'});
      const stop=observeLogs(entry=>{if(entry.event==='corporate_collision_recovery_failed')events.push(entry);});
      try{
        await assert.rejects(client(db=>{
          const failing=new Proxy(db,{get(connection,key){
            if(key==='query')return(sql:string,parameters?:unknown[])=>{if(sql.startsWith('UPDATE olos_http.corporate_id_reversions SET validated_at'))throw failure;return connection.query(sql,parameters);};
            return Reflect.get(connection,key);
          }});
          return recoverCollision(failing,dc,source,target,recoveryRequest(input,authorization,source));
        }),error=>error===failure);
      }finally{stop();}
      assert.equal(events.length,1);assert.equal(events[0]!.stage,'update_reversion');assert.equal(events[0]!.category,'database');assert.equal(events[0]!.sqlstate,'42501');
      assert.doesNotMatch(JSON.stringify(events),/PRIVATE|credentials|payload/);
      assert.deepEqual(await snapshot(),before);assert.deepEqual(await reversionRuns(),history);assert.deepEqual(await reversionBatches(),batches);assert.equal(await evidenceCount(),0);
    });
    await t.test('read-only verification checks all pages, exact timestamps and existing rows without receipts or trigger effects', async () => {
      await reset(); await insertRemote(0);
      const before = await snapshot();
      await remote.query('ALTER DATABASE madm SET default_transaction_read_only=on');
      try {
        const result = await client(async db => {
          await db.query('SET default_transaction_read_only=on');
          return verifyPending(db, dc, source, target);
        });
        assert.equal(result.pending, 5); assert.equal(result.existing, 1); assert.equal(result.eligible, 5); assert.deepEqual(result.issues, []);
        assert.equal((await verify()).verification_digest, result.verification_digest);
      } finally { await remote.query('ALTER DATABASE madm RESET default_transaction_read_only'); }
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
    });
    await t.test('diagnosis reports identity collision beyond first batch and never logs personal values', async () => {
      await reset(); await insertRemote(4, { telefone: 'private-collision-phone', nome_agente: 'private-other-name' });
      const before = await snapshot(), result = await verify();
      assert.equal(result.issues[0]!.target_id, '5'); assert.equal(result.issues[0]!.code, 'INTERNAL_ID_COLLISION');
      assert.deepEqual(result.issues[0]!.fields, ['telefone','nome_agente']);
      let output = ''; const stop = observeLogs(entry => { output += JSON.stringify(entry); });
      try { logVerification(result); } finally { stop(); }
      assert.doesNotMatch(output, /private-|Private Agent|55119000|@|2026-10-01/);
      await assert.rejects(recover(args(result.verification_digest)), /CORPORATE_PENDING_DIVERGES/);
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
      await assert.rejects(corporateControl(cfg, 'corporate-verify-pending'), /CORPORATE_PENDING_DIVERGES/);
      await assert.rejects(corporateControl(cfg, 'corporate-resume'), /CORPORATE_DELIVERY_BLOCKED/);
    });
    await t.test('non-identity divergence, logical match at different/null ID and malformed remote values all prevent release', async () => {
      for (const [change, code, field] of [
        [{ nome_agente: 'other' }, 'EXISTING_CALL_DIVERGES', 'nome_agente'],
        [{ internal_id_olos: '999' }, 'LOGICAL_CALL_AT_DIFFERENT_ID', 'internal_id_olos'],
        [{ internal_id_olos: null }, 'LOGICAL_CALL_AT_DIFFERENT_ID', 'internal_id_olos'],
        [{ nome_agente: null }, 'EXISTING_CALL_DIVERGES', 'nome_agente'],
      ] as const) {
        await reset(1); await insertRemote(0, change);
        const result = await verify(); assert.equal(result.issues[0]!.code, code); assert(result.issues[0]!.fields.includes(field));
        await assert.rejects(recover(args(result.verification_digest)), /PENDING_DIVERGES/); assert.equal(await evidenceCount(), 0);
      }
    });
    await t.test('frozen hash, normalization and record mapping divergences prevent release', async () => {
      for (const [sql, code, field] of [
        ["UPDATE olos_http.corporate_outbox SET payload_hash=repeat('a',64)", 'CORPORATE_PAYLOAD_CHANGED', 'payload_hash'],
        ["UPDATE olos_http.corporate_outbox SET payload=jsonb_set(payload,'{data_ligacao}','\"bad\"')", 'TIMESTAMP_INVALID', 'data_ligacao'],
        ["UPDATE olos_http.records SET source_hash='other'", 'CORPORATE_RECORD_MAPPING_CHANGED', 'source_hash'],
      ]) {
        await reset(1); await local.query(sql!); const result = await verify();
        assert.equal(result.issues[0]!.code, code); assert(result.issues[0]!.fields.includes(field!));
        await assert.rejects(recover(args(result.verification_digest)), /PENDING_DIVERGES/); assert.equal((await control()).blocked, true);
      }
    });
    await t.test('duplicate logical identities across pages and policy-ineligible pending rows are still verified', async () => {
      await reset();
      const all = await entries(), payload = { ...all[0]!.payload, internal_id_olos: '5' };
      await local.query('UPDATE olos_http.corporate_outbox SET payload=$1,payload_hash=$2 WHERE target_id=5', [payload, digest(payload)]);
      const result = await verify(); assert(result.issues.some(issue => issue.code === 'DUPLICATE_LOGICAL_IDENTITY' && issue.target_id === '5'));
      await reset(0); await stage(8900, { AgentId: null });
      // Captured operatorless rows are normally skipped; a preserved pending row is audited as well.
      await local.query("UPDATE olos_http.corporate_outbox SET state='pending'"); await insertRemote(0, { telefone: 'diverges' });
      const excluded = await verify(); assert.equal(excluded.pending, 1); assert.equal(excluded.eligible, 0); assert.equal(excluded.issues[0]!.code, 'INTERNAL_ID_COLLISION');
    });
    await t.test('successful release is atomic with evidence, keeps delivery paused and preserves all call data', async () => {
      await reset(); await insertRemote(0); const before = await snapshot(), report = await verify();
      const input = args(report.verification_digest);
      await corporateControl(cfg, 'corporate-recover-collision', input, authorization);
      const after = await snapshot(); assert.deepEqual(after.entries, before.entries); assert.deepEqual(after.records, before.records);
      assert.deepEqual(after.reads, before.reads); assert.deepEqual(after.remote, before.remote); assert.deepEqual(after.sequence, before.sequence);
      assert.equal(after.control.blocked, false); assert.equal(after.control.paused, true); assert.equal(after.control.last_code, null);
      const receipt = (await local.query('SELECT * FROM olos_http.corporate_collision_recoveries')).rows[0];
      assert.equal(receipt.verification_digest, report.verification_digest); assert.equal(receipt.previous_code, 'INTERNAL_ID_COLLISION'); assert.equal(receipt.pending_count, '5');
      assert.equal(receipt.existing_count, '1'); assert.equal(await evidenceCount(), 1);
      assert.deepEqual(await recover(input), { alreadyApplied: true }); assert.deepEqual(await snapshot(), after);
      await assert.rejects(recover(input.map((v, i) => i === 7 ? 'INC-OTHER' : v)), /REQUEST_REUSED/);
      await corporateControl(cfg, 'corporate-resume'); await store!.delivery!.tick(); await store!.delivery!.tick(); await store!.delivery!.tick();
      assert.equal((await entries()).filter(e => e.state === 'pending').length, 0);
      assert.equal((await remote.query('SELECT count(*)::int AS n FROM raw.olos_calls')).rows[0].n, 5);
    });
    await t.test('concurrent repetition produces one evidence record; another request cannot clear a later block', async () => {
      await reset(); const input = args((await verify()).verification_digest);
      const results = await Promise.all([recover(input), recover(input)]);
      assert.equal(results.filter(r => !r.alreadyApplied).length, 1); assert.equal(await evidenceCount(), 1);
      await local.query("UPDATE olos_http.corporate_control SET blocked=true,last_code='EXISTING_CALL_DIVERGES'");
      assert.equal((await recover(input)).alreadyApplied, true); assert.equal((await control()).blocked, true);
      await assert.rejects(recover(args((await verify()).verification_digest)), /BLOCK_MISMATCH/);
    });
    await t.test('new capture or changed remote contents after diagnosis invalidate the proof', async () => {
      await reset(); let report = await verify(); await stage(8999);
      await assert.rejects(recover(args(report.verification_digest)), /VERIFICATION_STALE/); assert.equal(await evidenceCount(), 0);
      report = await verify(); await insertRemote(0);
      await assert.rejects(recover(args(report.verification_digest)), /VERIFICATION_STALE/); assert.equal((await control()).blocked, true);
    });
    await t.test('schema drift, wrong binding and unavailable remote cannot authorize recovery', async () => {
      await reset(); const report = await verify(); await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN email TYPE varchar(80)');
      await assert.rejects(verify(), /SCHEMA_CHANGED/); await assert.rejects(recover(args(report.verification_digest)), /SCHEMA_CHANGED/);
      await reset(); const url = dc.connection.destinationUrl; dc.connection.destinationUrl = 'postgresql://postgres@localhost:1/madm';
      try { await assert.rejects(verify()); await assert.rejects(recover(args(report.verification_digest))); } finally { dc.connection.destinationUrl = url; }
      await local.query("UPDATE olos_http.corporate_control SET binding=repeat('b',64)");
      await assert.rejects(verify(), /BINDING_CHANGED/); assert.equal(await evidenceCount(), 0);
    });
    await t.test('failures before commit and unavailable evidence table roll back the control update', async () => {
      await reset(); const input = args((await verify()).verification_digest), before = await snapshot();
      await assert.rejects(recover(input, { beforeLocalCommit: async () => { throw new Error('synthetic failure'); } }), /synthetic failure/);
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
      await local.query('DROP TABLE olos_http.corporate_collision_recoveries');
      await assert.rejects(recover(input)); assert.deepEqual(await snapshot(), before);
    });
    await t.test('uncertain local COMMIT is reconciled by the same request without repeating the release', async () => {
      await reset(1); const input = args((await verify()).verification_digest);
      const events:LogEntry[]=[],stop=observeLogs(entry=>{if(entry.event==='corporate_collision_recovery_failed')events.push(entry);});
      try{await assert.rejects(client(async db => {
        const ambiguous = new Proxy(db, { get(connection, key) {
          if (key === 'query') return async (sql: string, parameters?: unknown[]) => {
            const result = await connection.query(sql, parameters);
            if (sql === 'COMMIT') throw new Error('synthetic lost commit acknowledgement');
            return result;
          };
          return Reflect.get(connection, key);
        } });
        return recoverCollision(ambiguous, dc, source, target, recoveryRequest(input, authorization, source));
      }), /RECOVERY_COMMIT_UNKNOWN/);}finally{stop();}
      assert.equal(events.length,1);assert.equal(events[0]!.stage,'commit');assert.equal(events[0]!.category,'runtime');assert.equal(events[0]!.sqlstate,null);
      assert.doesNotMatch(JSON.stringify(events),/synthetic lost commit acknowledgement/);
      assert.equal(await evidenceCount(), 1); assert.equal((await control()).blocked, false);
      assert.deepEqual(await recover(input), { alreadyApplied: true });
    });
    await t.test('loss of either database session before commit preserves the block and rolls back evidence', async () => {
      await reset(1); const input = args((await verify()).verification_digest), before = await snapshot();
      await assert.rejects(recover(input, { afterLocks: async () => {
        await remote.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='madm' AND application_name='corporate-sync' AND state='idle in transaction'");
      } }));
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
      await assert.rejects(client(async db => {
        const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return recoverCollision(db, dc, source, target, recoveryRequest(input, authorization, source), { beforeLocalCommit: async () => {
          await local.query('SELECT pg_terminate_backend($1)', [pid]);
        } });
      }));
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
    });
    await t.test('homologation exclusion and unrelated block codes cannot be bypassed', async () => {
      await reset(1); const input = args((await verify()).verification_digest);
      await client(async db => {
        await db.query('SELECT pg_advisory_lock(17320914,4)');
        await assert.rejects(recover(input), /HOMOLOGATION_ACTIVE/);
      });
      for (const code of ['EXISTING_CALL_DIVERGES','CORPORATE_SCHEMA_CHANGED','CORPORATE_COMMIT_UNKNOWN']) {
        await local.query('UPDATE olos_http.corporate_control SET last_code=$1', [code]);
        await assert.rejects(recover(input), /BLOCK_MISMATCH/);
      }
      assert.equal((await control()).blocked, true); assert.equal(await evidenceCount(), 0);
    });
    await t.test('recovery excludes remote writers, new admission, resume and delivery until it finishes', async () => {
      await reset(1); const input = args((await verify()).verification_digest);
      let locked!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const recovering = recover(input, { afterLocks: async () => { locked(); await gate; } });
      await entered;
      let captured = false, resumed = false, written = false, delivered = false;
      const capturing = stage(8999).then(() => { captured = true; });
      const resuming = corporateControl(cfg, 'corporate-resume').then(() => { resumed = true; });
      const writing = remote.query('UPDATE raw.olos_calls SET email=email').then(() => { written = true; });
      const delivering = store!.delivery!.tick().then(() => { delivered = true; });
      try { await pause(50); assert.equal(captured, false); assert.equal(resumed, false); assert.equal(written, false); assert.equal(delivered, false); }
      finally { release(); }
      await recovering; await Promise.all([capturing, resuming, writing, delivering]); assert.equal(await evidenceCount(), 1);
    });
    await t.test('remote lock timeout rolls back and the read-only CLI does not require the audit migration', async () => {
      await reset(1); const input = args((await verify()).verification_digest), before = await snapshot();
      await remote.query('BEGIN'); await remote.query('LOCK TABLE raw.olos_calls IN ROW EXCLUSIVE MODE');
      try { await assert.rejects(recover(input)); } finally { await remote.query('ROLLBACK'); }
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
      await local.query('DROP TABLE olos_http.corporate_collision_recoveries');
      const { stdout } = await promisify(execFile)(process.execPath, ['dist/main.js', 'corporate-verify-pending'], { env, timeout: 15000 });
      assert.match(stdout, /"valid":true/); assert.match(stdout, /"pending":1/);
    });
    await t.test('selective isolation preserves confirmed rows and frozen records, then delivers only the valid remainder', async () => {
      await reset(2);
      await local.query('UPDATE olos_http.corporate_control SET blocked=false,paused=false'); await store!.delivery!.tick();
      for (const id of [8101,8102,8103,8104,8105]) await stage(id);
      await local.query("UPDATE olos_http.corporate_control SET blocked=true,last_code='INTERNAL_ID_COLLISION'");
      await insertRemote(2); await insertRemote(3, { telefone: 'collision-one' }); await insertRemote(6, { telefone: 'collision-two' });
      await remote.query("UPDATE raw.olos_calls SET kommo_status_processamento='KEEP' ");
      const before = await snapshot(); const report = await verify(); assert.equal(report.pending, 5); assert.equal(report.issues.length, 2);
      const input = args(report.verification_digest);
      let output = ''; const stop = observeLogs(entry => { output += JSON.stringify(entry); });
      try { await corporateControl(cfg, 'corporate-quarantine-collisions', input, quarantineAuthorization); } finally { stop(); }
      assert.doesNotMatch(output, /collision-one|collision-two|private-|Private Agent|55119000|@|2026-10-01/);
      const isolated = await snapshot();
      for (const key of ['entries','records','reads','remote','sequence','allocator'] as const) assert.deepEqual(isolated[key], before[key], key);
      assert.equal(isolated.control.blocked, true); assert.equal(isolated.control.confirmed_count, '2');
      assert.deepEqual(isolated.quarantine.map(q => q.target_id), [4,7]); assert.equal(isolated.quarantineRuns.length, 1);
      assert.equal(isolated.quarantineRuns[0].member_count, 2); assert.equal(await evidenceCount(), 0);
      const rest = await verify(); assert.equal(rest.pending, 5); assert.equal(rest.quarantined, 2); assert.equal(rest.eligible, 3); assert.equal(rest.existing, 1); assert.deepEqual(rest.issues, []);
      const releaseInput = args(rest.verification_digest); await recover(releaseInput);
      assert.equal((await control()).paused, true); assert.deepEqual((await snapshot()).entries, before.entries);
      await corporateControl(cfg, 'corporate-resume'); await store!.delivery!.tick(); await store!.delivery!.tick(); await store!.delivery!.tick();
      const after = await snapshot();
      for (const q of after.quarantine) {
        const original = before.entries.find(e => e.target_id === q.target_id), current = after.entries.find(e => e.target_id === q.target_id);
        assert.deepEqual(current, original); assert.equal(current.state, 'pending'); assert.equal(current.remote_raw_id, null);
      }
      assert.equal(after.control.confirmed_count, '5'); assert.equal(after.entries.filter(e => e.state === 'pending').length, 2);
      for (const existing of before.remote) assert.deepEqual(after.remote.find(r => r.raw_olos_call_id === existing.raw_olos_call_id), existing);
      assert.deepEqual(after.records, before.records); assert.deepEqual(after.allocator, before.allocator);
      assert.deepEqual(await quarantine(input), { alreadyApplied: true }); assert.deepEqual(await snapshot(), after);
      assert.deepEqual(await recover(releaseInput), { alreadyApplied: true });
      const status = await store!.delivery!.status(store!.client!); assert.equal(status.pending, 2); assert.equal(status.quarantined, 2);
    });
    await t.test('quarantine admits only confirmed collisions; other integrity failures stay visible and block release', async () => {
      await reset(4); await insertRemote(0, { telefone: 'collision' }); await insertRemote(1, { nome_agente: 'divergence' });
      await insertRemote(2, { internal_id_olos: '900' }); await local.query("UPDATE olos_http.records SET source_hash='changed' WHERE target_id=4");
      const report = await verify(); await quarantine(args(report.verification_digest));
      assert.deepEqual((await quarantineRows()).map(q => q.target_id), [1]);
      const rest = await verify(); assert.equal(rest.quarantined, 1);
      assert.deepEqual(rest.issues.map(i => i.code).sort(), ['CORPORATE_RECORD_MAPPING_CHANGED','EXISTING_CALL_DIVERGES','LOGICAL_CALL_AT_DIFFERENT_ID'].sort());
      await assert.rejects(recover(args(rest.verification_digest)), /PENDING_DIVERGES/); assert.equal((await control()).blocked, true);
      const before = await snapshot(); await assert.rejects(quarantine(args(rest.verification_digest)), /NO_CONFIRMED_COLLISIONS/); assert.deepEqual(await snapshot(), before);
      // A row with both a collision and a broken local mapping cannot be classified as trustworthy.
      await reset(1); await insertRemote(0, { telefone: 'collision' }); await local.query("UPDATE olos_http.records SET source_hash='changed'");
      await assert.rejects(quarantine(args((await verify()).verification_digest)), /NO_CONFIRMED_COLLISIONS/); assert.equal((await quarantineRows()).length, 0);
    });
    await t.test('quarantine cannot bypass operator/campaign filters or silently quarantine a content-only difference', async () => {
      await reset(2); await stage(8991, { AgentId: null }); await stage(8992, { CampaignId: '999' });
      await local.query("UPDATE olos_http.corporate_outbox SET state='pending' WHERE target_id=3");
      await insertRemote(0, { telefone: 'collision' });
      await quarantine(args((await verify()).verification_digest)); const rest = await verify();
      assert.equal(rest.pending, 4); assert.equal(rest.quarantined, 1); assert.equal(rest.eligible, 1); assert.deepEqual(rest.issues, []);
      await recover(args(rest.verification_digest)); await corporateControl(cfg, 'corporate-resume'); await store!.delivery!.tick();
      assert.deepEqual((await entries()).map(e => e.state), ['pending','confirmed','pending','pending']);
      assert.deepEqual((await quarantineRows()).map(q => q.target_id), [1]);
    });
    await t.test('new collisions after selective release still block the whole attempted batch without remote overwrites', async () => {
      await reset(3); await insertRemote(0, { telefone: 'first-collision' });
      await quarantine(args((await verify()).verification_digest)); await recover(args((await verify()).verification_digest));
      await corporateControl(cfg, 'corporate-resume'); await insertRemote(1, { telefone: 'new-collision' });
      const before = await snapshot(); await store!.delivery!.tick();
      assert.equal((await control()).blocked, true); assert.equal((await control()).last_code, 'INTERNAL_ID_COLLISION');
      assert.deepEqual((await snapshot()).remote, before.remote); assert.deepEqual(await entries(), before.entries);
      assert.equal((await quarantineRows()).length, 1); await assert.rejects(corporateControl(cfg, 'corporate-resume'), /DELIVERY_BLOCKED/);
      await stage(8999); assert.equal((await verify()).pending, 4);
      await quarantine(args((await verify()).verification_digest)); assert.deepEqual((await quarantineRows()).map(q => q.target_id), [1,2]);
      await recover(args((await verify()).verification_digest)); await corporateControl(cfg, 'corporate-resume'); await store!.delivery!.tick();
      assert.deepEqual((await entries()).map(e => e.state), ['pending','pending','confirmed','confirmed']);
    });
    await t.test('quarantine rollback includes all members, evidence and generation', async () => {
      await reset(4); await insertRemote(0, { telefone: 'a' }); await insertRemote(3, { telefone: 'b' });
      const input = args((await verify()).verification_digest), before = await snapshot();
      await assert.rejects(quarantine(input, { beforeLocalCommit: async () => { throw new Error('synthetic rollback'); } }), /synthetic rollback/);
      assert.deepEqual(await snapshot(), before); assert.equal(await evidenceCount(), 0);
      await quarantine(input); assert.equal((await quarantineRows()).length, 2);
    });
    await t.test('concurrent identical quarantine is idempotent; changed approval or stale proof cannot add members', async () => {
      await reset(3); await insertRemote(0, { telefone: 'a' }); const input = args((await verify()).verification_digest);
      const results = await Promise.all([quarantine(input), quarantine(input)]);
      assert.equal(results.filter(r => !r.alreadyApplied).length, 1); assert.equal((await quarantineRuns()).length, 1); assert.equal((await quarantineRows()).length, 1);
      await assert.rejects(quarantine(input.map((v, i) => i === 7 ? 'INC-OTHER' : v)), /REQUEST_REUSED/);
      await assert.rejects(quarantine(input.map((v, i) => i === 5 ? randomUUID() : v)), /VERIFICATION_STALE/);
      const current = await verify(); await stage(8999);
      await assert.rejects(quarantine(args(current.verification_digest)), /VERIFICATION_STALE/); assert.equal((await quarantineRows()).length, 1);
    });
    await t.test('quarantine ledger is immutable and pinned outbox/mapping changes block release and delivery', async () => {
      await reset(2); await insertRemote(0, { telefone: 'a' }); await quarantine(args((await verify()).verification_digest));
      for (const table of ['corporate_collision_quarantine','corporate_collision_quarantine_runs']) {
        for (const sql of [`UPDATE olos_http.${table} SET source_key=source_key`, `DELETE FROM olos_http.${table}`, `TRUNCATE olos_http.${table} CASCADE`]) {
          await assert.rejects(local.query(sql), /CORPORATE_QUARANTINE_IMMUTABLE/);
        }
      }
      const report = await verify(); await local.query("UPDATE olos_http.corporate_outbox SET payload_hash=repeat('a',64) WHERE target_id=1");
      await assert.rejects(verify(), /QUARANTINE_CHANGED/); await assert.rejects(recover(args(report.verification_digest)), /QUARANTINE_CHANGED/);
      await local.query('UPDATE olos_http.corporate_control SET blocked=false,paused=false'); const before = await snapshot(); await store!.delivery!.tick();
      assert.equal((await control()).blocked, true); assert.equal((await control()).last_code, 'CORPORATE_QUARANTINE_CHANGED'); assert.deepEqual((await snapshot()).remote, before.remote);
      await stage(8999); assert.equal((await entries()).length, 3);
    });
    await t.test('quarantine excludes concurrent remote writes, captures, resume and delivery until commit', async () => {
      await reset(2); await insertRemote(0, { telefone: 'a' }); const input = args((await verify()).verification_digest);
      let locked!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const operation = quarantine(input, { afterLocks: async () => { locked(); await gate; } }); await entered;
      let captured = false, written = false, delivered = false;
      const capturing = stage(8999).then(() => { captured = true; });
      const resuming = assert.rejects(corporateControl(cfg, 'corporate-resume'), /DELIVERY_BLOCKED/);
      const writing = remote.query('UPDATE raw.olos_calls SET email=email').then(() => { written = true; });
      const delivering = store!.delivery!.tick().then(() => { delivered = true; });
      try { await pause(50); assert.equal(captured, false); assert.equal(written, false); assert.equal(delivered, false); } finally { release(); }
      await operation; await Promise.all([capturing, resuming, writing, delivering]);
      assert.equal((await quarantineRows()).length, 1); assert.equal((await verify()).pending, 3); assert.equal((await control()).blocked, true);
    });
    await t.test('uncertain quarantine commit is reconciled by the original request without releasing delivery', async () => {
      await reset(2); await insertRemote(0, { telefone: 'a' }); const input = args((await verify()).verification_digest);
      await assert.rejects(client(db => {
        const ambiguous = new Proxy(db, { get(connection, key) {
          if (key === 'query') return async (sql: string, parameters?: unknown[]) => {
            const result = await connection.query(sql, parameters); if (sql === 'COMMIT') throw new Error('synthetic lost acknowledgement'); return result;
          };
          return Reflect.get(connection, key);
        } });
        return recoverCollision(ambiguous, dc, source, target, recoveryRequest(input, quarantineAuthorization, source, true), {}, true);
      }), /QUARANTINE_COMMIT_UNKNOWN/);
      assert.equal((await quarantineRows()).length, 1); assert.equal((await control()).blocked, true);
      const before = await snapshot(); assert.deepEqual(await quarantine(input), { alreadyApplied: true }); assert.deepEqual(await snapshot(), before);
    });
    await t.test('quarantine migration is idempotent and absence fails closed without stopping capture', async () => {
      await reset(2); await insertRemote(0, { telefone: 'a' }); await quarantine(args((await verify()).verification_digest)); const before = await snapshot();
      await local.query(await readFile(new URL('../migrations/007_corporate_collision_quarantine.sql', import.meta.url), 'utf8')); assert.deepEqual(await snapshot(), before);
      await local.query('DROP TABLE olos_http.corporate_collision_quarantine');
      await assert.rejects(verify(), /QUARANTINE_MIGRATION_REQUIRED/);
      await local.query('UPDATE olos_http.corporate_control SET blocked=false,paused=false'); await store!.delivery!.tick();
      assert.equal((await control()).last_code, 'CORPORATE_QUARANTINE_MIGRATION_REQUIRED'); assert.equal((await control()).blocked, true);
      await stage(8999); assert.equal((await entries()).length, 3);
    });
    await t.test('authoritative adoption preserves legacy/quarantine IDs and stops consuming the local sequence', async () => {
      await reset(2); await insertRemote(0, { telefone: 'legacy-collision' });
      await quarantine(args((await verify()).verification_digest)); const before = await snapshot();
      const input = await prepare(); await insertForeign('3'); await remoteAllocatorMigration(); await adopt(input);
      const adopted = await snapshot();
      for (const key of ['entries','records','reads','allocator','remote','sequence','quarantine','quarantineRuns'] as const) {
        if (key !== 'remote' && key !== 'sequence') assert.deepEqual(adopted[key], before[key], key);
      }
      const legacyAssignments = await assignments(); assert.deepEqual(legacyAssignments.map(a => a.target_id), [1,2]);
      assert.equal(legacyAssignments[0].token, null); assert(legacyAssignments[1].token);
      await stage(8901); await stage(8902); assert.equal((await admissions()).length, 2);
      assert.equal((await entries()).length, 2); assert.deepEqual((await snapshot()).allocator, before.allocator);
      await recover(args((await verify()).verification_digest)); await corporateControl(cfg, 'corporate-resume');
      await store!.delivery!.tick(); await store!.delivery!.tick();
      const all = await entries(); assert.deepEqual(all.map(e => e.target_id), [1,2,4,5]);
      assert.deepEqual(all[0], before.entries[0]); assert.equal(all.filter(e => e.state === 'confirmed').length, 3);
      assert.equal((await control()).blocked, false); assert.deepEqual((await snapshot()).allocator, before.allocator);
      const oldState = await assignments(); await adopt(input); assert.deepEqual(await assignments(), oldState);
      await assert.rejects(adopt(allocationArgs()), /REQUEST_REUSED/);
    });
    await t.test('migration 010 registra readoção sem alterar a reversão', async () => {
      await reset(0);

      const adoption = await prepare();
      await reversalMigration();
      await revert(reversionArgs(adoption));

      const previous = (await reversionRuns())[0]!;
      const before = await snapshot();

      const migration = await readFile(
        new URL('../migrations/010_corporate_allocator_readoption.sql', import.meta.url),
        'utf8'
      );

      await local.query(migration);

      const requestId = randomUUID();

      const insert = async (
        id: string,
        state: string,
        validatedAt: string | null = null,
        digest: string | null = null
      ): Promise<void> => {
        await local.query(
          `INSERT INTO olos_http.corporate_allocator_readoptions
           (request_id, source_key, previous_reversion_id,
            binding, target_table, evidence_ref,
            state, validated_at, validation_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id, source, previous.request_id, dc.binding,
            target, 'TEST-READOPTION', state, validatedAt, digest
          ]
        );
      };

      await insert(requestId, 'prepared');

      await assert.rejects(
        insert(randomUUID(), 'prepared'),
        { code: '23505' }
      );

      await assert.rejects(
        insert(randomUUID(), 'ready'),
        { code: '23514' }
      );

      await local.query(
        `UPDATE olos_http.corporate_allocator_readoptions
         SET state='ready',
             validated_at=clock_timestamp(),
             validation_digest=$2
         WHERE request_id=$1`,
        [requestId, 'a'.repeat(64)]
      );

      const result = await local.query(
        `SELECT state, validation_digest
         FROM olos_http.corporate_allocator_readoptions
         WHERE request_id=$1`,
        [requestId]
      );

      assert.equal(result.rows[0]!.state, 'ready');
      assert.equal(result.rows[0]!.validation_digest, 'a'.repeat(64));

      assert.deepEqual(await snapshot(), before);
      assert.equal((await reversionRuns())[0]!.state, 'completed');
    });

    await t.test('preparacao rejeita estados operacionais inseguros', async () => {
      await reset(0);

      const adoption = await prepare();
      await reversalMigration();
      await revert(reversionArgs(adoption));

      const migration = await readFile(
        new URL('../migrations/010_corporate_allocator_readoption.sql', import.meta.url),
        'utf8'
      );
      await local.query(migration);

      const request = {
        source,
        requestId: randomUUID(),
        evidence: 'TEST-STATE-GUARD'
      } as const;

      const execute = () => client(db =>
        prepareCorporateReadoption(db, request, dc.binding, target, dc)
      );

      await assert.rejects(
        execute,
        /READOPTION_REVERSAL_UNVERIFIED/
      );

      await local.query(
        `UPDATE olos_http.corporate_id_reversions
         SET validated_at=clock_timestamp(),
             validation_digest=$1
         WHERE source_key=$2`,
        ['a'.repeat(64), source]
      );

      await local.query(
        `UPDATE olos_http.corporate_control
         SET paused=false WHERE singleton`
      );

      await assert.rejects(
        execute,
        /READOPTION_CONTROL_INVALID/
      );

      await local.query(
        `UPDATE olos_http.corporate_control
         SET paused=true WHERE singleton`
      );

      await assert.rejects(
        () => client(db => prepareCorporateReadoption(
          db,
          { ...request, requestId: 'invalid-uuid' },
          dc.binding,
          target, dc
        )),
        /READOPTION_REQUEST_INVALID/
      );

      const result = await local.query(
        `SELECT count(*)::integer AS total
         FROM olos_http.corporate_allocator_readoptions`
      );

      assert.equal(result.rows[0]!.total, 0);
      assert.equal(
        (await local.query(
          `SELECT state
           FROM olos_http.corporate_id_allocator
           WHERE source_key=$1`,
          [source]
        )).rows[0]!.state,
        'legacy'
      );
    });

    await t.test('readoção rejeita quarentena adulterada sem persistir solicitação', async () => {
      await reset(2);
      await insertRemote(0, { telefone: 'legacy-collision' });
      await quarantine(args((await verify()).verification_digest));

      const adoption = await prepare();
      await reversalMigration();
      await revert(reversionArgs(adoption));

      const verification = await verify();
      assert.equal(verification.issues.length, 0);
      await recover(args(verification.verification_digest));

      const migration = await readFile(
        new URL('../migrations/010_corporate_allocator_readoption.sql', import.meta.url),
        'utf8'
      );
      await local.query(migration);

      const original = await local.query(
        `SELECT payload_hash
         FROM olos_http.corporate_outbox
         WHERE source_key=$1 AND target_id=1`,
        [source]
      );

      assert.equal(original.rowCount, 1);

      // Alteração exclusivamente no PostgreSQL descartável.
      await local.query(
        `UPDATE olos_http.corporate_outbox
         SET payload_hash=$1
         WHERE source_key=$2 AND target_id=1`,
        ['f'.repeat(64), source]
      );

      try {
        await assert.rejects(
          () => client(db => prepareCorporateReadoption(
            db,
            {
              source,
              requestId: randomUUID(),
              evidence: 'TEST-TAMPERED-QUARANTINE'
            },
            dc.binding,
            target,
            dc
          )),
          /CORPORATE_QUARANTINE_CHANGED/
        );

        const count = await local.query<{ total: number }>(
          `SELECT count(*)::integer AS total
           FROM olos_http.corporate_allocator_readoptions`
        );

        assert.equal(count.rows[0]!.total, 0);
      } finally {
        await local.query(
          `UPDATE olos_http.corporate_outbox
           SET payload_hash=$1
           WHERE source_key=$2 AND target_id=1`,
          [original.rows[0]!.payload_hash, source]
        );
      }
    });

    await t.test('COMMIT incerto recupera a mesma solicitação sem duplicar', async () => {
      await reset(0);

      const adoption = await prepare();
      await reversalMigration();
      await revert(reversionArgs(adoption));

      const verification = await verify();
      assert.equal(verification.issues.length, 0);
      await recover(args(verification.verification_digest));

      const migration = await readFile(
        new URL('../migrations/010_corporate_allocator_readoption.sql', import.meta.url),
        'utf8'
      );
      await local.query(migration);

      const request = {
        source,
        requestId: randomUUID(),
        evidence: 'TEST-COMMIT-UNKNOWN'
      } as const;

      await assert.rejects(
        () => client(async db => {
          const uncertain = new Proxy(db, {
            get(target, key, receiver) {
              if (key === 'query') {
                return async (
                  sql: string,
                  params?: unknown[]
                ) => {
                  const result = await target.query(sql, params);

                  if (sql === 'COMMIT') {
                    throw new Error('synthetic lost acknowledgement');
                  }

                  return result;
                };
              }

              return Reflect.get(target, key, receiver);
            }
          });

          return prepareCorporateReadoption(
            uncertain,
            request,
            dc.binding,
            target,
            dc
          );
        }),
        /READOPTION_COMMIT_UNKNOWN/
      );

      const saved = await local.query<{
        request_id: string;
        state: string;
      }>(
        `SELECT request_id, state
         FROM olos_http.corporate_allocator_readoptions
         WHERE source_key=$1`,
        [source]
      );

      assert.equal(saved.rowCount, 1);
      assert.equal(saved.rows[0]!.request_id, request.requestId);
      assert.equal(saved.rows[0]!.state, 'prepared');

      const recovered = await client(db =>
        prepareCorporateReadoption(
          db,
          request,
          dc.binding,
          target,
          dc
        )
      );

      assert.deepEqual(recovered, {
        requestId: request.requestId,
        alreadyApplied: true
      });

      const count = await local.query<{ total: number }>(
        `SELECT count(*)::integer AS total
         FROM olos_http.corporate_allocator_readoptions
         WHERE source_key=$1`,
        [source]
      );

      assert.equal(count.rows[0]!.total, 1);
    });

    await t.test('preparacao de readoção é idempotente e preserva a reversão', async () => {
      await reset(2);
      await insertRemote(0, { telefone: 'legacy-collision' });
      await quarantine(args((await verify()).verification_digest));

      const adoption = await prepare();
      await reversalMigration();
      await revert(reversionArgs(adoption));

      const verification = await verify();
      assert.equal(verification.issues.length, 0);
      await recover(args(verification.verification_digest));

      const migration = await readFile(
        new URL('../migrations/010_corporate_allocator_readoption.sql', import.meta.url),
        'utf8'
      );
      await local.query(migration);

      const beforeEntries = await entries();
      const beforeQuarantine = await quarantineRows();
      const beforeReversions = await reversionRuns();

      const request = {
        source,
        requestId: randomUUID(),
        evidence: 'TEST-READOPTION'
      } as const;

      const first = await client(db =>
        prepareCorporateReadoption(db, request, dc.binding, target, dc)
      );

      assert.deepEqual(first, {
        requestId: request.requestId,
        alreadyApplied: false
      });

      // A different session holds the exclusive homologation lock.
      // Preparation must fail without altering the persisted request.
      await local.query(
        'SELECT pg_advisory_lock(17320914,4)'
      );

      try {
        await assert.rejects(
          () => client(db =>
            prepareCorporateReadoption(db, request, dc.binding, target, dc)
          ),
          /READOPTION_HOMOLOGATION_ACTIVE/
        );
      } finally {
        await local.query(
          'SELECT pg_advisory_unlock(17320914,4)'
        );
      }

      const repeated = await client(db =>
        prepareCorporateReadoption(db, request, dc.binding, target, dc)
      );

      assert.deepEqual(repeated, {
        requestId: request.requestId,
        alreadyApplied: true
      });

      await assert.rejects(
        () => client(db =>
          prepareCorporateReadoption(
            db,
            { ...request, requestId: randomUUID() },
            dc.binding,
            target, dc
          )
        ),
        /READOPTION_REQUEST_CONFLICT/
      );

      const saved = await local.query(
        `SELECT request_id, state, previous_reversion_id
         FROM olos_http.corporate_allocator_readoptions
         WHERE source_key=$1`,
        [source]
      );

      assert.equal(saved.rowCount, 1);
      assert.equal(saved.rows[0]!.request_id, request.requestId);
      assert.equal(saved.rows[0]!.state, 'prepared');
      assert.equal(
        saved.rows[0]!.previous_reversion_id,
        beforeReversions[0]!.request_id
      );

      assert.deepEqual(await entries(), beforeEntries);
      assert.deepEqual(await quarantineRows(), beforeQuarantine);
      assert.deepEqual(await reversionRuns(), beforeReversions);

      const allocator = await local.query(
        `SELECT state FROM olos_http.corporate_id_allocator
         WHERE source_key=$1`,
        [source]
      );
      assert.equal(allocator.rows[0]!.state, 'legacy');
    });

    await t.test('reativacao apos reversao permanece bloqueada sem nova transicao', async () => {
      await reset(2);
      await insertRemote(0, { telefone: 'legacy-collision' });
      await quarantine(args((await verify()).verification_digest));

      const original = await prepare();
      await reversalMigration();
      await revert(reversionArgs(original));

      const beforeEntries = await entries();
      const beforeAssignments = await assignments();
      const beforeQuarantine = await quarantineRows();

      const previous = (
        await local.query(
          'SELECT state, request_id FROM olos_http.corporate_id_allocator'
        )
      ).rows[0];

      assert.equal(previous.state, 'legacy');

      await remoteAllocatorMigration();

      const next = allocationArgs();

      await assert.rejects(
        corporateControl(
          cfg,
          'corporate-prepare-id-allocator',
          next,
          allocationAuthorization
        ),
        /ALLOCATOR_ADOPTION_REQUEST_REUSED/
      );

      const current = (
        await local.query(
          'SELECT state, request_id FROM olos_http.corporate_id_allocator'
        )
      ).rows[0];

      assert.deepEqual(current, previous);
      assert.deepEqual(await entries(), beforeEntries);
      assert.deepEqual(await assignments(), beforeAssignments);
      assert.deepEqual(await quarantineRows(), beforeQuarantine);

      const reversions = await reversionRuns();
      assert.equal(reversions.length, 1);
      assert.equal(reversions[0].state, 'completed');
    });

    await t.test('MADM outage leaves durable captures without IDs and later materializes them once', async () => {
      await reset(0); await enableAllocator(); const saved = dc.connection.destinationUrl;
      dc.connection.destinationUrl = 'postgresql://postgres@localhost:1/madm';
      try { await stage(8901); await store!.delivery!.tick(); await stage(8902); await stage(8901); }
      finally { dc.connection.destinationUrl = saved; }
      assert.equal((await admissions()).length, 2); assert.equal((await entries()).length, 0); assert.equal((await store!.unresolved()).length, 0);
      assert((await local.query('SELECT state FROM olos_http.reads')).rows.every(r => r.state === 'done'));
      const status = await store!.delivery!.status(store!.client!); assert.equal(status.unallocated, 2); assert.equal(status.allocator, 'active');
      await recover(args((await verify()).verification_digest)); await corporateControl(cfg, 'corporate-resume');
      await store!.delivery!.tick(); await store!.delivery!.tick();
      assert.equal((await entries()).length, 2); assert((await entries()).every(e => e.state === 'confirmed')); assert((await admissions()).every(e => e.materialized));
    });
    await t.test('adopting intent survives connection failures while captures continue; same request recovers', async () => {
      await reset(1); const input = await prepare(); await remoteAllocatorMigration(); const saved = dc.connection.destinationUrl;
      dc.connection.destinationUrl = 'postgresql://postgres@localhost:1/madm';
      try { await assert.rejects(adopt(input)); await stage(8901); await stage(8902); }
      finally { dc.connection.destinationUrl = saved; }
      assert.equal((await local.query('SELECT state FROM olos_http.corporate_id_allocator')).rows[0].state, 'adopting');
      assert.equal((await entries()).length, 1); assert.equal((await admissions()).length, 2);
      await adopt(input); assert.equal((await local.query('SELECT state FROM olos_http.corporate_id_allocator')).rows[0].state, 'active');
      await assert.rejects(stage(8901, { CallId: 'changed' }), /SOURCE_ID_CONTENT_CONFLICT/);
    });
    await t.test('lost adoption acknowledgement after remote commit preserves reservations and original IDs on retry', async () => {
      await reset(2); const input = await prepare(); await remoteAllocatorMigration(); const before = await snapshot();
      await assert.rejects(adopt(input, { afterReserveCommit: async () => { throw new Error('synthetic lost remote commit'); } }), /synthetic/);
      assert.equal((await assignments()).length, 0); assert.equal((await local.query('SELECT state FROM olos_http.corporate_id_allocator')).rows[0].state, 'adopting');
      const remoteBefore = (await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      await stage(8901); await adopt(input);
      assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows, remoteBefore);
      assert.deepEqual((await entries()), before.entries); assert.deepEqual((await snapshot()).allocator, before.allocator);
    });
    await t.test('reservation idempotency survives remote commit followed by local rollback and restart', async () => {
      await reset(0); await enableAllocator(); await stage(8901); await stage(8902);
      await store!.delivery!.tick({ afterReserveCommit: async () => { throw new Error('synthetic lost acknowledgement'); } });
      assert.equal((await entries()).length, 0); assert.equal((await assignments()).length, 0);
      const reserved = (await remote.query('SELECT internal_id,token FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      assert.equal(reserved.length, 2);
      await store!.close(); store = new Store(cfg); await store.open();
      await store.delivery!.tick({ beforeMaterializeCommit: async () => { throw new Error('synthetic local rollback'); } }); assert.equal((await entries()).length, 0);
      await recover(args((await verify()).verification_digest)); await corporateControl(cfg, 'corporate-resume'); await store.delivery!.tick();
      assert.deepEqual((await assignments()).map(a => ({ internal_id: a.target_id, token: a.token })), reserved);
      assert.equal((await entries()).length, 2); assert((await entries()).every(e => e.state === 'confirmed'));
    });
    await t.test('concurrent authoritative allocators and direct corporate writers cannot consume the same ID', async () => {
      await reset(0); await enableAllocator();
      const second = new pg.Client({ connectionString: destinationUrl.toString() }); await second.connect();
      const items = (prefix: string) => Array.from({ length: 30 }, (_, i) => ({ source_id: `${prefix}${i}`, source_hash: 'hash', request_id: randomUUID() }));
      const first = items('a'), other = items('b');
      try {
        const allocated = await Promise.all([reserveIds(remote, dc, first, false), reserveIds(second, dc, other, false)]);
        assert.equal(new Set(allocated.flat().map(a => a.id)).size, 60);
        assert.deepEqual(await reserveIds(second, dc, first, false), allocated[0]);
        await assert.rejects(reserveIds(remote, dc, [{ ...first[0], source_hash: 'changed' }], false), /REQUEST_CONFLICT/);
        await assert.rejects(insertForeign(allocated[0]![0]!.id), (e: any) => e.code === 'P3103');
        await insertForeign('61');
        const next = await reserveIds(second, dc, [{ source_id: 'later', source_hash: 'hash', request_id: randomUUID() }], false);
        assert.equal(next[0]!.id, '62');
      } finally { await second.end(); }
    });
    await t.test('remote uniqueness holds when a competing writer waits behind an uncommitted reservation', async () => {
      await reset(0); await enableAllocator(); await remote.query('BEGIN');
      const reserved = await reserveIds(remote, dc, [{ source_id: 'race', source_hash: 'hash', request_id: randomUUID() }], false);
      const second = new pg.Client({ connectionString: destinationUrl.toString() }); await second.connect();
      const payload = corporateRow(reserved[0]!.id); let finished = false;
      const racing = assert.rejects(second.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(n => payload[n])), (e: any) => e.code === 'P3103').then(() => { finished = true; });
      try { await pause(30); assert.equal(finished, false); await remote.query('COMMIT'); await racing; }
      finally { await remote.query('ROLLBACK'); await second.end(); }
      assert.equal((await remote.query('SELECT count(*)::int AS n FROM raw.olos_calls')).rows[0].n, 0);
    });
    await t.test('int32 exhaustion fails closed without wrapping or falling back to the local sequence', async () => {
      await reset(0); await enableAllocator(); await remote.query('UPDATE olos_delivery_ids.counter SET next_candidate=2147483647');
      const seq = (await snapshot()).allocator;
      await stage(8901); await store!.delivery!.tick(); assert.equal((await entries())[0].target_id, 2147483647);
      await stage(8902); await store!.delivery!.tick(); assert.equal((await entries()).length, 1);
      assert.equal((await admissions()).filter(e => !e.materialized).length, 1); assert.deepEqual((await snapshot()).allocator, seq);
      await assert.rejects(reserveIds(remote, dc, [{ source_id: 'overflow', source_hash: 'hash', request_id: randomUUID() }], false), /INT32_EXHAUSTED/);
    });
    await t.test('contract drift and admission corruption prevent allocation without losing captures', async () => {
      await reset(0); await enableAllocator(); await stage(8901);
      await remote.query('ALTER TABLE raw.olos_calls DISABLE TRIGGER trg_olos_calls_reserve_internal_id');
      await store!.delivery!.tick(); assert.equal((await entries()).length, 0); await stage(8902); assert.equal((await admissions()).length, 2);
      await remote.query('ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER trg_olos_calls_reserve_internal_id');
      await local.query("UPDATE olos_http.corporate_id_admissions SET mapped_hash=repeat('a',64) WHERE source_id='8901'");
      await store!.delivery!.tick(); assert.equal((await entries()).length, 0); assert((await admissions()).every(e => !e.materialized));
    });
    await t.test('legacy writers are fenced after adoption and allocator state cannot silently disappear', async () => {
      await reset(0); await enableAllocator();
      await assert.rejects(local.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash)
        VALUES($1,'legacy-writer',$2,123,'hash')`, [source, target]), /ALLOCATOR_ASSIGNMENT_REQUIRED/);
      assert.equal((await local.query("SELECT count(*)::int AS n FROM olos_http.records WHERE source_id='legacy-writer'")).rows[0].n, 0);
      await local.query('DROP TABLE olos_http.corporate_id_allocator CASCADE');
      await assert.rejects(stage(8901), /ALLOCATOR_LOCAL_STATE_MISSING/);
      assert.equal((await entries()).length, 0);
    });
    await t.test('captures do not wait for the remote adoption commit and resume refuses incomplete adoption', async () => {
      await reset(1); const input = await prepare(); await remoteAllocatorMigration();
      await assert.rejects(corporateControl(cfg, 'corporate-resume'), /ADOPTION_INCOMPLETE/);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const adopting = adopt(input, { afterReserveCommit: async () => { entered(); await gate; } }); await ready;
      try { await stage(8901); assert.equal((await admissions()).length, 1); assert.equal((await entries()).length, 1); }
      finally { release(); }
      await adopting;
    });
    await t.test('concurrent materialization and delivery consume each reservation only once', async () => {
      await reset(0); await enableAllocator(); for (const id of [8901,8902,8903,8904]) await stage(id);
      await recover(args((await verify()).verification_digest)); await corporateControl(cfg, 'corporate-resume');
      await Promise.all([store!.delivery!.tick(), store!.delivery!.tick()]); await store!.delivery!.tick();
      assert.equal((await entries()).length, 4); assert.equal((await assignments()).length, 4); assert.equal((await control()).confirmed_count, '4');
      assert((await entries()).every(e => e.state === 'confirmed')); assert.equal((await control()).blocked, false);
    });
    await t.test('uncertain local adoption commit is reconciled by the same durable request', async () => {
      for (const lostCommit of [1,2]) {
        await reset(1); await allocatorMigration(); await corporateControl(cfg, 'corporate-pause'); await remoteAllocatorMigration(); const input = allocationArgs();
        await assert.rejects(client(db => {
          let commits = 0;
          const ambiguous = new Proxy(db, { get(connection, key) {
            if (key === 'query') return async (sql: string, parameters?: unknown[]) => {
              const result = await connection.query(sql, parameters);
              if (sql === 'COMMIT' && ++commits === lostCommit) throw new Error('synthetic lost local acknowledgement'); return result;
            };
            return Reflect.get(connection, key);
          } });
          return adoptAllocator(ambiguous, dc, source, target, adoptionRequest(input, allocationAuthorization, source));
        }), /LOCAL_COMMIT_UNKNOWN/);
        await stage(8901); await adopt(input);
        assert.equal((await assignments()).length, 1); assert.equal((await admissions()).length, 1);
        assert.equal((await local.query('SELECT state FROM olos_http.corporate_id_allocator')).rows[0].state, 'active');
      }
    });
    await t.test('database guard protects reservations from another role and retains tombstones after deletion', async () => {
      await reset(0); await enableAllocator();
      await remote.query('CREATE ROLE allocator_test_client LOGIN; CREATE ROLE allocator_test_external LOGIN');
      await remote.query(`GRANT USAGE ON SCHEMA raw,core TO allocator_test_client,allocator_test_external;
        GRANT SELECT,INSERT ON raw.olos_calls TO allocator_test_client,allocator_test_external;
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA raw TO allocator_test_client,allocator_test_external;
        GRANT USAGE ON SCHEMA olos_delivery_ids TO allocator_test_client;
        GRANT EXECUTE ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) TO allocator_test_client`);
      const firstUrl = new URL(destinationUrl); firstUrl.username = 'allocator_test_client'; const otherUrl = new URL(destinationUrl); otherUrl.username = 'allocator_test_external';
      const first = new pg.Client({ connectionString: firstUrl.toString() }), other = new pg.Client({ connectionString: otherUrl.toString() });
      await first.connect(); await other.connect();
      try {
        const assignment = (await reserveIds(first, dc, [{ source_id: 'role-test', source_hash: 'hash', request_id: randomUUID() }], false))[0]!;
        await assert.rejects(other.query('SELECT * FROM olos_delivery_ids.registry'), (e: any) => e.code === '42501');
        await assert.rejects(first.query('ALTER TABLE raw.olos_calls DISABLE TRIGGER trg_olos_calls_reserve_internal_id'), (e: any) => e.code === '42501');
        await other.query("SELECT set_config('olos_delivery_ids.token',$1,false)", [assignment.token]);
        const payload = corporateRow(assignment.id);
        await assert.rejects(other.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(n => payload[n])), (e: any) => e.code === 'P3103');
        await first.query('BEGIN'); await first.query("SELECT set_config('olos_delivery_ids.token',$1,true)", [assignment.token]);
        await first.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(n => payload[n])); await first.query('COMMIT');
        await remote.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=$1', [assignment.id]);
        await remote.query('UPDATE olos_delivery_ids.counter SET next_candidate=1');
        const next = await reserveIds(first, dc, [{ source_id: 'after-deletion', source_hash: 'hash', request_id: randomUUID() }], false);
        assert.notEqual(next[0]!.id, assignment.id);
      } finally {
        await first.end(); await other.end(); await remote.query('DROP OWNED BY allocator_test_client,allocator_test_external; DROP ROLE allocator_test_client; DROP ROLE allocator_test_external');
      }
    });
    await t.test('resume respects adoption lock order and does not retain the control row while waiting for the allocator fence', async () => {
      await reset(0); await allocatorMigration(); await local.query('UPDATE olos_http.corporate_control SET blocked=false,paused=true');
      await client(async db => {
        await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(17320914,5)');
        const resuming = corporateControl(cfg, 'corporate-resume');
        try {
          await pause(30);
          await db.query('SELECT singleton FROM olos_http.corporate_control FOR UPDATE NOWAIT');
        } finally { await db.query('COMMIT'); }
        await resuming;
      });
      assert.equal((await control()).paused, false);
    });
    await t.test('allocator migrations are idempotent and preserve history and corporate row contents', async () => {
      await reset(2); await insertRemote(0); const input = await enableAllocator(); const before = await snapshot();
      await allocatorMigration(); await remoteAllocatorMigration(); await adopt(input);
      assert.deepEqual(await snapshot(), before); assert.equal(await allocatorContract(remote), (await local.query('SELECT contract_hash FROM olos_http.corporate_id_allocator')).rows[0].contract_hash);
    });
    await t.test('emergency legacy reversion preserves history, materializes all admissions once and resumes the original INSERT path', async () => {
      await reset(2); await local.query('UPDATE olos_http.corporate_control SET blocked=false,paused=false'); await store!.delivery!.tick();
      await stage(8101); await stage(8102); await insertRemote(2,{telefone:'old-collision'});
      await local.query("UPDATE olos_http.corporate_control SET blocked=true,last_code='INTERNAL_ID_COLLISION'");
      await quarantine(args((await verify()).verification_digest)); const adoption = await prepare();
      for (const id of [8901,8902,8903,8904,8905]) await stage(id);
      await reversalMigration(); const before = await snapshot(), oldAdmissions = await admissions(); const input = reversionArgs(adoption);
      let output = ''; const stop = observeLogs(e => { output+=JSON.stringify(e); });
      try { await corporateControl(cfg,'corporate-revert-id-allocator',input,reversionAuthorization); } finally { stop(); }
      assert.doesNotMatch(output,/private-|Private Agent|55119000|@|old-collision/);
      const after = await snapshot();
      for (const entry of before.entries) assert.deepEqual(after.entries.find(e=>e.source_id===entry.source_id),entry);
      for (const record of before.records) assert.deepEqual(after.records.find(r=>r.source_id===record.source_id),record);
      assert.deepEqual(after.remote,before.remote); assert.deepEqual(after.sequence,before.sequence); assert.deepEqual(after.quarantine,before.quarantine);
      assert.deepEqual(after.quarantineRuns,before.quarantineRuns); assert.deepEqual(after.reads,before.reads);
      assert.equal(after.control.confirmed_count,'2'); assert.equal(after.control.blocked,true); assert.equal(after.control.last_code,'INTERNAL_ID_COLLISION'); assert.equal(after.control.paused,true);
      assert.equal(after.control.id_allocator_required,false); assert.equal((await assignments()).length,0);
      const materialized = await admissions(); assert.equal(materialized.length,5);
      for (let i=0;i<materialized.length;i++) { assert.deepEqual({...materialized[i],materialized:false},oldAdmissions[i]); assert.equal(materialized[i].materialized,true); }
      const run = (await reversionRuns())[0]; assert.equal(run.state,'completed'); assert.equal(run.initial_count,'5'); assert.equal(run.materialized_count,'5'); assert.equal(run.adoption_request_id,adoption[3]);
      assert.equal((await reversionBatches()).length,3); assert.equal(after.entries.length,9);
      const seq = after.allocator; const duplicate = await revert(input); assert.deepEqual(duplicate,{completed:true,alreadyApplied:true}); assert.deepEqual(await snapshot(),after); assert.deepEqual((await snapshot()).allocator,seq);
      await assert.rejects(adopt(adoption),/ADOPTION_REVERTED/); assert.equal((await control()).id_allocator_required,false);
      await stage(8999); assert.equal((await admissions()).length,5); assert.equal((await entries()).length,10);
      await assert.rejects(corporateControl(cfg,'corporate-resume'),/REVERSION_VALIDATION_REQUIRED/);
      const remaining = await verify(); assert.equal(remaining.unallocated,0); assert.equal(remaining.quarantined,1); assert.deepEqual(remaining.issues,[]);
      await recover(args(remaining.verification_digest));
      assert.equal((await reversionRuns())[0].validation_digest,remaining.verification_digest);
      await corporateControl(cfg,'corporate-resume');
      for (let i=0;i<5;i++) await store!.delivery!.tick();
      assert.equal((await entries()).filter(e=>e.state==='confirmed').length,9); assert.equal((await control()).blocked,false);
      assert.deepEqual((await entries()).find(e=>e.source_id==='8101'),before.entries.find(e=>e.source_id==='8101'));
      assert.deepEqual(await revert(input),{completed:true,alreadyApplied:true}); assert.equal((await control()).paused,false);
      const status = await store!.delivery!.status(store!.client!); assert.equal(status.allocator,'legacy'); assert.equal(status.unallocated,0); assert.equal(status.reversion_request_id,input[5]);
    });
    await t.test('reversion refuses remote allocator evidence, assignments, active state and missing migration without modifying data', async () => {
      await reset(1); const adoption = await prepare(); await stage(8901); const input = reversionArgs(adoption);
      await assert.rejects(revert(input),/REVERSION_MIGRATION_REQUIRED/); await reversalMigration();
      const before = await snapshot(), data = await admissions();
      await remote.query('CREATE SCHEMA olos_delivery_ids'); await assert.rejects(revert(input),/REVERSION_REMOTE_PRESENT/);
      assert.deepEqual(await snapshot(),before); assert.deepEqual(await admissions(),data); assert.equal((await reversionRuns()).length,0);
      await reset(1); const another = await prepare(); await stage(8901); await reversalMigration();
      await local.query("INSERT INTO olos_http.corporate_id_assignments(source_key,source_id,target_id,source_hash,binding,token,legacy) SELECT source_key,source_id,target_id,source_hash,$1,NULL,true FROM olos_http.records",[dc.binding]);
      await assert.rejects(revert(reversionArgs(another)),/ASSIGNMENTS_EXIST/); assert.equal((await reversionRuns()).length,0);
      await reset(0); const active = await prepare(); await reversalMigration();
      await local.query("UPDATE olos_http.corporate_id_allocator SET state='active',contract_hash=repeat('a',64),adopted_at=now()");
      await assert.rejects(revert(reversionArgs(active)),/STATE_INVALID/); assert.equal((await control()).id_allocator_required,true);
    });
    await t.test('batch rollback preserves admissions and existing rows; repetition completes without duplicates', async () => {
      await reset(1); const adoption = await prepare(); for (const id of [8901,8902,8903]) await stage(id); await reversalMigration();
      const input = reversionArgs(adoption), before = await snapshot(), data = await admissions();
      await assert.rejects(revert(input,{beforeBatchCommit:async()=>{throw new Error('synthetic batch failure');}}),/synthetic batch failure/);
      assert.deepEqual(await entries(),before.entries); assert.deepEqual((await snapshot()).records,before.records); assert.deepEqual(await admissions(),data);
      assert.equal((await reversionRuns())[0].state,'materializing'); assert.equal((await reversionRuns())[0].materialized_count,'0'); assert.equal((await reversionBatches()).length,0);
      assert.equal((await control()).paused,true); await assert.rejects(corporateControl(cfg,'corporate-resume'),/ADOPTION_INCOMPLETE/);
      await revert(input); assert.equal((await entries()).length,4); assert.equal((await reversionBatches()).length,2); assert((await admissions()).every(e=>e.materialized));
    });
    await t.test('committed progress survives interruption, a new capture and process restart', async () => {
      await reset(0); const adoption = await prepare(); for (const id of [8901,8902,8903]) await stage(id); await reversalMigration(); const input = reversionArgs(adoption);
      await assert.rejects(revert(input,{afterBatchCommit:async()=>{throw new Error('synthetic interruption');}}),/synthetic interruption/);
      const committed = await entries(); assert.equal(committed.length,2); assert.equal((await reversionRuns())[0].materialized_count,'2');
      await stage(8999); await store!.close(); store = new Store(cfg); await store.open();
      await revert(input); for (const original of committed) assert.deepEqual((await entries()).find(e=>e.source_id===original.source_id),original);
      assert.equal((await entries()).length,4); assert.equal((await reversionRuns())[0].initial_count,'3'); assert.equal((await reversionRuns())[0].materialized_count,'4');
      assert((await admissions()).every(e=>e.materialized));
    });
    await t.test('limited invocations retain pause until a later invocation finalizes the same request', async () => {
      await reset(0); const adoption = await prepare(); for (const id of [8901,8902,8903]) await stage(id); await reversalMigration();
      const input = reversionArgs(adoption,randomUUID(),1); const result = await revert(input);
      assert.equal(result.completed,false); assert.equal((await entries()).length,2); assert.equal((await control()).paused,true);
      await assert.rejects(corporateControl(cfg,'corporate-resume'),/ADOPTION_INCOMPLETE/);
      await assert.rejects(corporateControl(cfg,'corporate-revert-id-allocator',input,reversionAuthorization),/REVERSION_INCOMPLETE/);
      assert.equal((await admissions()).filter(e=>!e.materialized).length,0); assert.equal((await reversionRuns())[0].state,'materializing');
      await revert(input); assert.equal((await reversionRuns())[0].state,'completed');
    });
    await t.test('uncertain commits at intent, batch and completion reconcile with the original request', async () => {
      for (const lostCommit of [1,2,3]) {
        await reset(0); const adoption = await prepare(); await stage(8901); await reversalMigration(); const input = reversionArgs(adoption);
        await assert.rejects(client(db=>{
          let commits=0;
          const ambiguous = new Proxy(db,{get(connection,key){
            if(key==='query') return async(sql:string,parameters?:unknown[])=>{const result=await connection.query(sql,parameters);if(sql==='COMMIT'&&++commits===lostCommit)throw new Error('lost acknowledgement');return result;};
            return Reflect.get(connection,key);
          }});
          return revertAllocator(ambiguous,cfg,store!.delivery!,legacyReversionRequest(input,reversionAuthorization,source));
        }),/REVERSION_COMMIT_UNKNOWN/);
        const committed=await entries(); await revert(input); assert.equal((await entries()).length,1);
        for(const row of committed) assert.deepEqual((await entries()).find(e=>e.source_id===row.source_id),row);
        assert.equal((await reversionBatches()).length,1); assert.equal((await reversionRuns())[0].state,'completed');
      }
    });
    await t.test('reversion excludes concurrent capture persistence, delivery, resume and another reversion per batch', async () => {
      await reset(0); const adoption=await prepare(); await stage(8901); await stage(8902); await reversalMigration(); const input=reversionArgs(adoption);
      let entered!:()=>void, release!:()=>void;
      const ready=new Promise<void>(r=>{entered=r;}), gate=new Promise<void>(r=>{release=r;}); let first=true;
      const operation=revert(input,{afterLocks:async()=>{if(first){first=false;entered();await gate;}}}); await ready;
      let captured=false,delivered=false;
      const capturing=stage(8999).then(()=>{captured=true;}); const delivering=store!.delivery!.tick().then(()=>{delivered=true;});
      const resuming=assert.rejects(corporateControl(cfg,'corporate-resume'),/ADOPTION_INCOMPLETE|DELIVERY_BLOCKED|REVERSION_VALIDATION_REQUIRED/);
      await assert.rejects(revert(input),/REVERSION_BUSY/);
      try{await pause(50);assert.equal(captured,false);assert.equal(delivered,false);}finally{release();}
      await operation; await Promise.all([capturing,delivering,resuming]);
      assert.equal((await entries()).length,3); assert.equal((await control()).paused,true); assert.equal((await assignments()).length,0);
    });
    await t.test('admission or approval divergence cannot be discarded or overwritten during reversion', async () => {
      await reset(0); const adoption=await prepare(); await stage(8901); await reversalMigration(); const input=reversionArgs(adoption);
      await local.query("UPDATE olos_http.corporate_id_admissions SET mapped_hash=repeat('a',64)");
      await assert.rejects(revert(input),/ADMISSION_CHANGED/); assert.equal((await reversionRuns()).length,0); assert.equal((await entries()).length,0);
      assert.equal((await local.query('SELECT state FROM olos_http.corporate_id_allocator')).rows[0].state,'adopting');
      await reset(0); const next=await prepare(); await stage(8901); await reversalMigration(); const original=reversionArgs(next); await revert(original);
      await assert.rejects(revert(original.map((v,i)=>i===7?'INC-OTHER':v)),/REQUEST_REUSED/);
      await assert.rejects(revert(reversionArgs(next)),/REQUEST_REUSED/);
      assert.equal((await entries()).length,1);
    });
    await t.test('newly materialized legacy collisions are isolated by the existing procedure before delivery resumes', async () => {
      await reset(0); await insertForeign('1'); const adoption=await prepare(); await stage(8901); await stage(8902); await reversalMigration();
      await revert(reversionArgs(adoption)); const report=await verify(); assert.equal(report.issues[0]!.code,'INTERNAL_ID_COLLISION');
      await assert.rejects(recover(args(report.verification_digest)),/PENDING_DIVERGES/); const remoteBefore=(await snapshot()).remote;
      await quarantine(args(report.verification_digest)); const valid=await verify(); assert.equal(valid.quarantined,1); assert.deepEqual(valid.issues,[]);
      await recover(args(valid.verification_digest)); await corporateControl(cfg,'corporate-resume'); await store!.delivery!.tick();
      assert.deepEqual((await entries()).map(e=>e.state),['pending','confirmed']);
      assert.deepEqual((await snapshot()).remote.find(r=>r.internal_id_olos===1),remoteBefore[0]);
    });
    await t.test('finalization rollback is resumable and migrations retain all local triggers and evidence', async () => {
      await reset(0); const adoption=await prepare(); await stage(8901); await reversalMigration(); const input=reversionArgs(adoption);
      await assert.rejects(revert(input,{beforeCompleteCommit:async()=>{throw new Error('synthetic completion failure');}}),/synthetic completion failure/);
      const frozen=await entries(); const oldAdmissions=await admissions(); const batches=await reversionBatches();
      assert.equal((await reversionRuns())[0].state,'materializing');
      await reversalMigration(); await allocatorMigration(); await revert(input);
      assert.deepEqual(await entries(),frozen); assert.deepEqual(await admissions(),oldAdmissions); assert.deepEqual(await reversionBatches(),batches);
      assert.equal((await local.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='olos_http.records'::regclass AND tgname='corporate_id_assignment_required' AND tgenabled='O'")).rows[0].n,1);
      assert.equal((await control()).id_allocator_required,false); assert.equal((await reversionRuns())[0].state,'completed');
    });
    await t.test('a previously persisted admission is recognized exactly, without reallocating its ID or replacing its payload',async()=>{
      await reset(0);const adoption=await prepare();for(const id of [8901,8902,8903])await stage(id);await reversalMigration();const input=reversionArgs(adoption,randomUUID(),1);
      await revert(input);
      const waiting=(await admissions()).find(e=>!e.materialized)!;
      const seq=(await local.query("SELECT pg_get_serial_sequence('raw.olos_calls','internal_id_olos') AS name")).rows[0].name;
      await client(async db=>{
        await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(17320914,5)');
        await store!.delivery!.enqueue(db,seq,[waiting.mapped],undefined,input[5]);await db.query('COMMIT');
      });
      const frozen=await entries(),cursor=(await snapshot()).allocator;
      await revert(input);await revert(input);
      assert.deepEqual(await entries(),frozen);assert.deepEqual((await snapshot()).allocator,cursor);assert.equal((await entries()).length,3);
      assert.equal((await reversionRuns())[0].materialized_count,'3');assert((await admissions()).every(e=>e.materialized));
    });
    await t.test('compiled CLI restores legacy and repeats the same request without issuing remote writes',async()=>{
      await reset(0);const adoption=await prepare();await stage(8901);await reversalMigration();const input=reversionArgs(adoption);
      const before=(await snapshot()).remote;
      const result=await promisify(execFile)(process.execPath,['dist/main.js','corporate-revert-id-allocator',...input],{env:{...env,...reversionAuthorization},timeout:15000});
      assert.match(result.stdout,/"completed":true/);assert.match(result.stdout,/corporate_legacy_reversion_recorded/);
      const frozen=await entries();const repeated=await promisify(execFile)(process.execPath,['dist/main.js','corporate-revert-id-allocator',...input],{env:{...env,...reversionAuthorization},timeout:15000});
      assert.match(repeated.stdout,/"already_applied":true/);assert.deepEqual(await entries(),frozen);assert.deepEqual((await snapshot()).remote,before);
    });
    await t.test('read-only remote failure before reversal keeps adopting and preserves all data', async()=>{
      await reset(0);const adoption=await prepare();await stage(8901);await reversalMigration();const input=reversionArgs(adoption),data=await admissions();
      const saved=dc.connection.destinationUrl;dc.connection.destinationUrl='postgresql://postgres@localhost:1/madm';
      try{await assert.rejects(revert(input));}finally{dc.connection.destinationUrl=saved;}
      assert.equal((await reversionRuns()).length,0);assert.deepEqual(await admissions(),data);assert.equal((await control()).id_allocator_required,true);
      await stage(8902);await revert(input);assert.equal((await entries()).length,2);
    });
    await t.test('historical IDs far above the local sequence do not determine the next safe ID',async()=>{
      await reset(1);await importedHistory(47561749,'700001');
      await insertRemote(1,{telefone:'preserved-collision'});
      await quarantine(args((await verify()).verification_digest));
      const adoption=await prepare();for(const id of [8901,8902,8903])await stage(id);await reversalMigration();
      const before=await snapshot(),data=await admissions(),input=reversionArgs(adoption);
      assert.equal(before.allocator[0].last_value,'1');
      await revert(input);const after=await snapshot();
      assert.deepEqual(after.entries.map(e=>e.target_id),[1,2,3,4,47561749]);assert.equal(after.allocator[0].last_value,'4');
      for(const row of before.entries)assert.deepEqual(after.entries.find(e=>e.source_id===row.source_id),row);
      for(const row of before.records)assert.deepEqual(after.records.find(e=>e.source_id===row.source_id),row);
      assert.deepEqual(after.quarantine,before.quarantine);assert.deepEqual(after.remote,before.remote);
      assert.deepEqual((await admissions()).map(e=>({...e,materialized:false})),data);
      const frozen=await entries(),cursor=after.allocator;await revert(input);assert.deepEqual(await entries(),frozen);assert.deepEqual((await snapshot()).allocator,cursor);
      await recover(args((await verify()).verification_digest));await corporateControl(cfg,'corporate-resume');
      await store!.delivery!.tick();await store!.delivery!.tick();
      assert.equal((await entries()).filter(e=>e.state==='confirmed').length,4);assert.equal((await control()).blocked,false);
    });
    await t.test('a local ID in the needed interval blocks before materialization without moving the sequence',async()=>{
      await reset(1);await importedHistory(3,'700003');const adoption=await prepare();await stage(8901);await stage(8902);await reversalMigration();
      const before=await snapshot(),data=await admissions();let observed='';const stop=observeLogs(e=>{observed+=JSON.stringify(e);});
      try{await assert.rejects(revert(reversionArgs(adoption)),/LEGACY_SEQUENCE_UNSAFE/);}finally{stop();}
      assert.match(observed,/LOCAL_TARGET_ID_OCCUPIED/);assert.match(observed,/"target_id":"3"/);
      assert.deepEqual(await snapshot(),before);assert.deepEqual(await admissions(),data);assert.equal((await reversionRuns()).length,0);
      assert.equal((await local.query('SELECT state FROM olos_http.corporate_id_allocator')).rows[0].state,'adopting');
    });
    await t.test('raw destination occupancy and old receipts also prevent local ID reuse',async()=>{
      for(const scope of ['raw','receipts']){
        await reset(1);
        if(scope==='raw'){
          const payload={...(await entries())[0].payload,internal_id_olos:'2'};
          await local.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) OVERRIDING SYSTEM VALUE VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(n=>payload[n]));
        }else await local.query("INSERT INTO corporate_sync.receipts(internal_id_olos,payload_hash) VALUES(2,repeat('a',64))");
        const adoption=await prepare();await stage(8901);await reversalMigration();const before=await snapshot();
        await assert.rejects(revert(reversionArgs(adoption)),/LEGACY_SEQUENCE_UNSAFE/);
        assert.deepEqual(await snapshot(),before);assert.equal((await reversionRuns()).length,0);
      }
    });
    await t.test('actual nextval values are checked independently of the forecast',async()=>{
      await reset(1);await importedHistory(2,'700002');const before=await entries();
      await assert.rejects(client(async db=>{
        await db.query('BEGIN');
        try{
          const scopes=await lockLegacyIdSpace(db,target);
          await nextLegacyId(db,'raw.olos_calls_internal_id_olos_seq',target,scopes);
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK');throw error;}
      }),/LEGACY_SEQUENCE_UNSAFE/);
      assert.deepEqual(await entries(),before);assert.equal((await local.query("SELECT count(*)::int AS n FROM olos_http.records WHERE target_id=2")).rows[0].n,1);
    });
    await t.test('high historical IDs stay unchanged through interrupted batches and idempotent recovery',async()=>{
      await reset(1);await importedHistory(47561749,'700004');const adoption=await prepare();for(const id of [8901,8902,8903])await stage(id);await reversalMigration();const input=reversionArgs(adoption);
      await assert.rejects(revert(input,{afterBatchCommit:async()=>{throw new Error('synthetic interruption');}}),/synthetic interruption/);
      const committed=await entries();assert.deepEqual(committed.map(e=>e.target_id),[1,2,3,47561749]);
      await store!.close();store=new Store(cfg);await store.open();await revert(input);
      for(const row of committed)assert.deepEqual((await entries()).find(e=>e.source_id===row.source_id),row);
      assert.deepEqual((await entries()).map(e=>e.target_id),[1,2,3,4,47561749]);assert.equal((await reversionBatches()).length,2);
      const frozen=await snapshot();await revert(input);assert.deepEqual(await snapshot(),frozen);
    });
    await t.test('conflicts that appear between committed batches block the next interval without rewriting prior mappings',async()=>{
      await reset(1);await importedHistory(47561749,'700005');const adoption=await prepare();for(const id of [8901,8902,8903])await stage(id);await reversalMigration();const input=reversionArgs(adoption,randomUUID(),1);
      assert.equal((await revert(input)).completed,false);const committed=await entries();
      await importedHistory(4,'700006');const cursor=(await snapshot()).allocator;
      await assert.rejects(revert(input),/LEGACY_SEQUENCE_UNSAFE/);
      for(const row of committed)assert.deepEqual((await entries()).find(e=>e.source_id===row.source_id),row);
      assert.equal((await admissions()).filter(e=>!e.materialized).length,1);assert.deepEqual((await snapshot()).allocator,cursor);assert.equal((await control()).paused,true);
    });
    await t.test('never-called sequences validate their actual first value rather than assuming an increment already happened',async()=>{
      await reset(0);await importedHistory(47561749,'700007');const adoption=await prepare();await stage(8901);await reversalMigration();
      assert.equal((await snapshot()).allocator[0].is_called,false);await revert(reversionArgs(adoption));
      assert.deepEqual((await entries()).map(e=>e.target_id),[1,47561749]);assert.equal((await snapshot()).allocator[0].last_value,'1');
      await reset(0);await importedHistory(1,'700008');const second=await prepare();await stage(8901);await reversalMigration();const before=await snapshot();
      await assert.rejects(revert(reversionArgs(second)),/LEGACY_SEQUENCE_UNSAFE/);assert.deepEqual(await snapshot(),before);
      assert.equal((await snapshot()).allocator[0].is_called,false);
    });
    await t.test('a role that cannot exclude concurrent local writers cannot approve the ID proof',async()=>{
      await reset(1);await local.query('CREATE ROLE local_id_proof_reader LOGIN');
      await local.query('GRANT USAGE ON SCHEMA raw,olos_http,corporate_sync TO local_id_proof_reader; GRANT SELECT ON ALL TABLES IN SCHEMA raw,olos_http,corporate_sync TO local_id_proof_reader');
      const url=new URL(sourceUrl);url.username='local_id_proof_reader';const readerPool=new pg.Pool({connectionString:url.toString(),max:1});const reader=await readerPool.connect();
      try{await reader.query('BEGIN');await assert.rejects(lockLegacyIdSpace(reader,target),/LEGACY_SEQUENCE_UNSAFE/);await reader.query('ROLLBACK');}
      finally{reader.release(true);await readerPool.end();await local.query('DROP OWNED BY local_id_proof_reader; DROP ROLE local_id_proof_reader');}
    });
    await t.test('a competing SQL writer cannot claim a locally allocated ID during materialization',async()=>{
      await reset(1);await importedHistory(47561749,'700009');const adoption=await prepare();await stage(8901);await reversalMigration();
      let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
      const operation=revert(reversionArgs(adoption),{beforeBatchCommit:async()=>{entered();await gate;}});await ready;
      let finished=false;
      const competing=assert.rejects(local.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash)
        VALUES($1,'competing-local-writer',$2,2,'synthetic-hash')`,[source,target]),(error:any)=>error.code==='23505').then(()=>{finished=true;});
      try{await pause(30);assert.equal(finished,false);}finally{release();}
      await operation;await competing;
      assert.equal((await local.query('SELECT count(*)::int AS n FROM olos_http.records WHERE target_table=$1 AND target_id=2',[target])).rows[0].n,1);
      assert.equal((await entries()).find(e=>e.target_id===2).source_id,'8901');
    });
    await t.test('missing immediate uniqueness protection refuses the sequence proof',async()=>{
      await reset(1);const adoption=await prepare();await stage(8901);await reversalMigration();
      await local.query('ALTER TABLE olos_http.records DROP CONSTRAINT records_target_table_target_id_key');
      const data=await admissions();await assert.rejects(revert(reversionArgs(adoption)),/LEGACY_SEQUENCE_UNSAFE/);
      assert.deepEqual(await admissions(),data);assert.equal((await reversionRuns()).length,0);
    });
    const activationMigration=async()=>local.query(await readFile(new URL('../migrations/011_corporate_readoption_activation.sql',import.meta.url),'utf8'));
    async function reprepare(n=3,collision=true,backlog=true):Promise<{request:ReadoptionRequest;original:string;reversion:string}> {
      await reset(n);
      if(collision&&n){await insertRemote(0,{telefone:'foreign-collision'});await quarantine(args((await verify()).verification_digest));}
      const first=await prepare();if(backlog)await stage(8990);
      await reversalMigration();const reverse=reversionArgs(first);await revert(reverse);
      await recover(args((await verify()).verification_digest));
      await local.query(await readFile(new URL('../migrations/010_corporate_allocator_readoption.sql',import.meta.url),'utf8'));
      await activationMigration();
      const request={source,requestId:randomUUID(),evidence:'INC-READOPTION-ACTIVATION'};
      await client(db=>prepareCorporateReadoption(db,request,dc.binding,target,dc));
      return {request,original:first[3]!,reversion:reverse[5]!};
    }
    const validateReado=(request:ReadoptionRequest,hooks:ReadoptionHooks={})=>client(db=>validateReadoption(db,dc,target,request,hooks));
    const activateReado=(request:ReadoptionActivation,hooks:ReadoptionHooks={})=>client(db=>activateReadoption(db,dc,target,request,hooks));
    async function activationRequest(request:ReadoptionRequest,maxBatches=100):Promise<ReadoptionActivation> {
      await validateReado(request);
      const status=await client(db=>readoptionStatus(db,dc,target,source,request.requestId));
      return {...request,validation:status.validation_digest!,maxBatches};
    }
    await t.test('readoption activates a separate generation in batches, preserves history, and reserves new corporate IDs end to end',async()=>{
      const setup=await reprepare(),history=await snapshot(),reversions=await reversionRuns(),quarantined=await quarantineRows();
      await remoteAllocatorMigration();const request=await activationRequest(setup.request,1);
      let progress=await activateReado(request);assert.equal(progress.state,'activating');assert.equal(progress.completed,false);assert.equal(progress.registered,'2');
      const oldCursor=(await snapshot()).allocator;await stage(8991);await stage(8991);
      assert.deepEqual((await snapshot()).allocator,oldCursor);assert.equal((await admissions()).filter(a=>!a.materialized).length,1);
      progress=await activateReado({...request,maxBatches:100});assert.equal(progress.state,'active');assert.equal(progress.registered,'4');
      assert.equal((await local.query('SELECT request_id FROM olos_http.corporate_id_allocator')).rows[0].request_id,setup.original);
      assert.equal((await control()).id_allocator_generation,setup.request.requestId);
      assert.deepEqual(await entries(),history.entries);assert.deepEqual((await snapshot()).records,history.records);assert.deepEqual(await reversionRuns(),reversions);assert.deepEqual(await quarantineRows(),quarantined);
      const receiptBefore=await entries();await store!.delivery!.tick();
      assert.equal((await admissions()).filter(a=>!a.materialized).length,0);
      const fresh=(await entries()).find(e=>e.source_id==='8991');assert(fresh);assert.equal(fresh.target_id,5);assert((await assignments()).find(a=>a.source_id==='8991').token);
      assert.deepEqual((await entries()).filter(e=>e.source_id!=='8991'),receiptBefore);
      await corporateControl(cfg,'corporate-resume');await store!.delivery!.tick();await store!.delivery!.tick();await store!.delivery!.tick();
      assert.equal((await entries()).find(e=>e.source_id==='8991').state,'confirmed');assert.equal((await entries()).find(e=>e.target_id===1).state,'pending');assert.deepEqual(await quarantineRows(),quarantined);
      const registry=(await remote.query('SELECT internal_id,state,source_id FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      assert.equal(registry.find(r=>r.internal_id===5).source_id,'8991');assert.equal(registry.find(r=>r.internal_id===5).state,'used');
      assert.equal((await activateReado(request)).alreadyApplied,true);
      await assert.rejects(adopt(allocationArgs(setup.original)),/ADOPTION_REVERTED|REQUEST_REUSED/);
      await assert.rejects(client(db=>prepareCorporateReadoption(db,{...setup.request,requestId:randomUUID()},dc.binding,target,dc)),/READOPTION_REQUEST_CONFLICT/);
    });
    await t.test('readoption validation fails closed without remote authority and recovers the same intent when installed',async()=>{
      const {request}=await reprepare(0,false,false),cursor=(await snapshot()).allocator;
      await assert.rejects(validateReado(request),/REMOTE_AUTHORITY_ABSENT/);
      let state=await client(db=>readoptionStatus(db,dc,target,source,request.requestId));assert.equal(state.state,'validating');assert.equal(state.authority.id_allocator_required,false);
      await remoteAllocatorMigration();const activation=await activationRequest(request);await activateReado(activation);
      assert.equal((await client(db=>readoptionStatus(db,dc,target,source,request.requestId))).state,'active');
      const saved=dc.connection.destinationUrl;dc.connection.destinationUrl='postgresql://postgres@localhost:1/madm';
      try{await stage(8992);await store!.delivery!.tick();assert.equal((await admissions()).filter(a=>!a.materialized).length,1);assert.deepEqual((await snapshot()).allocator,cursor);assert.equal((await entries()).length,0);}
      finally{dc.connection.destinationUrl=saved;}
      await store!.delivery!.tick();assert.equal((await admissions()).filter(a=>!a.materialized).length,0);assert.equal((await entries()).length,1);
    });
    await t.test('readoption schema is reentrant and rejects contract drift before creating an authority barrier',async()=>{
      const {request}=await reprepare(1,false,false);await activationMigration();await remoteAllocatorMigration();
      const input=await activationRequest(request);
      await remote.query('ALTER TABLE raw.olos_calls DISABLE TRIGGER trg_olos_calls_reserve_internal_id');
      await assert.rejects(activateReado(input),/CONTRACT_CHANGED|TRIGGER_REVIEW_REQUIRED/);assert.equal((await control()).id_allocator_required,false);
      await remote.query('ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER trg_olos_calls_reserve_internal_id');
      await assert.rejects(activateReado({...input,validation:'f'.repeat(64)}),/VALIDATION_CHANGED/);assert.equal((await control()).id_allocator_required,false);
      await activateReado(input);await assert.rejects(client(db=>abortReadoption(db,dc,target,request)),/IRREVERSIBLE/);
      await assert.rejects(local.query('UPDATE olos_http.corporate_control SET id_allocator_required=false WHERE singleton'),/IRREVERSIBLE/);
    });
    await t.test('aborted pre-barrier requests remain immutable history while a different generation can be prepared',async()=>{
      const {request}=await reprepare(0,false,false);
      assert.equal((await client(db=>abortReadoption(db,dc,target,request))).state,'aborted');
      const next={...request,requestId:randomUUID()};await client(db=>prepareCorporateReadoption(db,next,dc.binding,target,dc));
      assert.equal((await local.query('SELECT count(*)::integer n FROM olos_http.corporate_allocator_readoptions')).rows[0].n,2);
      assert.equal((await client(db=>readoptionStatus(db,dc,target,source,request.requestId))).state,'aborted');
    });
    await t.test('an activation interrupted after remote registration retries identical reservations and checkpoints',async()=>{
      const {request}=await reprepare(3,false,true);await remoteAllocatorMigration();const input=await activationRequest(request),history=await entries();
      await assert.rejects(activateReado(input,{afterReserveCommit:async()=>{throw new Error('synthetic crash after corporate commit');}}),/synthetic/);
      let state=await client(db=>readoptionStatus(db,dc,target,source,request.requestId));assert.equal(state.state,'activating');assert.equal(state.registered,'0');assert.equal((await assignments()).length,0);
      const reserved=(await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      await stage(8993);await store!.delivery!.tick();assert.equal((await admissions()).filter(a=>!a.materialized).length,1);
      await activateReado(input);assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows.filter(r=>r.internal_id<=2),reserved);assert.equal((await remote.query('SELECT count(*)::integer n FROM olos_delivery_ids.registry')).rows[0].n,4);assert.deepEqual(await entries(),history);
    });
    await t.test('the readoption barrier fences old READ COMMITTED and REPEATABLE READ binaries, including local raw writes',async()=>{
      const {request}=await reprepare(1,false,false);await remoteAllocatorMigration();const input=await activationRequest(request);
      const stale=await pool.connect();await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      assert.equal((await stale.query('SELECT id_allocator_required FROM olos_http.corporate_control')).rows[0].id_allocator_required,false);
      let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
      const pending=activateReado(input,{afterBarrierCommit:async()=>{entered();await gate;}});await ready;
      try{
        await assert.rejects(stale.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) VALUES($1,'stale-binary',$2,777,'hash')`,[source,target]),(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='40001');
        await stale.query('ROLLBACK');
        await assert.rejects(local.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash) VALUES($1,'old-binary',$2,778,'hash')`,[source,target]),/ASSIGNMENT_REQUIRED/);
        await assert.rejects(local.query(`INSERT INTO raw.olos_calls(olos_call_id) VALUES('old-raw-binary')`),/LEGACY_GENERATION_FORBIDDEN/);
        const cursor=(await snapshot()).allocator;await stage(8994);assert.deepEqual((await snapshot()).allocator,cursor);
        assert.equal((await local.query("SELECT count(*)::integer n FROM olos_http.records WHERE source_id IN ('stale-binary','old-binary')")).rows[0].n,0);
        assert.equal((await local.query('SELECT count(*)::integer n FROM raw.olos_calls')).rows[0].n,0);
      }finally{stale.release(true);release();await pending;}
      assert.equal((await pending).state,'active');
      assert.equal((await admissions()).find(a=>a.source_id==='8994').allocator_generation,request.requestId);
      await store!.delivery!.tick();assert.equal((await assignments()).find(a=>a.source_id==='8994').allocator_generation,request.requestId);
    });
    await t.test('concurrent readoption operations serialize while capture remains independent of remote registration',async()=>{
      const {request}=await reprepare(2,false,false);await remoteAllocatorMigration();const input=await activationRequest(request);
      let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
      const pending=activateReado(input,{afterReserveCommit:async()=>{entered();await gate;}});await ready;
      try{
        await assert.rejects(activateReado(input),/READOPTION_BUSY/);
        await assert.rejects(client(db=>prepareCorporateReadoption(db,{...request,requestId:randomUUID()},dc.binding,target,dc)),/READOPTION_BUSY/);
        const start=performance.now();await stage(8995);assert(performance.now()-start<750);assert.equal((await admissions()).filter(a=>!a.materialized).length,1);
      }finally{release();await pending;}
      assert.equal((await pending).state,'active');assert.equal((await assignments()).length,2);
    });
    await t.test('lost local COMMIT acknowledgements at barrier, batch and activation reconcile by the same UUID',async()=>{
      for(const loseAt of [1,2,3]){
        const {request}=await reprepare(1,false,false);await remoteAllocatorMigration();const input=await activationRequest(request),history=await entries();let commits=0;
        await assert.rejects(client(db=>{
          const uncertain=new Proxy(db,{get(target,key,receiver){
            if(key==='query')return async(sql:string,params?:unknown[])=>{const result=await target.query(sql,params);if(sql==='COMMIT'&&++commits===loseAt)throw new Error('synthetic COMMIT acknowledgement lost');return result;};
            return Reflect.get(target,key,receiver);
          }});
          return activateReadoption(uncertain,dc,target,input);
        }),/READOPTION_COMMIT_UNKNOWN/);
        const status=await client(db=>readoptionStatus(db,dc,target,source,request.requestId,true));
        assert.equal(status.authority.id_allocator_required,true);assert.equal(status.state,loseAt===3?'active':'activating');
        assert.equal(status.registered,loseAt===1?'0':'1');assert.equal(status.last_error,null);assert.deepEqual(await entries(),history);
        const recovered=await client(db=>activateReadoption(db,dc,target,input,{},true));assert.equal(recovered.state,'active');
        assert.equal((await assignments()).length,1);assert.equal((await local.query('SELECT count(*)::integer n FROM olos_http.corporate_allocator_readoptions')).rows[0].n,1);
      }
    });
    await t.test('failure before the barrier rolls back authority changes; retry captures the exact legacy cutoff',async()=>{
      const {request}=await reprepare(1,false,false);await remoteAllocatorMigration();const input=await activationRequest(request),cursor=(await snapshot()).allocator;
      await assert.rejects(activateReado(input,{beforeBarrierCommit:async()=>{throw new Error('synthetic barrier rollback');}}),/synthetic/);
      assert.equal((await control()).id_allocator_required,false);assert.equal((await client(db=>readoptionStatus(db,dc,target,source,request.requestId))).state,'ready');
      await stage(8996);assert.notDeepEqual((await snapshot()).allocator,cursor);
      assert.equal((await activateReado(input)).registered,'2');assert.deepEqual((await entries()).map(e=>e.target_id),[1,2]);
    });
    await t.test('a fresh collision discovered after the barrier is explicitly quarantined before activation can complete',async()=>{
      const {request}=await reprepare(2,false,false);await remoteAllocatorMigration();const input=await activationRequest(request);
      await assert.rejects(activateReado(input,{afterBarrierCommit:async()=>{await insertRemote(0,{telefone:'late foreign collision'});}}),/INTERNAL_ID_COLLISION/);
      assert.equal((await control()).id_allocator_required,true);assert.equal((await control()).blocked,true);
      const diagnostic=await verify();assert.equal(diagnostic.issues[0]!.code,'INTERNAL_ID_COLLISION');
      await assert.rejects(recover(args(diagnostic.verification_digest)),/READOPTION_ACTIVATION_INCOMPLETE/);
      await quarantine(args(diagnostic.verification_digest));
      assert.equal((await quarantineRuns())[0].readoption_request_id,request.requestId);
      const isolated=await quarantineRows();assert.equal(isolated.length,1);
      await activateReado(input);assert.deepEqual(await quarantineRows(),isolated);assert.equal((await entries())[0].state,'pending');
      const valid=await verify();assert.equal(valid.issues.length,0);await recover(args(valid.verification_digest));await corporateControl(cfg,'corporate-resume');await store!.delivery!.tick();
      assert.equal((await entries())[0].state,'pending');assert.equal((await entries())[1].state,'confirmed');
    });
    await t.test('frozen predecessor, quarantine, assignments and payloads cannot be modified after the barrier',async()=>{
      const {request}=await reprepare(2,true,true);await remoteAllocatorMigration();const input=await activationRequest(request,1);await activateReado(input);
      const history=await entries(),q=await quarantineRows(),reverse=await reversionRuns();
      for(const sql of ["UPDATE olos_http.corporate_outbox SET payload_hash=repeat('f',64)","UPDATE olos_http.records SET target_id=target_id+1000",'DELETE FROM olos_http.corporate_id_assignments',"UPDATE olos_http.corporate_id_reversions SET validation_digest=repeat('f',64)","UPDATE olos_http.corporate_collision_quarantine SET payload_hash=repeat('f',64)","UPDATE olos_http.corporate_readoption_batches SET chain_hash=repeat('f',64)"]){
        await assert.rejects(local.query(sql),/HISTORY_FROZEN|CORPORATE_QUARANTINE_IMMUTABLE/);
      }
      await assert.rejects(local.query('UPDATE olos_http.corporate_control SET id_allocator_generation=NULL,id_allocator_required=false'),/IRREVERSIBLE/);
      await assert.rejects(local.query('DELETE FROM olos_http.corporate_control'),/IRREVERSIBLE/);
      assert.deepEqual(await entries(),history);assert.deepEqual(await quarantineRows(),q);assert.deepEqual(await reversionRuns(),reverse);
      await activateReado({...input,maxBatches:100});
    });
    await t.test('validation rejects forged predecessor validation and altered quarantine before any authority switch',async()=>{
      const {request}=await reprepare(2,true,true);await remoteAllocatorMigration();
      await local.query("UPDATE olos_http.corporate_id_reversions SET validation_digest=repeat('f',64)");
      await assert.rejects(validateReado(request),/REVERSAL_UNVERIFIED/);assert.equal((await control()).id_allocator_required,false);
      await reset(0);const second=await prepare();await reversalMigration();await revert(reversionArgs(second));
      await local.query("UPDATE olos_http.corporate_id_reversions SET validated_at=now(),validation_digest=repeat('a',64)");
      await local.query(await readFile(new URL('../migrations/010_corporate_allocator_readoption.sql',import.meta.url),'utf8'));await activationMigration();
      const fake={source,requestId:randomUUID(),evidence:'FORGED-VALIDATION'};await client(db=>prepareCorporateReadoption(db,fake,dc.binding,target,dc));await remoteAllocatorMigration();
      await assert.rejects(validateReado(fake),/REVERSAL_UNVERIFIED/);assert.equal((await control()).id_allocator_required,false);
    });
    await t.test('confirmed, skipped, quarantined and valid pending history retain IDs and receipts across registration',async()=>{
      const {request}=await reprepare(3,true,true);
      await insertRemote(1);const raw=(await remote.query('SELECT raw_olos_call_id::text FROM raw.olos_calls WHERE internal_id_olos=2')).rows[0].raw_olos_call_id;
      await local.query("UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=$1,confirmed_at=now() WHERE target_id=2",[raw]);
      await local.query("UPDATE olos_http.corporate_outbox SET state='skipped' WHERE target_id=3");
      const history=await entries(),quar=await quarantineRows();await remoteAllocatorMigration();await activateReado(await activationRequest(request));
      assert.deepEqual(await entries(),history);assert.deepEqual(await quarantineRows(),quar);
      assert.deepEqual((await assignments()).map(a=>a.target_id),history.map(e=>e.target_id));
      const journal=(await local.query('SELECT members FROM olos_http.corporate_readoption_batches ORDER BY batch_no')).rows.flatMap(b=>b.members);
      assert.equal(journal.find(m=>m.target_id==='2').state,'confirmed');assert.equal(journal.find(m=>m.target_id==='3').state,'skipped');assert.equal(journal.find(m=>m.target_id==='1').quarantined,true);
    });
    await t.test('new IDs skip occupied corporate identifiers, including sparse high IDs, without altering any sequence',async()=>{
      const {request}=await reprepare(0,false,false);await insertForeign('1');await insertForeign('2');await insertForeign('47561749');
      await remoteAllocatorMigration();const seq=(await snapshot()).allocator;await activateReado(await activationRequest(request));
      await stage(8997);await stage(8998);await store!.delivery!.tick();
      assert.deepEqual((await entries()).map(e=>e.target_id),[3,4]);assert.deepEqual((await snapshot()).allocator,seq);
      const calls=(await remote.query('SELECT internal_id_olos FROM raw.olos_calls ORDER BY internal_id_olos')).rows;assert.deepEqual(calls.map(c=>c.internal_id_olos),[1,2,47561749]);
      await remote.query('UPDATE olos_delivery_ids.counter SET next_candidate=2147483648');await stage(8999);await store!.delivery!.tick();
      assert.equal((await admissions()).filter(a=>!a.materialized).length,1);assert.equal((await entries()).length,2);assert.deepEqual((await snapshot()).allocator,seq);
    });
    await t.test('readoption state/evidence queries are read only and do not require access to corporate credentials',async()=>{
      const {request}=await reprepare(0,false,false);await remoteAllocatorMigration();await activateReado(await activationRequest(request));
      const history=await snapshot();await local.query('SET default_transaction_read_only=on');
      const saved=dc.connection.destinationUrl;dc.connection.destinationUrl='postgresql://postgres@localhost:1/madm';
      try{const result=await client(async db=>{await db.query('SET default_transaction_read_only=on');return readoptionStatus(db,dc,target,source,request.requestId,true);});assert.equal(result.state,'active');assert.equal(result.completed,true);assert.deepEqual(await snapshot(),history);}
      finally{dc.connection.destinationUrl=saved;await local.query('SET default_transaction_read_only=off');}
    });
    await t.test('a lost corporate connection after reservation and a failed batch commit preserve recoverable registration',async()=>{
      const {request}=await reprepare(2,false,false);await remoteAllocatorMigration();const input=await activationRequest(request),history=await entries();
      await assert.rejects(activateReado(input,{afterReserveCommit:async()=>{
        const sessions=(await remote.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE datname='madm' AND application_name='corporate-sync' AND pid<>pg_backend_pid() AND state='idle' AND query='COMMIT'")).rows;
        assert.equal(sessions.length,1);await remote.query('SELECT pg_terminate_backend($1)',[sessions[0]!.pid]);throw new Error('synthetic corporate connection lost');
      }}),/synthetic/);
      const registry=(await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      assert.equal((await assignments()).length,0);assert.equal((await client(db=>readoptionStatus(db,dc,target,source,request.requestId))).registered,'0');
      await assert.rejects(activateReado(input,{beforeBatchCommit:async()=>{throw new Error('synthetic local batch rollback');}}),/synthetic/);
      assert.equal((await assignments()).length,0);assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows,registry);
      await activateReado(input);assert.deepEqual(await entries(),history);assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows,registry);
    });
    await t.test('a restarted capture owner materializes pending reservations idempotently after active-generation connection loss',async()=>{
      const {request}=await reprepare(0,false,false);await remoteAllocatorMigration();await activateReado(await activationRequest(request));await stage(9001);
      const cursor=(await snapshot()).allocator;
      await store!.delivery!.tick({afterReserveCommit:async()=>{throw new Error('synthetic materializer stopped after reservation');}});
      const registry=(await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      assert.equal(registry.length,1);assert.equal((await assignments()).length,0);assert.equal((await admissions())[0].materialized,false);
      await store!.close();store=new Store(cfg);await store.open();await stage(9002);await store.delivery!.tick();
      assert.equal((await entries()).length,2);assert.equal((await admissions()).filter(a=>!a.materialized).length,0);assert.deepEqual((await snapshot()).allocator,cursor);
      assert.deepEqual((await remote.query(`SELECT * FROM olos_delivery_ids.registry WHERE source_id='9001'`)).rows,registry);
    });
    await t.test('checkpoint counters, cutoff and generation identity reject tampering without remapping history',async()=>{
      const {request}=await reprepare(3,false,false);await remoteAllocatorMigration();const input=await activationRequest(request,1);await activateReado(input);
      const before=await entries();
      for(const sql of ["UPDATE olos_http.corporate_allocator_readoptions SET registered_count=999",'UPDATE olos_http.corporate_allocator_readoptions SET registration_end=registration_cursor',"UPDATE olos_http.corporate_allocator_readoptions SET request_id='11111111-1111-4111-8111-111111111111'"]){await assert.rejects(local.query(sql),/REGISTRATION_CHANGED|EVIDENCE_IMMUTABLE/);}
      await activateReado({...input,maxBatches:100});assert.deepEqual(await entries(),before);
    });
    await t.test('the protected CLI prepares, validates, activates, reconciles and reads evidence without taking OLOS ownership',async()=>{
      const {request}=await reprepare(3,false,true);await remoteAllocatorMigration();
      const base=['--confirm-source',source,'--request-id',request.requestId,'--evidence',request.evidence];
      const cli=(command:string,input:string[],authorized=false)=>promisify(execFile)(process.execPath,['dist/main.js',command,...input],{env:{...process.env,...env,...(authorized?{OLOS_CORPORATE_READOPTION_CONFIRMATION:'AUTHORIZE_CORPORATE_ID_READOPTION',OLOS_CORPORATE_READOPTION_ACTIVATION_CONFIRMATION:'AUTHORIZE_CORPORATE_ID_READOPTION_ACTIVATION'}:{})},timeout:15000});
      const cliError=(code:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'stdout' in error&&typeof error.stdout==='string'&&error.stdout.includes(code);
      await assert.rejects(cli('corporate-activate-id-readoption',[...base,'--validation','a'.repeat(64)]),cliError('READOPTION_NOT_AUTHORIZED'));
      const prepared=await cli('corporate-prepare-id-readoption',base,true);assert.match(prepared.stdout,/"state":"prepared"/);
      await cli('corporate-validate-id-readoption',base,true);
      const observed=await cli('corporate-id-readoption-status',base.slice(0,4));
      const report=observed.stdout.trim().split('\n').map(line=>JSON.parse(line) as {validation_digest?:string;state?:string}).find(line=>line.state==='ready');assert(report?.validation_digest);
      const activation=[...base,'--validation',report.validation_digest,'--max-batches','1'];
      await assert.rejects(cli('corporate-activate-id-readoption',activation,true),cliError('READOPTION_ACTIVATION_INCOMPLETE'));
      await stage(9003);
      const recovered=await cli('corporate-reconcile-id-readoption',[...base,'--validation',report.validation_digest,'--max-batches','100'],true);assert.match(recovered.stdout,/"state":"active"/);
      const evidence=await cli('corporate-id-readoption-evidence',base.slice(0,4));assert.match(evidence.stdout,/corporate_readoption_batch_evidence/);assert.doesNotMatch(evidence.stdout,/private-call|private@example|55119000|"token"|"mapped"|"payload"/);
      assert.equal((await admissions()).filter(a=>!a.materialized).length,1);assert.equal((await control()).paused,true);
    });
    await t.test('an incompatible absolute registry contract blocks validation until the reviewed schema is restored',async()=>{
      const {request}=await reprepare(0,false,false);await remoteAllocatorMigration();
      await remote.query("ALTER TABLE olos_delivery_ids.registry DROP CONSTRAINT registry_state_check; ALTER TABLE olos_delivery_ids.registry ADD CONSTRAINT registry_state_check CHECK(state IN ('reserved','used','unexpected'))");
      await assert.rejects(validateReado(request),/ALLOCATOR_CONTRACT_CHANGED/);assert.equal((await control()).id_allocator_required,false);
      await remote.query("ALTER TABLE olos_delivery_ids.registry DROP CONSTRAINT registry_state_check;ALTER TABLE olos_delivery_ids.registry ADD CONSTRAINT registry_state_check CHECK(state IN ('reserved','used'))");
      assert.equal((await validateReado(request)).state,'ready');
    });
    await t.test('validation intent and ready evidence survive lost COMMIT acknowledgements without a new request',async()=>{
      for(const loseAt of [1,2]){
        const {request}=await reprepare(1,false,true);await remoteAllocatorMigration();let commits=0;
        await assert.rejects(client(db=>validateReadoption(new Proxy(db,{get(target,key,receiver){
          if(key==='query')return async(sql:string,params?:unknown[])=>{const result=await target.query(sql,params);if(sql==='COMMIT'&&++commits===loseAt)throw new Error('synthetic validation commit ack lost');return result;};return Reflect.get(target,key,receiver);
        }}),dc,target,request)),/READOPTION_COMMIT_UNKNOWN/);
        const status=await client(db=>readoptionStatus(db,dc,target,source,request.requestId));assert.equal(status.state,loseAt===1?'validating':'ready');assert.equal(status.authority.id_allocator_required,false);
        await validateReado(request);assert.equal((await local.query('SELECT count(*)::integer n FROM olos_http.corporate_allocator_readoptions')).rows[0].n,1);
      }
    });
    await t.test('persisted materialization COMMIT acknowledgement loss never allocates another ID on retry',async()=>{
      const {request}=await reprepare(0,false,false);await remoteAllocatorMigration();await activateReado(await activationRequest(request));await stage(9004);
      const cursor=(await snapshot()).allocator;let fired=false;
      const uncertainPool={async connect(){const db=await pool.connect();return new Proxy(db,{get(target,key,receiver){
        if(key==='query')return async(sql:string,params?:unknown[])=>{const result=await target.query(sql,params);if(sql==='COMMIT'&&!fired){fired=true;throw new Error('synthetic persisted materialization commit');}return result;};return Reflect.get(target,key,receiver);
      }});}} as unknown as pg.Pool;
      const delivery=new CorporateDelivery(dc,source,target,uncertainPool,()=>true,()=>assert.fail('capture authority must remain alive'));
      await delivery.tick();assert(fired);assert.equal((await admissions())[0].materialized,true);assert.equal((await entries()).length,1);
      const registry=(await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows;
      await store!.delivery!.tick();assert.equal((await entries()).length,1);assert.deepEqual((await remote.query('SELECT * FROM olos_delivery_ids.registry ORDER BY internal_id')).rows,registry);assert.deepEqual((await snapshot()).allocator,cursor);
    });
    await t.test('the existing Worker captures over loopback HTTP during activation and MADM outage, then delivers with corporate tokens',async()=>{
      const {request}=await reprepare(1,false,false);await remoteAllocatorMigration();const input=await activationRequest(request);
      let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
      const activation=activateReado(input,{afterBarrierCommit:async()=>{entered();await gate;}});await ready;
      let consuming=0,serverFailure:string|undefined;
      const catalog=[{TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},
        {TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}];
      const server=createServer(async(req,res)=>{
        try{
          const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString('utf8');
          let value:unknown;
          if(req.url==='/api/auth')value={access_token:'synthetic-token',token_type:'bearer',expires_in:3600};
          else if(req.headers.authorization!=='Bearer synthetic-token'){res.writeHead(401);res.end('{}');return;}
          else if(req.url?.endsWith('/available-tables'))value=catalog;
          else if(req.url?.endsWith('/read-data')){
            const table=/name="TableName"\r\n\r\n([^\r]+)/.exec(body)?.[1];
            value=table==='Users'?[{AgentId:'7',UserName:'Private Agent'}]:table==='Campaign'?[{CampaignId:'8',Description:'Campaign'}]:table==='Disposition'?[{DispositionId:'9',Description:'Disposition'}]:undefined;
          }else if(req.url?.endsWith('/read-data-current-day')){consuming++;value=[row(9100+consuming)];}
          if(value===undefined)throw new Error('unrecognized synthetic HTTP request');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
        }catch{serverFailure='synthetic HTTP fixture failure';res.writeHead(500);res.end('{}');}
      });
      server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
      const abort=new AbortController(),transport=new HttpTransport(`http://127.0.0.1:${address.port}`,1000,1048576,abort.signal);
      const auth=new OlosAuthManager(transport.request,{username:'fixture',password:'fixture',clientId:'fixture',clientSecret:'fixture'});
      const api=new OlosApi(transport.request,auth),worker=new Worker(store!,api,new StaticCache(api,3600000));
      const cursor=(await snapshot()).allocator,saved=dc.connection.destinationUrl;
      try{
        const first=await worker.cycle();await store!.delivery!.settle();assert.equal(first.queued,1);assert.equal(consuming,1);assert.equal((await admissions()).filter(a=>!a.materialized).length,1);
        release();await activation;
        dc.connection.destinationUrl='postgresql://postgres@localhost:1/madm';const second=await worker.cycle();await store!.delivery!.settle();assert.equal(second.queued,1);assert.equal(consuming,2);
        assert.equal((await admissions()).filter(a=>!a.materialized).length,2);assert.deepEqual((await snapshot()).allocator,cursor);
        dc.connection.destinationUrl=saved;await store!.delivery!.tick();await corporateControl(cfg,'corporate-resume');await store!.delivery!.tick();await store!.delivery!.tick();
        assert.equal((await entries()).filter(e=>e.state==='confirmed').length,3);assert.equal((await assignments()).filter(a=>!a.legacy&&a.token).length,2);assert.equal(serverFailure,undefined);
        const captures=(await local.query("SELECT state,processed_count FROM olos_http.reads WHERE spec->>'kind'='current' ORDER BY started_at DESC LIMIT 2")).rows;
        assert(captures.every(r=>r.state==='done'&&r.processed_count===1));assert.deepEqual((await snapshot()).allocator,cursor);
      }finally{dc.connection.destinationUrl=saved;release();await activation;abort.abort();await transport.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    });
    await t.test('dedicated authority fence does not make legacy or active capture wait on an in-flight delivery transaction',async()=>{
      const {request}=await reprepare(1,false,false);await corporateControl(cfg,'corporate-resume');
      async function concurrentCapture(id:number){
        let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
        const sending=store!.delivery!.tick({afterRemoteCommit:async()=>{entered();await gate;}});await ready;
        try{const start=performance.now();await stage(id);assert(performance.now()-start<750);}
        finally{release();await sending;}
      }
      await concurrentCapture(9110);assert.equal((await entries()).length,2);assert.equal((await entries())[0].state,'confirmed');
      await corporateControl(cfg,'corporate-pause');await remoteAllocatorMigration();await activateReado(await activationRequest(request));await corporateControl(cfg,'corporate-resume');
      const seq=(await snapshot()).allocator;await concurrentCapture(9111);assert.equal((await admissions()).filter(a=>!a.materialized).length,1);assert.deepEqual((await snapshot()).allocator,seq);
      await store!.delivery!.tick();assert.equal((await entries()).filter(e=>e.state==='confirmed').length,3);assert.deepEqual((await snapshot()).allocator,seq);
    });
    await t.test('corporate reservation skips a dense occupied prefix in one bounded attempt using the registry gap',async()=>{
      const {request}=await reprepare(0,false,false);
      await remote.query('INSERT INTO raw.olos_calls(internal_id_olos) SELECT n FROM generate_series(1,50000) n');
      await remoteAllocatorMigration();await activateReado(await activationRequest(request));const seq=(await snapshot()).allocator;
      await stage(9112);const started=performance.now();await store!.delivery!.tick();
      assert.equal((await admissions()).filter(a=>!a.materialized).length,0);assert.equal((await entries())[0].target_id,50001);
      assert.deepEqual((await snapshot()).allocator,seq);
      console.log('CORPORATE_ALLOCATOR_GAP_EVIDENCE '+JSON.stringify({synthetic:true,occupied_prefix:50000,reserved_id:50001,allocation_ms:performance.now()-started}));
    });
    await t.test('a non-owner local administrative role activates with reviewed grants and cannot disable the authority barrier',async()=>{
      const {request}=await reprepare(2,false,false);await remoteAllocatorMigration();
      await local.query('CREATE ROLE readoption_local_client NOLOGIN');
      await local.query(`GRANT USAGE ON SCHEMA raw,olos_http,corporate_sync TO readoption_local_client;
        GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA olos_http,corporate_sync TO readoption_local_client;
        REVOKE INSERT,UPDATE ON olos_http.corporate_readoption_schema FROM readoption_local_client;
        REVOKE UPDATE ON olos_http.corporate_readoption_batches FROM readoption_local_client;
        GRANT SELECT ON raw.olos_calls TO readoption_local_client`);
      try{
        await client(async db=>{
          await db.query('SET ROLE readoption_local_client');
          assert.equal((await db.query('SELECT current_user')).rows[0].current_user,'readoption_local_client');
          await validateReadoption(db,dc,target,request);
          const status=await readoptionStatus(db,dc,target,source,request.requestId);
          const activation={...request,validation:status.validation_digest!,maxBatches:10};
          assert.equal((await activateReadoption(db,dc,target,activation)).state,'active');
          await assert.rejects(db.query('ALTER TABLE olos_http.records DISABLE TRIGGER corporate_readoption_record_fence'),
            (error:unknown)=>(error as {code?:string}).code==='42501');
          await assert.rejects(db.query('UPDATE olos_http.corporate_allocation_fence SET required=false,epoch=epoch+1'),/AUTHORITY_IRREVERSIBLE/);
          assert.equal((await readoptionStatus(db,dc,target,source,request.requestId)).completed,true);
        });
        const sequence=(await snapshot()).allocator;await stage(98002);await store!.delivery!.tick();
        assert.deepEqual((await snapshot()).allocator,sequence);
        assert.equal((await assignments()).find(a=>a.source_id==='98002')?.legacy,false);
      }finally{await local.query('DROP OWNED BY readoption_local_client; DROP ROLE readoption_local_client');}
    });
    await t.test('readoption rejects a changed deferred assignment function before authorizing the barrier',async()=>{
      const {request}=await reprepare(1,false,false);await remoteAllocatorMigration();
      const definition=(await local.query("SELECT pg_get_functiondef('olos_http.require_corporate_id_assignment()'::regprocedure) AS definition")).rows[0].definition as string;
      try{
        await local.query(`CREATE OR REPLACE FUNCTION olos_http.require_corporate_id_assignment() RETURNS trigger LANGUAGE plpgsql AS $broken$ BEGIN RETURN NEW; END $broken$`);
        await assert.rejects(validateReado(request),/READOPTION_LOCAL_CONTRACT_CHANGED/);
        assert.equal((await control()).id_allocator_required,false);
        assert.equal((await local.query('SELECT state FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1',[request.requestId])).rows[0].state,'prepared');
      }finally{await local.query(definition);}
      assert.equal((await validateReado(request)).state,'ready');
    });
    await t.test('migration 011 refuses an unknown state CHECK without dropping integrity constraints or changing evidence',async()=>{
      const {request}=await reprepare(1,false,false);
      await local.query("ALTER TABLE olos_http.corporate_allocator_readoptions ADD CONSTRAINT separately_reviewed_state_guard CHECK(state<>'aborted')");
      const before=(await local.query('SELECT * FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1',[request.requestId])).rows;
      await assert.rejects(activationMigration(),/READOPTION_LOCAL_CONTRACT_CHANGED/);await local.query('ROLLBACK');
      assert.equal((await local.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='olos_http.corporate_allocator_readoptions'::regclass AND conname='separately_reviewed_state_guard'")).rows[0].n,1);
      assert.deepEqual((await local.query('SELECT * FROM olos_http.corporate_allocator_readoptions WHERE request_id=$1',[request.requestId])).rows,before);
      assert.equal((await control()).id_allocator_required,false);
      await local.query('ALTER TABLE olos_http.corporate_allocator_readoptions DROP CONSTRAINT separately_reviewed_state_guard');
      await local.query("ALTER TABLE olos_http.corporate_allocator_readoptions DROP CONSTRAINT readoption_state_check, ADD CONSTRAINT readoption_state_check CHECK(state<>'aborted')");
      await assert.rejects(activationMigration(),/READOPTION_LOCAL_CONTRACT_CHANGED/);await local.query('ROLLBACK');
      assert.equal((await control()).id_allocator_required,false);
      await local.query("ALTER TABLE olos_http.corporate_allocator_readoptions DROP CONSTRAINT readoption_state_check, ADD CONSTRAINT readoption_state_check CHECK(state IN ('prepared','validating','ready','activating','active','aborted'))");
      await activationMigration();
    });
    await t.test('corporate installation times out atomically behind an existing writer and preserves calls before retry',async()=>{
      await reset(1);await insertRemote(0);
      const before=(await remote.query('SELECT * FROM raw.olos_calls')).rows;
      const writer=new pg.Client({connectionString:destinationUrl.toString()});await writer.connect();
      try{
        await writer.query('BEGIN');await writer.query('LOCK TABLE raw.olos_calls IN ROW EXCLUSIVE MODE');
        await assert.rejects(remoteAllocatorMigration(),(error:unknown)=>(error as {code?:string}).code==='55P03');
        await remote.query('ROLLBACK');
        assert.equal((await remote.query("SELECT to_regnamespace('olos_delivery_ids') IS NULL AS absent")).rows[0].absent,true);
        assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls')).rows,before);
        await writer.query('ROLLBACK');await remoteAllocatorMigration();
        assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls')).rows,before);
        assert.equal((await remote.query("SELECT count(*)::int n FROM olos_delivery_ids.registry WHERE state='used'")).rows[0].n,1);
      }finally{await writer.query('ROLLBACK');await writer.end();}
    });
    await t.test('audit migration can be reapplied without changing the queue or evidence', async () => {
      await reset(1); await recover(args((await verify()).verification_digest)); const before = await snapshot();
      await local.query(await readFile(new URL('../migrations/006_corporate_collision_recovery.sql', import.meta.url), 'utf8'));
      assert.equal(await evidenceCount(), 1); assert.deepEqual(await snapshot(), before);
    });
  } finally { await store?.close(); await pool.end(); await local.end(); await remote.end(); }
});
