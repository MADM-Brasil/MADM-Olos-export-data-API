import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config, type Config } from '../src/config.js';
import { Store } from '../src/store.js';
import { AdminRepository } from '../src/admin/repository.js';
import { Worker } from '../src/worker.js';
import { OlosApi } from '../src/api.js';
import { OlosAuthManager } from '../src/auth.js';
import { StaticCache } from '../src/cache.js';
import { DynamicScheduler, type ScheduledConsumer } from '../src/scheduler.js';
import type { SchedulerRepository, Settings } from '../src/admin/repository.js';
import { columns, digest, mapRow, projection, type Row } from '../src/corporate-sync/mapping.js';
import { operatorAdmin, type OperatorRequest } from '../src/corporate-delivery/operator-admin.js';
import { deliveryDigest } from '../src/corporate-delivery/payload.js';
import { operatorComplementProposal } from '../src/corporate-delivery/operator-complement.js';
import { corporateSchema } from '../src/corporate-delivery/contract.js';
import { assertNoDirectOwnership } from '../src/corporate-sync/ownership.js';
import { selectiveCommitBlock } from '../src/corporate-delivery/selective-commit.js';
import type { DeliveryHooks } from '../src/corporate-delivery/delivery.js';
import { corporateControl } from '../src/corporate-delivery/commands.js';
import { SyncError } from '../src/corporate-sync/errors.js';
import { fixture } from './corporate-sync.fixture.js';
import { HttpError, WorkerError } from '../src/errors.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const enabled = process.env.OLOS_DIRECT_DISPOSABLE_TEST === 'true';
const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await pause(); }
  throw new Error('Synthetic test condition timed out');
}
const legacyBinding = 'a'.repeat(64);
const cache = { users: new Map([['7','Agent']]), campaigns: new Map([['8','Campaign']]), dispositions: new Map([['9','Disposition']]) };
function record(id: number, extra: Record<string, unknown> = {}) {
  return { AttemptsRawDataID: String(id), CallId: 'repeated-call-id', AgentId: '7', CampaignId: '8', DispositionId: '9',
    StartDate: '2026-10-01T10:00:00.000000-03:00', EndWrap: '2026-10-01T10:00:00.400000-03:00',
    OriginalPhoneNumber: String(id).padStart(11, '0'), ...extra };
}

test('direct corporate delivery in disposable PostgreSQL with verified TLS', { skip: !enabled }, async t => {
  const localUrl = new URL(process.env.OLOS_DIRECT_TEST_SOURCE_URL ?? '');
  const remoteUrl = new URL(process.env.OLOS_DIRECT_TEST_DESTINATION_URL ?? '');
  assert.equal(localUrl.hostname, '127.0.0.1'); assert.equal(localUrl.pathname, '/olos_direct_test');
  assert.equal(remoteUrl.hostname, 'localhost'); assert.equal(remoteUrl.pathname, '/madm');
  assert.equal(localUrl.username, 'postgres'); assert.equal(remoteUrl.username, 'postgres');
  const local = new pg.Client({ connectionString: localUrl.toString() });
  const remote = new pg.Client({ connectionString: remoteUrl.toString() });
  await local.connect(); await remote.connect();
  const stores: Store[] = [];
  const base = { DATABASE_URL: localUrl.toString(), OLOS_SOURCE_KEY: 'synthetic-direct', SOURCE_ID_UNIQUENESS_CONFIRMED: 'true', BATCH_SIZE: '500' };
  const makeConfig = (count = 2, extra: NodeJS.ProcessEnv = {}): Config => config({ ...base,
    ATTEMPTS_PERSISTENCE_MODE: 'corporate', OLOS_CORPORATE_DATABASE_URL: remoteUrl.toString(),
    OLOS_CORPORATE_CA_FILE: process.env.OLOS_DIRECT_TEST_CA_FILE!,
    OLOS_CORPORATE_WRITE_ENABLED: 'true', OLOS_CORPORATE_WRITE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY',
    OLOS_CORPORATE_RECONCILE_CONFIRMATION: 'AUTHORIZE_CORPORATE_STATE_RECONCILIATION',
    OLOS_CORPORATE_LEGACY_BINDING: legacyBinding, OLOS_CORPORATE_LEGACY_EXPECTED_COUNT: String(count),
    OLOS_CORPORATE_BATCH_SIZE: '500', OLOS_CORPORATE_BACKOFF_MS: '1', OLOS_CORPORATE_TIMEOUT_MS: '2000', ...extra });
  async function open(cfg = makeConfig()) { const s = new Store(cfg); stores.push(s); await s.open(); return s; }
  async function close(s: Store) { stores.splice(stores.indexOf(s), 1); await s.close(); }
  async function stage(s: Store, rows: unknown[]) {
    const id = await s.beginRead({ kind: 'current' }); await s.stage(id, JSON.stringify(rows), 1);
    return s.drain(cache);
  }
  async function count(db: pg.Client, table: string): Promise<number> { return Number((await db.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n); }
  async function reset(n = 2) {
    for (const s of stores.splice(0)) await s.close().catch(() => {});
    await local.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS olos_http CASCADE; DROP SCHEMA IF EXISTS corporate_sync CASCADE; DROP SCHEMA IF EXISTS olos_billing CASCADE');
    await remote.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE');
    await local.query(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8'));
    await local.query(await readFile(new URL('../migrations/001_ingestion.sql', import.meta.url), 'utf8'));
    await local.query(await readFile(new URL('../migrations/corporate-sync/001_control.sql', import.meta.url), 'utf8'));
    await local.query(await readFile(new URL('../migrations/002_corporate_delivery.sql', import.meta.url), 'utf8'));
    await remote.query(fixture(false));
    await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN raw_olos_call_id RESTART WITH 8000000000');
    const legacy = new Store(config(base)); await legacy.open();
    const input = Array.from({ length: n }, (_, i) => record(100001 + i));
    const id = await legacy.beginRead({ kind: 'current' }); await legacy.stage(id, JSON.stringify(input), 1);
    await legacy.drain(cache); await legacy.close();
    const cfg = makeConfig(n), { shape } = await corporateSchema(remote, cfg.corporateDelivery!, false);
    const p = projection(shape, 's', true, cfg.corporateDelivery!.connection);
    const rows: Row[] = (await local.query(`SELECT ${p.sql} FROM raw.olos_calls s ORDER BY internal_id_olos`, p.parameters)).rows.map(raw => mapRow(raw, shape, cfg.corporateDelivery!.connection));
    for (let offset = 0; offset < rows.length; offset += 1000) {
      const batch = rows.slice(offset, offset + 1000);
      const definitions = columns.map(name => `${name} ${shape.get(name)!.type}`).join(',');
      await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) SELECT ${columns.join(',')} FROM jsonb_to_recordset($1::jsonb) AS x(${definitions})`, [JSON.stringify(batch)]);
      await local.query(`INSERT INTO corporate_sync.receipts(internal_id_olos,payload_hash)
        SELECT id,hash FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,hash text)`, [JSON.stringify(batch.map(row => ({ id: row.internal_id_olos, hash: digest(row) })))]);
    }
    await local.query('INSERT INTO corporate_sync.control(singleton,binding,confirmed_count) VALUES(true,$1,$2)', [legacyBinding, n]);
    return cfg;
  }
  async function ready(cfg = makeConfig()) { const s = await open(cfg); await s.reconcileCorporate(); await s.delivery!.resume(s.client!); return s; }
  async function destinationCount() { return count(remote, 'raw.olos_calls'); }
  async function pausedQueue(n = 7) {
    await reset();
    const cfg = makeConfig(2, { OLOS_CORPORATE_WRITE_ENABLED: 'false' });
    const s = await open(cfg); await s.reconcileCorporate();
    await stage(s, Array.from({ length: n }, (_, i) => record(900001 + i)));
    await close(s); return cfg;
  }
  const control = async () => (await local.query('SELECT * FROM olos_http.corporate_control')).rows[0];
  const outbox = async () => (await local.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows;
  const historyCatalog = [
    { TableName: 'AttemptsRawData', Columns: ['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId'] },
    { TableName: 'Users', Columns: ['AgentId','UserName'] }, { TableName: 'Campaign', Columns: ['CampaignId','Description'] },
    { TableName: 'Disposition', Columns: ['DispositionId','Description'] },
  ];
  async function historyConfig() {
    const cfg = await pausedQueue(0);
    await local.query(await readFile(new URL('../admin/migrations/002_worker_administration.sql', import.meta.url), 'utf8'));
    const admin = new AdminRepository(localUrl.toString(), base.OLOS_SOURCE_KEY);
    try { await admin.open(120000, 'STOPPED'); } finally { await admin.close(); }
    return { ...cfg, historyCaptureAuthorized: true, ingestionBaseline: '2026-10-28T14:42:14Z', sourceTimeZone: 'America/Sao_Paulo' };
  }
  function historyWorker(s: Store, response: () => Promise<string>) {
    const auth = new OlosAuthManager(async () => JSON.stringify({ access_token: 'synthetic', expires_in: 3600, token_type: 'bearer' }),
      { username: 'synthetic', password: 'synthetic', clientId: 'synthetic', clientSecret: 'synthetic' });
    const api = new OlosApi(async path => {
      if (path.endsWith('/available-tables')) return JSON.stringify(historyCatalog);
      if (path.endsWith('/read-data')) return '[]';
      if (path.endsWith('/read-data-previous-days')) return response();
      throw new Error('Unexpected synthetic API request');
    }, auth, async () => {});
    return new Worker(s, api, new StaticCache(api, 3600000));
  }
  try {
    await t.test('history anterior ao baseline entra na outbox sem entrega, preserva recibos e mantém current/previous', async () => {
      const cfg = await historyConfig(), s = await open(cfg);
      const before = await outbox(), state = await control();
      const receipts = (await local.query('SELECT * FROM corporate_sync.receipts ORDER BY internal_id_olos')).rows;
      const remoteBefore = (await remote.query('SELECT * FROM raw.olos_calls ORDER BY internal_id_olos')).rows;
      const old = record(301, { StartDate: '2026-09-15T10:00:00-03:00', EndWrap: '2026-09-15T10:00:00.4-03:00' });
      let requests = 0, kicks = 0;
      s.delivery!.kick = () => { kicks++; };
      const worker = historyWorker(s, async () => {
        requests++;
        const pending = await s.unresolved(); assert.equal(pending.length, 1); assert.equal(pending[0]!.state, 'reading');
        assert.equal(pending[0]!.spec.kind, 'history');
        return JSON.stringify([old, record(302), old, record(100001)]);
      });
      const result = await worker.cycle({ kind: 'history' });
      assert.equal(requests, 1); assert.equal(kicks, 0); assert.equal(result.queued, 2); assert.equal(result.duplicates, 2);
      const after = await outbox(); assert.deepEqual(after.slice(0,2), before);
      assert.equal(after.filter(r => r.state === 'pending').length, 2);
      assert.deepEqual((await local.query('SELECT * FROM corporate_sync.receipts ORDER BY internal_id_olos')).rows, receipts);
      assert.deepEqual(await control(), state);
      assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls ORDER BY internal_id_olos')).rows, remoteBefore);
      assert.equal(await count(local,'raw.olos_calls'), 2);
      const saved = (await local.query('SELECT spec,state,processed_count,response_body FROM olos_http.reads WHERE id=$1',[result.read_id])).rows[0];
      assert.equal(saved.spec.kind, 'history'); assert.equal(saved.state, 'done'); assert.equal(saved.processed_count, 4); assert.ok(saved.response_body);
      for (const kind of ['current','previous'] as const) {
        const id = await s.beginRead({ kind });
        await s.stage(id, JSON.stringify([record(kind === 'current' ? 304 : 305)]), 1);
        assert.equal((await s.drain(cache)).queued, 0);
      }
      assert.equal((await outbox()).length, 4);
    });
    await t.test('history recupera received após commit parcial sem autorização de novo consumo e sem reaplicar baseline', async () => {
      const cfg = { ...await historyConfig(), batchSize: 1 }, first = await open(cfg);
      const id = await first.beginRead({ kind: 'history' });
      await first.stage(id, JSON.stringify([record(401),record(402)]), 1);
      await local.query("ALTER TABLE olos_http.corporate_outbox ADD CONSTRAINT synthetic_failure CHECK (source_id <> '402')");
      await assert.rejects(first.drain(cache));
      assert.equal((await local.query('SELECT processed_count FROM olos_http.reads WHERE id=$1',[id])).rows[0].processed_count, 1);
      assert.equal((await first.unresolved())[0]!.state, 'received');
      const committed = (await outbox()).find(r => r.source_id === '401');
      await close(first);
      await assert.rejects(corporateControl(makeConfig(), 'corporate-resume'), /HISTORY_RECOVERY_REQUIRED/);
      await local.query('ALTER TABLE olos_http.corporate_outbox DROP CONSTRAINT synthetic_failure');
      const resumed = await open({ ...cfg, historyCaptureAuthorized: false });
      await assert.rejects(historyWorker(resumed, async () => { throw new Error('must not consume'); }).cycle(), /HISTORY_RECOVERY_REQUIRED/);
      const result = await resumed.drain(cache);
      assert.equal(result.queued, 1); assert.equal((await resumed.unresolved()).length, 0);
      assert.deepEqual((await outbox()).find(r => r.source_id === '401'), committed);
      assert.equal((await outbox()).filter(r => r.state === 'pending').length, 2);
      assert.equal(await destinationCount(), 2); assert.equal((await control()).paused, true);
    });
    await t.test('history divergente anterior ao baseline não é descartado nem sobrescreve comprovante conciliado', async () => {
      const cfg = await historyConfig(), s = await open(cfg), before = await outbox();
      const records = (await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows;
      let requests = 0;
      const worker = historyWorker(s, async () => {
        requests++;
        return JSON.stringify([record(100001,{ CallId: 'divergent-synthetic-call' }),record(601)]);
      });
      await assert.rejects(worker.cycle({ kind: 'history' }), /RECOVERY_REQUIRED/);
      assert.equal(requests, 1); assert.deepEqual(await outbox(), before);
      assert.deepEqual((await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows, records);
      const read = (await s.unresolved())[0]!;
      assert.equal(read.state, 'received'); assert.equal(read.processed_count, 0);
      assert.equal((await local.query('SELECT error_code FROM olos_http.reads WHERE id=$1',[read.id])).rows[0].error_code, 'SOURCE_ID_CONTENT_CONFLICT');
      assert.equal(await destinationCount(), 2);
    });
    await t.test('history valida estado e intenção atomicamente e bloqueia resume durante autenticação e resposta', async () => {
      const cfg = await historyConfig(), s = await open(cfg);
      await s.assertHistoryReady();
      await assert.rejects(corporateControl(makeConfig(), 'corporate-resume'), /HISTORY_CAPTURE_ACTIVE/);
      const original = s.beginRead.bind(s); let requests = 0;
      s.beginRead = async (...args) => {
        await local.query('UPDATE olos_http.corporate_control SET paused=false');
        return original(...args);
      };
      const worker = historyWorker(s, async () => { requests++; return '[]'; });
      await assert.rejects(worker.cycle({ kind: 'history' }), /HISTORY_CORPORATE_STATE_INVALID/);
      assert.equal(requests, 0); assert.equal((await s.unresolved()).length, 0);
      s.beginRead = original;
      await local.query('UPDATE olos_http.corporate_control SET paused=true');
      const query = s.client!.query.bind(s.client!);
      s.client!.query = (async (sql: any, values?: any) => {
        if (typeof sql === 'string' && sql.startsWith('INSERT INTO olos_http.reads')) {
          await local.query("SET lock_timeout='50ms'");
          try {
            await assert.rejects(local.query('UPDATE olos_http.corporate_control SET paused=false'), (e: any) => e.code === '55P03');
            await assert.rejects(local.query("UPDATE olos_http.worker_settings SET desired_state='RUNNING',enabled=true"), (e: any) => e.code === '55P03');
          } finally { await local.query('SET lock_timeout=0'); }
        }
        return query(sql,values);
      }) as pg.PoolClient['query'];
      const result = await historyWorker(s, async () => {
        await assert.rejects(corporateControl(makeConfig(), 'corporate-resume'), /HISTORY_CAPTURE_ACTIVE/);
        requests++; return '[]';
      }).cycle({ kind: 'history' });
      s.client!.query = query;
      assert.equal(result.received, 0); assert.equal(requests, 1); assert.equal((await s.unresolved()).length, 0);
      assert.equal((await control()).paused, true);
    });
    await t.test('history 401/429/timeout/incompleta mantém evidência e bloqueia consumo depois de reinício', async () => {
      for (const failure of ['401','429','timeout','incomplete','stage-ack'] as const) {
        const cfg = await historyConfig(); let s = await open(cfg), requests = 0;
        if (failure === 'stage-ack') {
          const stageResponse = s.stage.bind(s);
          s.stage = async (...args) => { await stageResponse(...args); throw new Error('synthetic lost local acknowledgement'); };
        }
        const worker = historyWorker(s, async () => {
          requests++;
          if (failure === '401' || failure === '429') throw new HttpError(Number(failure));
          if (failure === 'timeout') throw new WorkerError('NETWORK_OR_RESPONSE_FAILURE',true);
          return failure === 'incomplete' ? '[{"AttemptsRawDataID":' : JSON.stringify([record(501)]);
        });
        await assert.rejects(worker.cycle({ kind: 'history' }), /RECOVERY_REQUIRED/);
        const pending = (await s.unresolved())[0]!;
        assert.equal(pending.state, ['incomplete','stage-ack'].includes(failure) ? 'received' : 'reading');
        assert.equal(requests, 1); await close(s); s = await open(cfg);
        await assert.rejects(historyWorker(s, async () => { requests++; return '[]'; }).cycle({ kind: 'history' }), /HISTORY_RECOVERY_REQUIRED/);
        assert.equal(requests, 1);
        if (failure === 'stage-ack') { assert.equal((await s.drain(cache)).queued, 1); }
        else await assert.rejects(s.drain(cache), failure === 'incomplete' ? /JSON_INVALID/ : /HISTORY_RECOVERY_REQUIRED/);
        assert.equal(await destinationCount(), 2); assert.equal((await control()).paused, true);
      }
    });
    await t.test('history bloqueia enabled/runtime e escrita corporativa sem admitir entrega no finally', async () => {
      const cfg = await historyConfig(), s = await open(cfg);
      let requests = 0, kicks = 0; s.delivery!.kick = () => { kicks++; };
      const worker = historyWorker(s, async () => { requests++; return '[]'; });
      for (const change of ["enabled=true,desired_state='RUNNING'", "runtime_state='RUNNING'", "desired_state='PAUSED'", "runtime_state='PAUSED'"]) {
        await local.query(`UPDATE olos_http.worker_settings SET ${change}`);
        await assert.rejects(worker.cycle({ kind: 'history' }), /HISTORY_SCHEDULER_NOT_STOPPED/);
        await local.query("UPDATE olos_http.worker_settings SET enabled=false,desired_state='STOPPED',runtime_state='STOPPED'");
      }
      s.cfg.corporateDelivery!.connection.writeEnabled = true;
      await assert.rejects(worker.cycle({ kind: 'history' }), /HISTORY_REQUIRES_CORPORATE_WRITE_DISABLED/);
      assert.equal(requests, 0); assert.equal(kicks, 0); assert.equal((await s.unresolved()).length, 0);
      assert.equal(await destinationCount(), 2);
    });
    await t.test('history CLI usa HTTP simulado, preserva resposta antes de falha local e recover-local não consome novamente', async () => {
      await historyConfig();
      await local.query("ALTER TABLE olos_http.corporate_outbox ADD CONSTRAINT synthetic_cli_failure CHECK (source_id <> '801')");
      let requests = 0, fields = '';
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
          if (request.url === '/api/auth') response.end(JSON.stringify({ access_token: 'synthetic', expires_in: 3600, token_type: 'bearer' }));
          else if (request.url?.endsWith('/available-tables')) response.end(JSON.stringify(historyCatalog));
          else if (request.url?.endsWith('/read-data')) response.end('[]');
          else if (request.url?.endsWith('/read-data-previous-days')) { requests++; fields = Buffer.concat(chunks).toString(); response.end(JSON.stringify([record(801)])); }
          else { response.writeHead(500); response.end(); }
        });
      });
      await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
      const env = { ...base, ATTEMPTS_PERSISTENCE_MODE: 'corporate',
        OLOS_CORPORATE_DATABASE_URL: remoteUrl.toString(), OLOS_CORPORATE_CA_FILE: process.env.OLOS_DIRECT_TEST_CA_FILE!,
        OLOS_CORPORATE_WRITE_ENABLED: 'false', SOURCE_TIME_ZONE: 'America/Sao_Paulo', INGESTION_BASELINE: '2026-10-28T14:42:14Z',
        OLOS_HISTORY_CAPTURE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_HISTORY_CAPTURE',
        OLOS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        OLOS_USERNAME: 'synthetic', OLOS_PASSWORD: 'synthetic', OLOS_CLIENT_ID: 'synthetic', OLOS_CLIENT_SECRET: 'synthetic' };
      const cli = (command: string, extra: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath, ['dist/main.js',command], { env: { ...env,...extra }, timeout: 15000 });
      try {
        await assert.rejects(cli('capture-history'), (e: any) => e.code === 1 && e.stdout.includes('RECOVERY_REQUIRED'));
        assert.equal(requests, 1); assert.match(fields,/TableName/); assert.doesNotMatch(fields,/DateExport|PKIDStart|PKIDEnd/);
        const saved = (await local.query("SELECT * FROM olos_http.reads WHERE spec->>'kind'='history'")).rows[0];
        assert.equal(saved.state, 'received'); assert.equal(saved.response_body, JSON.stringify([record(801)]));
        await assert.rejects(cli('capture-history'), (e: any) => e.code === 1 && e.stdout.includes('HISTORY_RECOVERY_REQUIRED'));
        await local.query('ALTER TABLE olos_http.corporate_outbox DROP CONSTRAINT synthetic_cli_failure');
        await cli('recover-local', { OLOS_HISTORY_CAPTURE_CONFIRMATION: '' });
        assert.equal(requests, 1);
        assert.equal((await local.query('SELECT state FROM olos_http.reads WHERE id=$1',[saved.id])).rows[0].state, 'done');
        assert.equal((await outbox()).find(r => r.source_id === '801').state, 'pending');
        assert.equal((await control()).paused, true); assert.equal(await destinationCount(), 2);
        const admin = new AdminRepository(localUrl.toString(),base.OLOS_SOURCE_KEY);
        try { await admin.open(120000,'STOPPED'); } finally { await admin.close(); }
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    await t.test('history perda de sessão depois da intenção impede POST e mantém reading para reconciliação', async () => {
      const cfg = await historyConfig(); let s = await open(cfg), requests = 0;
      const begin = s.beginRead.bind(s);
      s.beginRead = async (...args) => {
        const id = await begin(...args);
        const pid = (await s.client!.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await local.query('SELECT pg_terminate_backend($1)',[pid]);
        await pause(20); return id;
      };
      await assert.rejects(historyWorker(s,async () => { requests++; return '[]'; }).cycle({ kind: 'history' }),/RECOVERY_REQUIRED/);
      await close(s); s = await open(cfg);
      assert.equal(requests, 0); assert.equal((await s.unresolved())[0]!.state, 'reading');
      await assert.rejects(historyWorker(s,async () => { requests++; return '[]'; }).cycle({ kind: 'history' }),/HISTORY_RECOVERY_REQUIRED/);
      assert.equal(requests, 0); assert.equal(await destinationCount(), 2);
    });
    await t.test('history timeout HTTP e SIGTERM preservam intenção, não repetem POST e liberam locks', async () => {
      for (const mode of ['timeout','signal'] as const) {
        await historyConfig(); let requests = 0, received!: () => void;
        const consuming = new Promise<void>(resolve => { received = resolve; });
        const server = createServer((request,response) => {
          request.resume();
          request.on('end', () => {
            if (request.url === '/api/auth') response.end(JSON.stringify({ access_token: 'synthetic', expires_in: 3600, token_type: 'bearer' }));
            else if (request.url?.endsWith('/available-tables')) response.end(JSON.stringify(historyCatalog));
            else if (request.url?.endsWith('/read-data')) response.end('[]');
            else if (request.url?.endsWith('/read-data-previous-days')) { requests++; response.write('['); received(); }
            else { response.writeHead(500); response.end(); }
          });
        });
        await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
        const env = { ...base, ATTEMPTS_PERSISTENCE_MODE: 'corporate',
          OLOS_CORPORATE_DATABASE_URL: remoteUrl.toString(), OLOS_CORPORATE_CA_FILE: process.env.OLOS_DIRECT_TEST_CA_FILE!,
          OLOS_CORPORATE_WRITE_ENABLED: 'false', HTTP_TIMEOUT_MS: '1000',
          OLOS_HISTORY_CAPTURE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_HISTORY_CAPTURE',
          OLOS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          OLOS_USERNAME: 'synthetic', OLOS_PASSWORD: 'synthetic', OLOS_CLIENT_ID: 'synthetic', OLOS_CLIENT_SECRET: 'synthetic' };
        const cli = () => promisify(execFile)(process.execPath,['dist/main.js','capture-history'],{ env,timeout:15000 });
        try {
          const running = cli();
          const failed = assert.rejects(running,(e: any) => e.code === 1 && e.stdout.includes('RECOVERY_REQUIRED'));
          if (mode === 'signal') { await consuming; running.child.kill('SIGTERM'); }
          await failed;
          assert.equal(requests, 1);
          const rows = (await local.query("SELECT state,response_body FROM olos_http.reads WHERE spec->>'kind'='history'")).rows;
          assert.deepEqual(rows, [{ state: 'reading', response_body: null }]);
          await assert.rejects(cli(), (e: any) => e.code === 1 && e.stdout.includes('HISTORY_RECOVERY_REQUIRED'));
          assert.equal(requests, 1); assert.equal((await outbox()).length, 2);
          assert.equal((await control()).paused, true); assert.equal(await destinationCount(), 2);
          assert.equal((await local.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [`olos-http:history:${base.OLOS_SOURCE_KEY}`])).rows[0].ok,true);
          await local.query('SELECT pg_advisory_unlock_all()');
          const admin = new AdminRepository(localUrl.toString(),base.OLOS_SOURCE_KEY);
          try { await admin.open(120000,'STOPPED'); } finally { await admin.close(); }
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      }
    });
    await t.test('history exige exclusividade com o Admin', async () => {
      const cfg = await pausedQueue();

      await local.query(await readFile(
        new URL('../admin/migrations/002_worker_administration.sql', import.meta.url),
        'utf8'
      ));

      const admin = new AdminRepository(localUrl.toString(), 'synthetic-direct');
      await admin.open(120000, 'STOPPED');

      let adminActive = true;
      const s = await open({ ...cfg, historyCaptureAuthorized: true });

      try {
        await assert.rejects(
          s.assertHistoryReady(),
          /HISTORY_ADMIN_ACTIVE/
        );

        await admin.close();
        adminActive = false;

        await s.assertHistoryReady();
        await s.assertHistoryReady();

        const competing = new AdminRepository(
          localUrl.toString(),
          'synthetic-direct'
        );

        try {
          await assert.rejects(
            competing.open(120000, 'STOPPED'),
            /SCHEDULER_ALREADY_ACTIVE/
          );
        } finally {
          await competing.close();
        }
      } finally {
        await close(s);
        if (adminActive) await admin.close();
      }

      const restarted = new AdminRepository(
        localUrl.toString(),
        'synthetic-direct'
      );

      try {
        await restarted.open(120000, 'STOPPED');
        assert.equal((await restarted.settings()).runtime_state, 'STOPPED');
      } finally {
        await restarted.close();
      }
    });

    await t.test('history bloqueia estados corporativos inválidos e leituras pendentes', async () => {
      const cfg = await pausedQueue();

      await local.query(await readFile(
        new URL('../admin/migrations/002_worker_administration.sql', import.meta.url),
        'utf8'
      ));

      const admin = new AdminRepository(localUrl.toString(), 'synthetic-direct');
      await admin.open(120000, 'STOPPED');
      await admin.close();

      const unauthorized = await open(cfg);
      try {
        await assert.rejects(
          unauthorized.assertHistoryReady(),
          /HISTORY_CAPTURE_NOT_AUTHORIZED/
        );
      } finally {
        await close(unauthorized);
      }

      const s = await open({ ...cfg, historyCaptureAuthorized: true });

      try {
        await s.assertHistoryReady();

        await local.query(
          `UPDATE olos_http.worker_settings
           SET desired_state='PAUSED'
           WHERE source_key='synthetic-direct'`
        );

        await assert.rejects(
          s.assertHistoryReady(),
          /HISTORY_SCHEDULER_NOT_STOPPED/
        );

        await local.query(
          `UPDATE olos_http.worker_settings
           SET desired_state='STOPPED'
           WHERE source_key='synthetic-direct'`
        );

        await s.assertHistoryReady();

        await local.query(
          'UPDATE olos_http.corporate_control SET paused=false'
        );
        await assert.rejects(
          s.assertHistoryReady(),
          /HISTORY_CORPORATE_STATE_INVALID/
        );

        await local.query(
          'UPDATE olos_http.corporate_control SET paused=true,blocked=true'
        );
        await assert.rejects(
          s.assertHistoryReady(),
          /HISTORY_CORPORATE_STATE_INVALID/
        );

        await local.query(
          'UPDATE olos_http.corporate_control SET blocked=false,ready=false'
        );
        await assert.rejects(
          s.assertHistoryReady(),
          /HISTORY_CORPORATE_STATE_INVALID/
        );

        await local.query(
          'UPDATE olos_http.corporate_control SET ready=true'
        );

        const pending = await s.beginRead({ kind: 'history' });

        await assert.rejects(
          s.assertHistoryReady(),
          /HISTORY_RECOVERY_REQUIRED/
        );

        assert.equal(
          (await local.query(
            'SELECT state FROM olos_http.reads WHERE id=$1',
            [pending]
          )).rows[0].state,
          'reading'
        );
      } finally {
        await close(s);
      }
    });

    await t.test('history falha remota não repete consumo após reinício', async () => {
      const cfg = await pausedQueue();

      await local.query(await readFile(
        new URL('../admin/migrations/002_worker_administration.sql', import.meta.url),
        'utf8'
      ));

      const admin = new AdminRepository(
        localUrl.toString(), 'synthetic-direct'
      );
      await admin.open(120000, 'STOPPED');
      await admin.close();

      let consuming = 0;

      const catalog = [
        { TableName: 'AttemptsRawData', Columns: [
          'AttemptsRawDataID', 'CallId', 'StartDate',
          'OriginalPhoneNumber', 'AgentId', 'CampaignId', 'DispositionId'
        ] },
        { TableName: 'Users', Columns: ['AgentId', 'UserName'] },
        { TableName: 'Campaign', Columns: ['CampaignId', 'Description'] },
        { TableName: 'Disposition', Columns: ['DispositionId', 'Description'] }
      ];

      const auth = new OlosAuthManager(
        async () => JSON.stringify({
          access_token: 'synthetic-token',
          refresh_token: 'synthetic-refresh',
          expires_in: 3600,
          token_type: 'bearer'
        }),
        {
          username: 'fixture',
          password: 'fixture',
          clientId: 'fixture',
          clientSecret: 'fixture'
        }
      );

      const api = new OlosApi(async path => {
        if (path.endsWith('/available-tables')) {
          return JSON.stringify(catalog);
        }
        if (path.endsWith('/read-data')) {
          return '[]';
        }
        if (path.endsWith('/read-data-previous-days')) {
          consuming++;
          throw new Error('synthetic uncertain remote response');
        }
        throw new Error('Unexpected synthetic API request');
      }, auth, async () => {});

      const options = {
        ...cfg,
        historyCaptureAuthorized: true
      };

      const first = await open(options);

      try {
        const worker = new Worker(
          first, api, new StaticCache(api, 3600000)
        );

        await assert.rejects(
          worker.cycle({ kind: 'history' }),
          /RECOVERY_REQUIRED/
        );

        assert.equal(consuming, 1);

        const pending = await first.unresolved();
        assert.equal(pending.length, 1);
        assert.equal(pending[0]!.state, 'reading');
        assert.equal(pending[0]!.spec.kind, 'history');

        await assert.rejects(
          worker.cycle({ kind: 'history' }),
          /HISTORY_RECOVERY_REQUIRED/
        );

        assert.equal(consuming, 1);
      } finally {
        await close(first);
      }

      const restarted = await open(options);

      try {
        const worker = new Worker(
          restarted, api, new StaticCache(api, 3600000)
        );

        await assert.rejects(
          worker.cycle({ kind: 'history' }),
          /HISTORY_RECOVERY_REQUIRED/
        );

        assert.equal(consuming, 1);
        assert.equal((await restarted.unresolved()).length, 1);

        const state = await control();
        assert.equal(state.paused, true);

        assert.equal((await outbox()).length, 9);
      } finally {
        await close(restarted);
      }
    });

    const selectedIds = ['35091119','35091120','35091121'];
    const selected = { sourceIds: selectedIds, confirmation: `AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:${selectedIds.join(',')}` };
    async function selectiveFixture() {
      const cfg = await pausedQueue();
      await local.query(await readFile(new URL('../migrations/003_selective_commit.sql', import.meta.url), 'utf8'));
      const s = await open(cfg);
      await local.query("SELECT setval(pg_get_serial_sequence('raw.olos_calls','internal_id_olos'),725284)");
      await stage(s, selectedIds.map((id, i) => record(Number(id), { CallId: String(35458016 + i) })));
      await close(s); return cfg;
    }
    async function selectiveRun(cfg: Config, hooks: DeliveryHooks = {}, selection = selected) {
      const s = new Store(cfg);
      try { await s.open(); await s.delivery!.deliverSelected(selection, hooks); }
      finally { await s.close(); }
    }
    const unresolvedCommit = async () => (await local.query("SELECT * FROM olos_http.corporate_selective_commits WHERE state='unresolved'")).rows[0];
    const reconciliationFor = (attemptId: string, ids = selectedIds) => ({ sourceIds: ids, attemptId,
      confirmation: `AUTHORIZE_EXPORTDATA_SELECTIVE_RECONCILIATION:${attemptId}:${ids.join(',')}` });
    async function reconcileRun(cfg: Config, hooks: DeliveryHooks = {}, selection?: ReturnType<typeof reconciliationFor>) {
      const request = selection ?? reconciliationFor((await unresolvedCommit()).attempt_id);
      const s = new Store(cfg);
      try { await s.open(); await s.delivery!.reconcileSelected(request, hooks); }
      finally { await s.close(); }
    }
    async function assertQuarantined(cfg: Config) {
      assert.equal((await control()).blocked, true); assert.equal((await control()).paused, true);
      assert.equal((await control()).last_code, selectiveCommitBlock);
      assert.ok(await unresolvedCommit());
      await assert.rejects(selectiveRun(cfg), /CORPORATE_DELIVERY_BLOCKED/);
    }
    const otherReceipts = async () => (await local.query(
      'SELECT * FROM olos_http.corporate_outbox WHERE NOT(source_id=ANY($1::text[])) ORDER BY target_id', [selectedIds])).rows;
    const selectedReceipts = async () => (await local.query(
      'SELECT * FROM olos_http.corporate_outbox WHERE source_id=ANY($1::text[]) ORDER BY target_id', [selectedIds])).rows;

    await t.test('selective: exactly requested IDs, old queue unchanged, paused throughout and replay idempotent', async () => {
      const cfg = await selectiveFixture(), before = await otherReceipts(), frozen = await selectedReceipts();
      await selectiveRun(cfg, { beforeRemoteCommit: async () => {
        assert.equal((await control()).paused, true);
        assert.equal((await control()).confirmed_count, '2');
        assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
        assert.equal(await destinationCount(), 2);
      } });
      const delivered = (await remote.query('SELECT internal_id_olos,olos_call_id FROM raw.olos_calls WHERE internal_id_olos>=725285 ORDER BY internal_id_olos')).rows;
      assert.deepEqual(delivered, [725285,725286,725287].map((id,i) => ({ internal_id_olos: id, olos_call_id: String(35458016+i) })));
      assert.equal(await destinationCount(), 5);
      assert.deepEqual(await otherReceipts(), before);
      const receipts = await selectedReceipts();
      for (let i = 0; i < receipts.length; i++) {
        assert.equal(receipts[i].state, 'confirmed');
        for (const key of ['payload','payload_hash','source_hash','target_id','source_id','origin']) assert.deepEqual(receipts[i][key], frozen[i][key]);
      }
      assert.equal((await control()).paused, true); assert.equal((await control()).confirmed_count, '5');
      await selectiveRun(cfg);
      assert.deepEqual(await selectedReceipts(), receipts);
      assert.deepEqual(await otherReceipts(), before);
      assert.equal((await control()).confirmed_count, '5'); assert.equal(await destinationCount(), 5);
      const s = await open(cfg); await s.delivery!.tick(); s.delivery!.kick(); await s.delivery!.settle(); await close(s);
      assert.deepEqual(await otherReceipts(), before); assert.equal(await destinationCount(), 5);
    });
    await t.test('selective: unknown COMMIT persists across restart; only authorized reconciliation confirms existing rows', async () => {
      const cfg = await selectiveFixture(), before = await otherReceipts();
      await assert.rejects(selectiveRun(cfg, { afterRemoteCommit: async () => { throw new Error('lost commit acknowledgement'); } }), /CORPORATE_COMMIT_UNKNOWN/);
      assert.equal(await destinationCount(), 5);
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending' && r.remote_raw_id === null));
      assert.equal((await control()).confirmed_count, '2'); assert.equal((await control()).paused, true);
      await remote.query("UPDATE raw.olos_calls SET arquivo_origem='corporate',kommo_tentativas=7,kommo_status_processamento='processed' WHERE internal_id_olos>=725285");
      const remoteBefore = (await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      const identityBefore = (await remote.query('SELECT last_value,is_called FROM raw.olos_calls_raw_olos_call_id_seq')).rows;
      await assertQuarantined(cfg);
      await reconcileRun(cfg);
      assert.equal((await control()).blocked, false); assert.equal((await control()).paused, true);
      assert.equal(await unresolvedCommit(), undefined);
      await selectiveRun(cfg);
      assert.deepEqual((await remote.query('SELECT last_value,is_called FROM raw.olos_calls_raw_olos_call_id_seq')).rows, identityBefore);
      assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows, remoteBefore);
      assert.deepEqual(await otherReceipts(), before); assert.equal((await control()).confirmed_count, '5');
    });
    await t.test('selective: remote rollback and local acknowledgement failure remain replayable without duplicate receipts', async () => {
      const cfg = await selectiveFixture(), before = await otherReceipts();
      await assert.rejects(selectiveRun(cfg, { beforeRemoteCommit: async () => { throw Object.assign(new Error('rollback'), { code: '40001' }); } }), /DATABASE_TRANSIENT_FAILURE/);
      assert.equal(await destinationCount(), 2); assert.equal((await control()).confirmed_count, '2');
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      await assert.rejects(selectiveRun(cfg, { beforeLocalCommit: async () => { throw new Error('local commit failed'); } }), /local commit failed/);
      assert.equal(await destinationCount(), 5); assert.equal((await control()).confirmed_count, '2');
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      await assertQuarantined(cfg); await reconcileRun(cfg);
      await selectiveRun(cfg); assert.equal(await destinationCount(), 5);
      assert.equal((await control()).confirmed_count, '5'); assert.equal((await control()).paused, true);
      assert.deepEqual(await otherReceipts(), before);
    });
    await t.test('selective: real remote session loss at COMMIT leaves every receipt pending', async () => {
      const cfg = await selectiveFixture();
      await assert.rejects(selectiveRun(cfg, { beforeRemoteCommit: async () => {
        const killed = await remote.query(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='corporate-sync' AND state='idle in transaction'`);
        assert.equal(killed.rowCount, 1); assert.equal(killed.rows[0].ok, true);
      } }), /CORPORATE_COMMIT_UNKNOWN/);
      assert.equal(await destinationCount(), 2); assert.equal((await control()).last_code, selectiveCommitBlock);
      assert.equal((await control()).confirmed_count, '2'); assert.equal((await control()).paused, true);
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending' && r.remote_raw_id === null));
      await assertQuarantined(cfg);
      await reconcileRun(cfg);
      assert.equal(await destinationCount(), 2); assert.equal((await control()).confirmed_count, '2');
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      assert.equal((await control()).blocked, false); assert.equal((await control()).paused, true);
      await selectiveRun(cfg); assert.equal(await destinationCount(), 5);
    });
    await t.test('selective quarantine survives local session loss after remote COMMIT; general resume cannot bypass it', async () => {
      const cfg = await selectiveFixture(), s = new Store(cfg);
      await s.open();
      const pid = (await s.client!.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      try {
        await assert.rejects(s.delivery!.deliverSelected(selected, { afterRemoteCommit: async () => {
          await local.query('SELECT pg_terminate_backend($1)', [pid]);
          await pause(30);
          throw new Error('owner lost with acknowledgement');
        } }), /CORPORATE_COMMIT_UNKNOWN/);
      } finally { await s.close(); }
      assert.equal(await destinationCount(), 5); await assertQuarantined(cfg);
      await assert.rejects(corporateControl(makeConfig(), 'corporate-resume'), /CORPORATE_DELIVERY_BLOCKED/);
      const general = await open(makeConfig());
      try { await general.delivery!.tick(); } finally { await close(general); }
      assert.equal((await control()).blocked, true); assert.equal((await control()).confirmed_count, '2');
      await reconcileRun(cfg); assert.equal((await control()).confirmed_count, '5');
    });
    await t.test('selective durable intent survives interruption before remote COMMIT and reconciles absence without writing', async () => {
      const cfg = await selectiveFixture();
      await assert.rejects(selectiveRun(cfg, { afterSelectiveIntent: async () => { throw new Error('interruption'); } }), /CORPORATE_COMMIT_UNKNOWN/);
      assert.equal(await destinationCount(), 2); await assertQuarantined(cfg);
      await reconcileRun(cfg);
      assert.equal(await destinationCount(), 2); assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      assert.equal((await control()).blocked, false); assert.equal((await control()).paused, true);
    });
    await t.test('selective revalidates frozen payload after durable intent releases row locks', async () => {
      const cfg = await selectiveFixture();
      await assert.rejects(selectiveRun(cfg, { afterSelectiveIntent: async () => {
        await local.query("UPDATE olos_http.corporate_outbox SET payload=jsonb_set(payload,'{olos_call_id}','\"changed\"') WHERE source_id='35091120'");
      } }), /CORPORATE_COMMIT_UNKNOWN/);
      assert.equal(await destinationCount(), 2); await assertQuarantined(cfg);
      await assert.rejects(reconcileRun(cfg), /CORPORATE_PAYLOAD_CHANGED/);
      await assertQuarantined(cfg);
    });
    await t.test('selective reconciliation requires exact attempt, full selection and separate consent; divergences retain quarantine', async () => {
      const cfg = await selectiveFixture(), others = await otherReceipts();
      await assert.rejects(selectiveRun(cfg, { afterRemoteCommit: async () => { throw new Error('unknown'); } }), /CORPORATE_COMMIT_UNKNOWN/);
      const attempt = await unresolvedCommit(), receipts = await selectedReceipts();
      await assert.rejects(reconcileRun(cfg, {}, { ...reconciliationFor(attempt.attempt_id), confirmation: selected.confirmation }), /WRITE_NOT_AUTHORIZED/);
      await assert.rejects(reconcileRun(cfg, {}, reconciliationFor('00000000-0000-4000-8000-000000000001')), /SELECTIVE_ATTEMPT_MISMATCH/);
      await assert.rejects(reconcileRun(cfg, {}, reconciliationFor(attempt.attempt_id, selectedIds.slice(0,2))), /SELECTIVE_COMMIT_EVIDENCE_CHANGED/);
      await assert.rejects(reconcileRun(cfg, {}, reconciliationFor(attempt.attempt_id, ['900001'])), /SELECTIVE_COMMIT_EVIDENCE_CHANGED/);
      await remote.query("UPDATE raw.olos_calls SET olos_call_id='divergent' WHERE internal_id_olos=725286");
      const divergent = (await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      await assert.rejects(reconcileRun(cfg), /INTERNAL_ID_COLLISION/);
      assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows, divergent);
      assert.deepEqual(await selectedReceipts(), receipts); assert.deepEqual(await otherReceipts(), others);
      assert.deepEqual(await unresolvedCommit(), attempt); await assertQuarantined(cfg);
    });
    await t.test('selective reconciliation rejects changed local hashes and remote schema without clearing quarantine', async () => {
      const cfg = await selectiveFixture();
      await assert.rejects(selectiveRun(cfg, { afterRemoteCommit: async () => { throw new Error('unknown'); } }), /CORPORATE_COMMIT_UNKNOWN/);
      const original = (await selectedReceipts())[0];
      await local.query("UPDATE olos_http.corporate_outbox SET payload_hash=repeat('f',64) WHERE source_id='35091119'");
      await assert.rejects(reconcileRun(cfg), /SELECTIVE_COMMIT_EVIDENCE_CHANGED/);
      await local.query("UPDATE olos_http.corporate_outbox SET payload_hash=$1 WHERE source_id='35091119'", [original.payload_hash]);
      await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN raw_olos_call_id SET GENERATED BY DEFAULT');
      await assert.rejects(reconcileRun(cfg), /CORPORATE_IDENTITY_ALWAYS_REQUIRED/);
      await assertQuarantined(cfg); assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
    });
    await t.test('selective reconciliation refuses absence while a remote transaction still holds its fence', async () => {
      const cfg = await selectiveFixture();
      await assert.rejects(selectiveRun(cfg, { afterSelectiveIntent: async () => { throw new Error('stop'); } }), /CORPORATE_COMMIT_UNKNOWN/);
      await remote.query('BEGIN'); await remote.query('SELECT pg_advisory_xact_lock(17320914,5)');
      try { await assert.rejects(reconcileRun(cfg), /SELECTIVE_REMOTE_TRANSACTION_ACTIVE/); }
      finally { await remote.query('ROLLBACK'); }
      await assertQuarantined(cfg); assert.equal(await destinationCount(), 2);
      await reconcileRun(cfg); assert.equal(await destinationCount(), 2);
    });
    await t.test('selective reconciliation commit failures roll back receipts, journal resolution and unblock atomically', async () => {
      const cfg = await selectiveFixture();
      await assert.rejects(selectiveRun(cfg, { afterRemoteCommit: async () => { throw new Error('unknown'); } }), /CORPORATE_COMMIT_UNKNOWN/);
      const before = await selectedReceipts(), attempt = await unresolvedCommit();
      for (const hooks of [
        { afterRemoteCommit: async () => { throw new Error('reconciliation read commit lost'); } },
        { beforeLocalCommit: async () => { throw new Error('reconciliation local commit failed'); } }
      ]) {
        await assert.rejects(reconcileRun(cfg, hooks), /reconciliation/);
        assert.deepEqual(await selectedReceipts(), before); assert.deepEqual(await unresolvedCommit(), attempt);
        await assertQuarantined(cfg);
      }
      await reconcileRun(cfg);
      const resolved = (await local.query('SELECT * FROM olos_http.corporate_selective_commits WHERE attempt_id=$1', [attempt.attempt_id])).rows[0];
      assert.equal(resolved.state, 'reconciled'); assert.equal(resolved.outcome.length, 3);
      assert.ok(resolved.outcome.every((row: any) => row.remote_raw_id));
      await assert.rejects(reconcileRun(cfg, {}, reconciliationFor(attempt.attempt_id)), /SELECTIVE_RECONCILIATION_NOT_PENDING/);
      assert.equal((await control()).confirmed_count, '5');
    });
    await t.test('selective commands require local migration; old untracked UNKNOWN cannot be retried selectively', async () => {
      const cfg = await selectiveFixture();
      await local.query('DROP TABLE olos_http.corporate_selective_commits');
      await assert.rejects(selectiveRun(cfg), /SELECTIVE_COMMIT_MIGRATION_REQUIRED/);
      await local.query(await readFile(new URL('../migrations/003_selective_commit.sql', import.meta.url), 'utf8'));
      await local.query("UPDATE olos_http.corporate_control SET last_code='CORPORATE_COMMIT_UNKNOWN'");
      await assert.rejects(selectiveRun(cfg), /SELECTIVE_UNTRACKED_COMMIT_UNKNOWN/);
      assert.equal(await destinationCount(), 2);
    });
    await t.test('selective: connection refusal sends nothing and returns failure', async () => {
      const cfg = await selectiveFixture();
      cfg.corporateDelivery!.connection.destinationUrl = 'postgresql://postgres@localhost:1/madm';
      await assert.rejects(selectiveRun(cfg), /DATABASE_TRANSIENT_FAILURE/);
      assert.equal(await destinationCount(), 2); assert.equal((await control()).confirmed_count, '2');
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      assert.equal((await control()).paused, true);
    });
    await t.test('selective: divergent identity blocks the entire set and cannot be skipped on replay', async () => {
      const cfg = await selectiveFixture();
      const payload = (await selectedReceipts())[1].payload;
      await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_,i) => `$${i+1}`).join(',')})`,
        columns.map(name => name === 'olos_call_id' ? 'divergent' : payload[name]));
      await assert.rejects(selectiveRun(cfg), /INTERNAL_ID_COLLISION/);
      assert.equal(await destinationCount(), 3); assert.equal((await control()).blocked, true);
      assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      await assert.rejects(selectiveRun(cfg), /CORPORATE_DELIVERY_BLOCKED/);
      assert.equal((await control()).paused, true);
    });
    await t.test('selective: missing IDs and invalid receipt mappings fail before any remote write', async () => {
      for (const mutate of [
        () => local.query("DELETE FROM olos_http.corporate_outbox WHERE source_id='35091120'"),
        () => local.query("UPDATE olos_http.corporate_outbox SET source_hash='invalid' WHERE source_id='35091120'"),
        () => local.query("UPDATE olos_http.corporate_outbox SET origin='legacy_backlog' WHERE source_id='35091120'")
      ]) {
        const cfg = await selectiveFixture(); await mutate();
        await assert.rejects(selectiveRun(cfg), /SELECTIVE_RECEIPT_INVALID/);
        assert.equal(await destinationCount(), 2); assert.equal((await control()).confirmed_count, '2');
      }
    });
    await t.test('selective: invalid frozen hash, payload and schema never deliver a subset', async () => {
      for (const [mutate, error] of [
        [() => local.query("UPDATE olos_http.corporate_outbox SET payload_hash=repeat('a',64) WHERE source_id='35091120'"), /CORPORATE_PAYLOAD_CHANGED/],
        [() => local.query("UPDATE olos_http.corporate_outbox SET payload=jsonb_set(payload,'{olos_call_id}','null') WHERE source_id='35091120'"), /REQUIRED_VALUE_MISSING/],
        [() => remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN raw_olos_call_id SET GENERATED BY DEFAULT'), /CORPORATE_IDENTITY_ALWAYS_REQUIRED/]
      ] as const) {
        const cfg = await selectiveFixture(); await mutate();
        await assert.rejects(selectiveRun(cfg), error);
        assert.equal(await destinationCount(), 2); assert.equal((await control()).paused, true);
        assert.ok((await selectedReceipts()).every(r => r.state === 'pending'));
      }
    });
    await t.test('selective: a confirmed receipt with missing remote proof is never silently recreated', async () => {
      const cfg = await selectiveFixture(); await selectiveRun(cfg);
      const receipts = await selectedReceipts();
      await remote.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=725286');
      await assert.rejects(selectiveRun(cfg), /SELECTIVE_CONFIRMED_RECEIPT_DIVERGES/);
      assert.equal(await destinationCount(), 4); assert.deepEqual(await selectedReceipts(), receipts);
    });
    await t.test('selective: source, sync, history and delivery locks reject concurrency', async () => {
      for (const [sql, params, error] of [
        ['SELECT pg_advisory_lock(hashtextextended($1,0))', [`olos-http:AttemptsRawData:${base.OLOS_SOURCE_KEY}`], /CONSUMER_ALREADY_ACTIVE/],
        ['SELECT pg_advisory_lock(17320914,1)', [], /CORPORATE_SYNC_STILL_RUNNING/],
        ['SELECT pg_advisory_lock(hashtextextended($1,0))', [`olos-http:history:${base.OLOS_SOURCE_KEY}`], /HISTORY_CAPTURE_ACTIVE/],
        ['SELECT pg_advisory_lock(17320914,4)', [], /CORPORATE_DELIVERY_BUSY/]
      ] as const) {
        const cfg = await selectiveFixture(); await local.query(sql, [...params]);
        try { await assert.rejects(selectiveRun(cfg), error); }
        finally { await local.query('SELECT pg_advisory_unlock_all()'); }
        assert.equal(await destinationCount(), 2); assert.equal((await control()).paused, true);
      }
    });
    await t.test('selective: same-owner overlap rejected, pause/resume cannot interleave with remote transaction', async () => {
      const cfg = await selectiveFixture(), s = await open(cfg);
      await s.delivery!.deliverSelected(selected, { beforeRemoteCommit: async () => {
        await assert.rejects(s.delivery!.deliverSelected(selected), /CORPORATE_DELIVERY_BUSY/);
        await local.query("SET lock_timeout='50ms'");
        try { await assert.rejects(local.query('UPDATE olos_http.corporate_control SET paused=false'), (e: any) => e.code === '55P03'); }
        finally { await local.query('SET lock_timeout=0'); }
        const contender = new Store(cfg);
        try { await assert.rejects(contender.open(), /CONSUMER_ALREADY_ACTIVE/); }
        finally { await contender.close(); }
      } });
      await close(s); assert.equal(await destinationCount(), 5); assert.equal((await control()).paused, true);
    });
    await t.test('selective: active history intentions, unpaused and blocked states reject without delivery', async () => {
      for (const [sql, error] of [
        ["INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES('11111111-1111-1111-1111-111111111111','synthetic-direct','\"raw\".\"olos_calls\"','{\"kind\":\"history\"}')", /HISTORY_RECOVERY_REQUIRED/],
        ['UPDATE olos_http.corporate_control SET paused=false', /SELECTIVE_REQUIRES_PAUSED/],
        ['UPDATE olos_http.corporate_control SET blocked=true', /CORPORATE_DELIVERY_BLOCKED/]
      ] as const) {
        const cfg = await selectiveFixture(); await local.query(sql);
        await assert.rejects(selectiveRun(cfg), error); assert.equal(await destinationCount(), 2);
      }
    });
    await t.test('selective CLI: explicit consent, no API calls, no scheduler changes and nonzero exit on conflict', async () => {
      await selectiveFixture();
      await local.query(await readFile(new URL('../admin/migrations/002_worker_administration.sql', import.meta.url), 'utf8'));
      const admin = new AdminRepository(localUrl.toString(), base.OLOS_SOURCE_KEY);
      try { await admin.open(120000, 'STOPPED'); } finally { await admin.close(); }
      const settings = (await local.query('SELECT * FROM olos_http.worker_settings')).rows;
      let requests = 0;
      const server = createServer((_, res) => { requests++; res.writeHead(500); res.end(); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const env = { ...base, ATTEMPTS_PERSISTENCE_MODE: 'corporate',
        OLOS_CORPORATE_DATABASE_URL: remoteUrl.toString(), OLOS_CORPORATE_CA_FILE: process.env.OLOS_DIRECT_TEST_CA_FILE!,
        OLOS_CORPORATE_WRITE_ENABLED: 'false', OLOS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        OLOS_USERNAME: 'synthetic', OLOS_PASSWORD: 'synthetic', OLOS_CLIENT_ID: 'synthetic', OLOS_CLIENT_SECRET: 'synthetic' };
      const args = ['--source-ids', selectedIds.join(','), '--confirm', selected.confirmation];
      const cli = (parameters: string[], extra: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath,
        ['dist/main.js','corporate-deliver-selected', ...parameters], { env: { ...env, ...extra }, timeout: 15000 });
      try {
        await assert.rejects(cli([]), (e: any) => e.code === 1 && e.stdout.includes('SELECTIVE_PARAMETERS_INVALID'));
        await assert.rejects(cli([...args.slice(0,3), 'wrong'], { DATABASE_URL: 'postgresql://postgres@127.0.0.1:1/unreachable' }),
          (e: any) => e.code === 1 && e.stdout.includes('SELECTIVE_WRITE_NOT_AUTHORIZED'));
        await assert.rejects(cli(args, { OLOS_CORPORATE_WRITE_ENABLED: 'true', OLOS_CORPORATE_WRITE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY' }),
          (e: any) => e.code === 1 && e.stdout.includes('SELECTIVE_REQUIRES_GENERAL_WRITE_DISABLED'));
        assert.equal(await destinationCount(), 2);
        await assert.rejects(selectiveRun(config(env), { afterRemoteCommit: async () => { throw new Error('unknown'); } }), /CORPORATE_COMMIT_UNKNOWN/);
        await assert.rejects(cli(args), (e: any) => e.code === 1 && e.stdout.includes('CORPORATE_DELIVERY_BLOCKED'));
        const attemptId = (await unresolvedCommit()).attempt_id;
        const reconcileCli = (confirmation: string) => promisify(execFile)(process.execPath,
          ['dist/main.js','corporate-reconcile-selected','--source-ids',selectedIds.join(','),'--attempt-id',attemptId,'--confirm',confirmation],
          { env, timeout: 15000 });
        await assert.rejects(reconcileCli(selected.confirmation), (e: any) => e.code === 1 && e.stdout.includes('SELECTIVE_WRITE_NOT_AUTHORIZED'));
        assert.match((await reconcileCli(reconciliationFor(attemptId).confirmation)).stdout, /corporate_selected_commit_reconciled/);
        const result = await cli(args); assert.match(result.stdout, /corporate_selected_delivery_confirmed/);
        await cli(args); assert.equal(await destinationCount(), 5);
        await remote.query("UPDATE raw.olos_calls SET olos_call_id='divergent' WHERE internal_id_olos=725286");
        await assert.rejects(cli(args), (e: any) => e.code === 1 && e.stdout.includes('INTERNAL_ID_COLLISION'));
        assert.equal(requests, 0); assert.equal((await control()).paused, true);
        assert.deepEqual((await local.query('SELECT * FROM olos_http.worker_settings')).rows, settings);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });

    const operatorMigration = async () => remote.query(await readFile(new URL('../migrations/corporate/001_operator_id.sql', import.meta.url), 'utf8'));
    async function operatorLocalMigrations() {
      await local.query(await readFile(new URL('../migrations/003_selective_commit.sql', import.meta.url), 'utf8'));
      await local.query(await readFile(new URL('../migrations/004_operator_contract.sql', import.meta.url), 'utf8'));
    }
    async function operatorCommand(cfg: Config, request: OperatorRequest) {
      const s = new Store(cfg);
      try { await s.open(); return await operatorAdmin(s.client!,cfg.corporateDelivery!,cfg.sourceKey,s.target,request); }
      finally { await s.close(); }
    }
    async function adoptOperator(cfg: Config) {
      const plan = await operatorCommand(cfg,{kind:'plan'});
      const request: OperatorRequest = {kind:'adopt',previousHash:plan.previous_schema_hash,schemaHash:plan.schema_hash,
        confirmation:`AUTHORIZE_EXPORTDATA_OPERATOR_CONTRACT:${plan.previous_schema_hash}:${plan.schema_hash}`};
      await operatorCommand(cfg,request); return request;
    }
    const prepareOperator = (cfg: Config, ids = selectedIds) => operatorCommand(cfg, {kind:'prepare',ids,
      confirmation:`AUTHORIZE_EXPORTDATA_OPERATOR_PAYLOADS:${ids.join(',')}`});
    async function operatorFixture() {
      const cfg = await pausedQueue(); await operatorLocalMigrations();
      const s = await open(cfg);
      await local.query("SELECT setval(pg_get_serial_sequence('raw.olos_calls','internal_id_olos'),725284)");
      await stage(s, selectedIds.map((id,i) => record(Number(id), { CallId:String(35458016+i),AgentId:[52,1599,0][i] })));
      await close(s); return cfg;
    }
    await t.test('operator: additive migration/adoption preserve frozen backlog, receipts, binding and pause', async () => {
      const cfg = await operatorFixture(), before = await outbox(), state = await control();
      const records = (await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows;
      const remoteBefore = (await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      const indexes = (await remote.query("SELECT indexdef FROM pg_indexes WHERE schemaname='raw' AND tablename='olos_calls' ORDER BY indexname")).rows;
      assert.equal((await corporateSchema(remote,cfg.corporateDelivery!,false)).shape.size,33);
      await operatorMigration(); await operatorMigration();
      assert.equal((await corporateSchema(remote,cfg.corporateDelivery!,false)).shape.size,34);
      assert.deepEqual((await remote.query("SELECT indexdef FROM pg_indexes WHERE schemaname='raw' AND tablename='olos_calls' ORDER BY indexname")).rows,indexes);
      const plan = await operatorCommand(cfg,{kind:'plan'});
      assert.equal(plan.previous_schema_hash, state.schema_hash); assert.notEqual(plan.schema_hash, state.schema_hash);
      assert.deepEqual(await control(), state); assert.deepEqual(await outbox(), before);
      const adoption = await adoptOperator(cfg); await operatorCommand(cfg,adoption);
      assert.deepEqual(await outbox(), before); assert.deepEqual((await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows,records);
      const after = await control(); assert.equal(after.binding,state.binding); assert.equal(after.confirmed_count,state.confirmed_count);
      assert.equal(after.generation,state.generation); assert.equal(after.paused,true); assert.equal(after.blocked,false);
      const remoteAfter = (await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      assert.deepEqual(remoteAfter.map(({id_operador_olos,...r}: any) => r),remoteBefore);
      assert.ok(remoteAfter.every(r => r.id_operador_olos===null));
    });
    await t.test('operator: new schema alone cannot deliver; legacy pending requires explicit payload preparation', async () => {
      let cfg = await operatorFixture(); await operatorMigration();
      await assert.rejects(selectiveRun(cfg), /CORPORATE_SCHEMA_CHANGED/);
      assert.equal(await destinationCount(),2); assert.equal((await control()).paused,true);
      cfg = await operatorFixture(); await operatorMigration(); await adoptOperator(cfg);
      const before = await outbox();
      await assert.rejects(selectiveRun(cfg), /OPERATOR_PAYLOAD_UPGRADE_REQUIRED/);
      assert.equal(await destinationCount(),2); assert.deepEqual(await outbox(),before);
      assert.equal((await control()).paused,true); assert.equal((await control()).blocked,false);
      await prepareOperator(cfg); await selectiveRun(cfg); assert.equal(await destinationCount(),5);
    });
    await t.test('operator: bounded audited pending preparation delivers 52,1599,0 and is idempotent', async () => {
      const cfg = await operatorFixture(), before = await selectedReceipts(), others = await otherReceipts();
      await operatorMigration(); await adoptOperator(cfg);
      assert.equal((await prepareOperator(cfg)).prepared,3);
      const prepared = await selectedReceipts();
      assert.deepEqual(prepared.map(r => r.payload.id_operador_olos), ['52','1599','0']);
      for(let i=0;i<3;i++) {
        assert.equal(prepared[i].source_hash,before[i].source_hash); assert.equal(prepared[i].target_id,before[i].target_id);
        assert.equal(prepared[i].payload.olos_call_id,before[i].payload.olos_call_id);
        assert.equal(prepared[i].payload.nome_agente,before[i].payload.nome_agente);
        assert.notEqual(prepared[i].payload_hash,before[i].payload_hash);
        assert.equal(prepared[i].payload_hash,deliveryDigest(prepared[i].payload));
      }
      const audits = (await local.query('SELECT * FROM olos_http.corporate_operator_payloads ORDER BY target_id')).rows;
      assert.deepEqual(audits.map(a=>a.previous_payload),before.map(r=>r.payload));
      assert.deepEqual(audits.map(a=>a.previous_hash),before.map(r=>r.payload_hash));
      assert.equal((await prepareOperator(cfg)).prepared,0); assert.deepEqual(await selectedReceipts(),prepared);
      assert.deepEqual(await otherReceipts(),others);
      await selectiveRun(cfg); await selectiveRun(cfg);
      assert.deepEqual((await remote.query('SELECT id_operador_olos FROM raw.olos_calls WHERE internal_id_olos>=725285 ORDER BY internal_id_olos')).rows.map(r=>r.id_operador_olos),['52','1599','0']);
      assert.equal(await destinationCount(),5); assert.equal((await control()).confirmed_count,'5');
      assert.deepEqual(await otherReceipts(),others);
      await assert.rejects(prepareOperator(cfg), /OPERATOR_RECEIPT_INVALID/);
    });
    await t.test('operator: future history capture preserves null/missing/zero and other mapping rules via simulated API', async () => {
      const cfg = await historyConfig(); await operatorLocalMigrations(); await operatorMigration(); await adoptOperator(cfg);
      const s = await open(cfg); let calls=0;
      const input = [record(5001,{AgentId:52}),record(5002,{AgentId:1599}),record(5003,{AgentId:0}),
        record(5004,{AgentId:null}),record(5005,{AgentId:undefined}),record(5006,{AgentId:'00052'})];
      const worker = historyWorker(s,async()=>{calls++;return JSON.stringify(input);});
      const report = await worker.cycle({kind:'history'}); assert.equal(report.queued,6); assert.equal(calls,1);
      await close(s);
      const captured = (await local.query("SELECT * FROM olos_http.corporate_outbox WHERE source_id=ANY($1::text[]) ORDER BY target_id",[input.map(r=>r.AttemptsRawDataID)])).rows;
      assert.deepEqual(captured.map(r=>r.payload.id_operador_olos),['52','1599','0',null,null,'00052']);
      assert.ok(captured.every(r=>r.payload_hash===deliveryDigest(r.payload)));
      assert.equal(await destinationCount(),2); assert.equal((await control()).paused,true);
      for(const ids of [['5001','5002','5003'],['5004','5005','5006']]) {
        await selectiveRun(cfg,{}, {sourceIds:ids,confirmation:`AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:${ids.join(',')}`});
      }
      assert.deepEqual((await remote.query('SELECT id_operador_olos FROM raw.olos_calls WHERE internal_id_olos>2 ORDER BY internal_id_olos')).rows.map(r=>r.id_operador_olos),['52','1599','0',null,null,'00052']);
    });
    await t.test('operator: v2 COMMIT unknown retains existing quarantine and authorized reconciliation proves new field', async () => {
      const cfg = await operatorFixture(); await operatorMigration(); await adoptOperator(cfg); await prepareOperator(cfg);
      await assert.rejects(selectiveRun(cfg,{afterRemoteCommit:async()=>{throw new Error('unknown');}}),/CORPORATE_COMMIT_UNKNOWN/);
      await assertQuarantined(cfg);
      await assert.rejects(prepareOperator(cfg),/OPERATOR_CONTROL_NOT_READY/);
      await remote.query("UPDATE raw.olos_calls SET id_operador_olos='wrong' WHERE internal_id_olos=725286");
      await assert.rejects(reconcileRun(cfg),/EXISTING_OPERATOR_DIVERGES/); await assertQuarantined(cfg);
      // Repair is fixture-only; the application never performs this correction.
      await remote.query("UPDATE raw.olos_calls SET id_operador_olos='1599' WHERE internal_id_olos=725286");
      await reconcileRun(cfg); assert.equal(await destinationCount(),5); assert.equal((await control()).paused,true);
      assert.ok((await selectedReceipts()).every(r=>r.state==='confirmed'));
    });
    await t.test('operator: adoption rejects drift beyond the column and wrong authorization; preparation rejects missing IDs atomically', async () => {
      const cfg = await operatorFixture(), before=await outbox(); await operatorMigration();
      const plan = await operatorCommand(cfg,{kind:'plan'});
      await assert.rejects(operatorCommand(cfg,{kind:'adopt',previousHash:plan.previous_schema_hash,schemaHash:plan.schema_hash,confirmation:''}),/NOT_AUTHORIZED/);
      await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN nome_agente TYPE varchar(200)');
      await assert.rejects(adoptOperator(cfg),/OPERATOR_SCHEMA_CHANGE_NOT_ADDITIVE/);
      assert.deepEqual(await outbox(),before);
      await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN nome_agente TYPE text');
      await adoptOperator(cfg);
      await assert.rejects(prepareOperator(cfg,[selectedIds[0]!,'99999999']),/OPERATOR_SELECTION_INCOMPLETE/);
      assert.deepEqual(await outbox(),before);
      await local.query("UPDATE olos_http.corporate_outbox SET payload_hash=repeat('f',64) WHERE source_id='35091120'");
      const corrupted=await outbox();
      await assert.rejects(prepareOperator(cfg),/CORPORATE_PAYLOAD_CHANGED/);
      assert.deepEqual(await outbox(),corrupted);
      assert.equal((await local.query('SELECT count(*)::integer AS n FROM olos_http.corporate_operator_payloads')).rows[0].n,0);
    });
    await t.test('operator CLI: separate authorization, explicit adoption/preparation, no API or scheduler', async () => {
      await operatorFixture(); await operatorMigration();
      let calls=0;
      const server=createServer((_,res)=>{calls++;res.writeHead(500);res.end();});
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const env={...base,ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:remoteUrl.toString(),
        OLOS_CORPORATE_CA_FILE:process.env.OLOS_DIRECT_TEST_CA_FILE!,OLOS_CORPORATE_WRITE_ENABLED:'false',
        OLOS_BASE_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`};
      const cli=(command:string,args:string[]=[],extra:NodeJS.ProcessEnv={})=>promisify(execFile)(process.execPath,
        ['dist/main.js',command,...args],{env:{...env,...extra},timeout:15000});
      try {
        const before=await outbox();
        await assert.rejects(cli('corporate-prepare-operator',['--source-ids',selectedIds.join(','),'--confirm','wrong'],
          {DATABASE_URL:'postgresql://postgres@127.0.0.1:1/unreachable'}),(e:any)=>e.code===1&&e.stdout.includes('OPERATOR_CHANGE_NOT_AUTHORIZED'));
        const output=await cli('corporate-operator-plan');
        const plan=JSON.parse(output.stdout.trim()); assert.equal(plan.event,'corporate_operator_plan');
        assert.deepEqual(await outbox(),before);
        await cli('corporate-adopt-operator',['--expected-schema-hash',plan.previous_schema_hash,'--schema-hash',plan.schema_hash,
          '--confirm',`AUTHORIZE_EXPORTDATA_OPERATOR_CONTRACT:${plan.previous_schema_hash}:${plan.schema_hash}`]);
        await cli('corporate-prepare-operator',['--source-ids',selectedIds.join(','),'--confirm',`AUTHORIZE_EXPORTDATA_OPERATOR_PAYLOADS:${selectedIds.join(',')}`]);
        assert.equal(calls,0); assert.equal(await destinationCount(),2); assert.equal((await control()).paused,true);
        assert.equal((await local.query("SELECT to_regclass('olos_http.worker_settings') IS NULL AS absent")).rows[0].absent,true);
      } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
    });
    await t.test('operator: confirmed complement proposal changes only operator, is authorized/idempotent and keeps receipts', async () => {
      const cfg = await operatorFixture(); await selectiveRun(cfg);
      const receipts=await outbox();
      await operatorMigration(); await adoptOperator(cfg);
      await remote.query("UPDATE raw.olos_calls SET kommo_tentativas=7,kommo_status_processamento='done',arquivo_origem='corporate' WHERE internal_id_olos>=725285");
      const before=(await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      const proof=(await local.query(`SELECT o.*,o.target_id::text,o.remote_raw_id::text,r.agent_id
        FROM olos_http.corporate_outbox o JOIN olos_http.records r USING(source_key,source_id)
        WHERE o.source_id=ANY($1::text[]) ORDER BY o.target_id`,[selectedIds])).rows;
      const contract=await corporateSchema(remote,cfg.corporateDelivery!,false);
      const proposal=operatorComplementProposal(proof,contract.shape,contract.functions,cfg.corporateDelivery!);
      await assert.rejects(remote.query(proposal.sql),/OPERATOR_COMPLEMENT_NOT_AUTHORIZED/); await remote.query('ROLLBACK');
      assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows,before);
      await remote.query("SELECT set_config('olos.operator_complement_authorization',$1,false)",[proposal.authorization]);
      await remote.query(proposal.sql); await remote.query(proposal.sql);
      const after=(await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      assert.deepEqual(after.map(({id_operador_olos,...r}:any)=>r),before.map(({id_operador_olos,...r}:any)=>r));
      assert.deepEqual(after.slice(2).map(r=>r.id_operador_olos),['52','1599','0']);
      assert.deepEqual(await outbox(),receipts); assert.equal(await destinationCount(),5);
      await selectiveRun(cfg); assert.deepEqual(await outbox(),receipts); assert.equal(await destinationCount(),5);
      await remote.query("UPDATE raw.olos_calls SET olos_call_id='divergent' WHERE internal_id_olos=725286");
      const divergent=(await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows;
      await assert.rejects(remote.query(proposal.sql),/EXISTING_CALL_DIVERGES/); await remote.query('ROLLBACK');
      assert.deepEqual((await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows,divergent);
    });

    await t.test('migration is local/idempotent; activation requires reconciliation and explicit write permission', async () => {
      await reset(); await local.query(await readFile(new URL('../migrations/002_corporate_delivery.sql', import.meta.url), 'utf8'));
      const s = await open(makeConfig(2, { OLOS_CORPORATE_WRITE_ENABLED: 'false' }));
      await assert.rejects(s.beginRead({ kind: 'current' }), /LEGACY_RECONCILIATION_REQUIRED/);
      await s.reconcileCorporate(); await assert.rejects(s.delivery!.resume(s.client!), /WRITE_NOT_AUTHORIZED/);
      await stage(s, [record(999)]); await s.delivery!.tick();
      assert.equal(await destinationCount(), 2);
      assert.equal((await remote.query("SELECT to_regclass('olos_http.corporate_control') AS name")).rows[0].name, null);
    });
    await t.test('direct persistence preserves automatic identity, trigger normalization, TMA zero and corporate defaults', async () => {
      await reset(); const s = await ready();
      const result = await stage(s, [record(999, { OriginalPhoneNumber: '(11) 99999-0000' })]);
      assert.equal(result.queued, 1); assert.equal(result.inserted, 0);
      assert.equal(await count(local, 'raw.olos_calls'), 2);
      assert.equal((await s.delivery!.status(s.client!)).pending, 1);
      await s.delivery!.tick();
      const actual = (await remote.query('SELECT *,raw_olos_call_id::text AS raw_id FROM raw.olos_calls WHERE internal_id_olos=3')).rows[0];
      assert.equal(actual.raw_id, '8000000002'); assert.equal(actual.telefone_match_key, '551199990000');
      assert.equal(actual.tma_origem, 0); assert.ok(actual.created_at); assert.ok(actual.data_carga); assert.ok(actual.updated_at);
      assert.equal(actual.kommo_tentativas, 0);
      assert.equal((await s.delivery!.status(s.client!)).pending, 0);
    });
    await t.test('a configured Billing dependency blocks transition and admission without modifying Billing', async () => {
      const bind = async () => local.query(`CREATE SCHEMA olos_billing;
        CREATE TABLE olos_billing.sources(attempts_source text);
        INSERT INTO olos_billing.sources VALUES('synthetic-direct')`);
      await reset(); await bind(); let s = await open();
      await assert.rejects(s.reconcileCorporate(), /BILLING_LOCAL_CALLS_DEPENDENCY/);
      assert.equal(await count(local, 'olos_http.corporate_control'), 0);
      assert.equal(await count(local, 'olos_billing.sources'), 1);
      await reset(); s = await ready(); await bind();
      await assert.rejects(s.beginRead({ kind: 'current' }), /BILLING_LOCAL_CALLS_DEPENDENCY/);
      await assert.rejects(corporateControl(s.cfg, 'corporate-resume'), /BILLING_LOCAL_CALLS_DEPENDENCY/);
      await corporateControl(s.cfg, 'corporate-pause');
      assert.equal(await destinationCount(), 2);
    });
    await t.test('corporate TMA rounds once at full source precision including sub-half-second durations', async () => {
      await reset(); const s = await ready();
      await stage(s, [record(991, { EndWrap: '2026-10-01T10:00:00.499999-03:00' }), record(992, { EndWrap: '2026-10-01T10:00:00.500000-03:00' })]);
      await s.delivery!.tick();
      assert.deepEqual((await remote.query('SELECT tma_origem FROM raw.olos_calls WHERE internal_id_olos>2 ORDER BY internal_id_olos')).rows.map(r => r.tma_origem), [0,1]);
    });
    await t.test('existing identical call is adopted without INSERT, identity consumption or Kommo modification', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      const entry = (await local.query("SELECT payload FROM olos_http.corporate_outbox WHERE state='pending'")).rows[0];
      await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(name => entry.payload[name]));
      await remote.query("UPDATE raw.olos_calls SET kommo_status_processamento='preserve',kommo_tentativas=42 WHERE internal_id_olos=3");
      const before = (await remote.query('SELECT last_value::text FROM raw.olos_calls_raw_olos_call_id_seq')).rows[0].last_value;
      await s.delivery!.tick();
      assert.equal((await remote.query('SELECT last_value::text FROM raw.olos_calls_raw_olos_call_id_seq')).rows[0].last_value, before);
      assert.equal((await remote.query('SELECT kommo_tentativas FROM raw.olos_calls WHERE internal_id_olos=3')).rows[0].kommo_tentativas, 42);
      assert.equal(await destinationCount(), 3);
    });
    await t.test('existing divergent call blocks delivery but subsequent captures remain durable', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      const entry = (await local.query("SELECT payload FROM olos_http.corporate_outbox WHERE state='pending'")).rows[0];
      const changed = { ...entry.payload, nome_agente: 'corporate original' };
      await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(name => changed[name]));
      await s.delivery!.tick();
      assert.equal((await s.delivery!.status(s.client!)).last_code, 'EXISTING_CALL_DIVERGES');
      assert.equal((await s.delivery!.status(s.client!)).pending, 1);
      await stage(s, [record(998)]); assert.equal((await s.delivery!.status(s.client!)).pending, 2);
      assert.equal((await s.unresolved()).length, 0);
      await assert.rejects(s.delivery!.resume(s.client!), /CORPORATE_DELIVERY_BLOCKED/);
    });
    await t.test('connection refused retains the queue and recovery commits once', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      const connection = s.cfg.corporateDelivery!.connection, saved = connection.destinationUrl;
      connection.destinationUrl = 'postgresql://postgres@localhost:1/madm';
      await s.delivery!.tick(); connection.destinationUrl = saved;
      assert.equal((await s.delivery!.status(s.client!)).last_code, 'DATABASE_TRANSIENT_FAILURE');
      assert.equal((await s.delivery!.status(s.client!)).pending, 1); assert.equal(await destinationCount(), 2);
      await pause(); await s.delivery!.tick(); await s.delivery!.tick();
      assert.equal(await destinationCount(), 3); assert.equal((await s.delivery!.status(s.client!)).pending, 0);
    });
    await t.test('delivery controls pause and resume independently while the ingestion lock is held', async () => {
      await reset(); const s = await ready();
      await corporateControl(s.cfg, 'corporate-pause');
      await stage(s, [record(999)]); await s.delivery!.tick(); assert.equal(await destinationCount(), 2);
      await corporateControl(s.cfg, 'corporate-status');
      await corporateControl(s.cfg, 'corporate-resume'); await s.delivery!.tick();
      assert.equal(await destinationCount(), 3);
    });
    await t.test('resume racing with an in-flight structural failure cannot clear its block', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      let entered = false, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const delivery = s.delivery!.tick({ beforeRemoteCommit: async () => {
        entered = true; await gate; throw new SyncError('EXISTING_CALL_DIVERGES');
      } });
      await eventually(() => entered);
      const rejected = assert.rejects(corporateControl(s.cfg, 'corporate-resume'), /CORPORATE_DELIVERY_BLOCKED/);
      await pause(20); release(); await delivery; await rejected;
      assert.equal((await s.delivery!.status(s.client!)).blocked, true);
      assert.equal(await destinationCount(), 2);
    });
    await t.test('an in-flight remote transaction does not block local capture; shutdown waits for its acknowledgement', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      let entered = false, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = s.delivery!.tick.bind(s.delivery!);
      s.delivery!.tick = () => original({ beforeRemoteCommit: async () => { entered = true; await gate; } });
      s.delivery!.kick(); await eventually(() => entered);
      try {
        const result = await stage(s, [record(998)]); assert.equal(result.queued, 1);
        let closed = false; const closing = close(s).then(() => { closed = true; });
        await pause(20); assert.equal(closed, false);
        release(); await closing;
      } finally { release(); }
      assert.equal(await destinationCount(), 3);
      assert.equal((await local.query("SELECT count(*)::int AS n FROM olos_http.corporate_outbox WHERE state='pending'")).rows[0].n, 1);
    });
    await t.test('ambiguous remote COMMIT does not acknowledge locally and safely recognizes remote result', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      await s.delivery!.tick({ afterRemoteCommit: async () => { throw new Error('synthetic connection termination without SQLSTATE'); } });
      assert.equal(await destinationCount(), 3); assert.equal((await s.delivery!.status(s.client!)).pending, 1);
      assert.equal((await s.delivery!.status(s.client!)).confirmed_count, '2');
      assert.equal((await s.delivery!.status(s.client!)).last_code, 'CORPORATE_COMMIT_UNKNOWN');
      await pause(); await s.delivery!.tick(); assert.equal((await s.delivery!.status(s.client!)).confirmed_count, '3');
      assert.equal(await destinationCount(), 3);
    });
    await t.test('failure after remote inserts rolls back; local COMMIT failure replays frozen data after restart', async () => {
      await reset(); let s = await ready(); await stage(s, [record(999)]);
      await s.delivery!.tick({ beforeRemoteCommit: async () => { throw Object.assign(new Error('synthetic'), { code: '40001' }); } });
      assert.equal(await destinationCount(), 2);
      await pause(); await assert.rejects(s.delivery!.tick({ beforeLocalCommit: async () => { throw new Error('synthetic local failure'); } }));
      assert.equal(await destinationCount(), 3); await close(s);
      s = await open(); await s.delivery!.tick(); assert.equal((await s.delivery!.status(s.client!)).pending, 0); assert.equal(await destinationCount(), 3);
    });
    await t.test('old source IDs retain their mapped internal IDs and cannot be confused with OLOS ID equality', async () => {
      await reset(); const s = await ready();
      const result = await stage(s, [record(100001), record(100002)]);
      assert.equal(result.queued, 0); assert.equal(result.duplicates, 2);
      await s.delivery!.tick(); assert.equal(await destinationCount(), 2);
      const map = (await local.query("SELECT target_id::text FROM olos_http.records WHERE source_id='100001'")).rows[0];
      assert.equal(map.target_id, '1');
      await assert.rejects(stage(s, [record(100001, { CallId: 'different' })]), /SOURCE_ID_CONTENT_CONFLICT/);
    });
    await t.test('undelivered legacy backlog is adopted with its existing ID without replicating new local table writes', async () => {
      await reset(); const legacy = new Store(config(base)); await legacy.open();
      await stage(legacy, [record(999)]); await legacy.close();
      const s = await ready(); assert.equal((await s.delivery!.status(s.client!)).pending, 1);
      assert.equal((await local.query("SELECT target_id::text,origin FROM olos_http.corporate_outbox WHERE source_id='999'")).rows[0].target_id, '3');
      await s.delivery!.tick(); assert.equal(await destinationCount(), 3);
      assert.equal((await remote.query('SELECT internal_id_olos FROM raw.olos_calls ORDER BY internal_id_olos DESC LIMIT 1')).rows[0].internal_id_olos, 3);
    });
    await t.test('missing corporate proof or a rewound allocator blocks adoption without repairing either database', async () => {
      await reset(); await remote.query('DELETE FROM raw.olos_calls WHERE internal_id_olos=1');
      let s = await open(); await assert.rejects(s.reconcileCorporate(), /LEGACY_RECEIPT_PROOF_MISMATCH/);
      assert.equal(await destinationCount(), 1); assert.equal(await count(local, 'corporate_sync.receipts'), 2);
      assert.equal(await count(local, 'olos_http.corporate_outbox'), 0);
      await reset(); await local.query("SELECT setval('raw.olos_calls_internal_id_olos_seq',1,true)");
      s = await open(); await assert.rejects(s.reconcileCorporate(), /LEGACY_ALLOCATOR_BEHIND/);
      assert.equal((await local.query('SELECT last_value::text FROM raw.olos_calls_internal_id_olos_seq')).rows[0].last_value, '1');
    });
    await t.test('partial-index internal ID collision does not overwrite and logical key at another ID blocks', async () => {
      for (const internalId of [3, 99]) {
        await reset(); const s = await ready(); await stage(s, [record(999)]);
        const payload = (await local.query("SELECT payload FROM olos_http.corporate_outbox WHERE state='pending'")).rows[0].payload;
        const other = { ...payload, internal_id_olos: String(internalId), ...(internalId === 3 ? { telefone: 'different' } : {}) };
        await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(name => other[name]));
        await s.delivery!.tick();
        assert.equal((await s.delivery!.status(s.client!)).last_code, internalId === 3 ? 'INTERNAL_ID_COLLISION' : 'LOGICAL_CALL_AT_DIFFERENT_ID');
        assert.equal(await destinationCount(), 3);
      }
    });
    await t.test('legacy receipt hash, missing mapping, pending old batch and wrong expected count block activation atomically', async () => {
      for (const mutation of [
        "UPDATE corporate_sync.receipts SET payload_hash=repeat('b',64) WHERE internal_id_olos=1",
        "UPDATE corporate_sync.control SET pending='[]'::jsonb",
        "DELETE FROM olos_http.records WHERE target_id=1",
      ]) {
        await reset(); await local.query(mutation);
        await assert.rejects(async () => { const s = await open(); await s.reconcileCorporate(); }, /LEGACY_|EXISTING_DESTINATION_REQUIRES_BASELINE/);
        assert.equal(await count(local, 'olos_http.corporate_outbox'), 0);
        assert.equal(await count(local, 'olos_http.corporate_control'), 0);
        assert.equal(await count(local, 'corporate_sync.receipts'), 2);
      }
      await reset(); const s = await open(makeConfig(3)); await assert.rejects(s.reconcileCorporate(), /LEGACY_STATE_NOT_RECONCILED/);
    });
    await t.test('schema drift and TLS hostname mismatch block corporate writes while capture continues', async () => {
      await reset(); const s = await ready(); await stage(s, [record(999)]);
      await remote.query('ALTER TABLE raw.olos_calls ALTER COLUMN raw_olos_call_id SET GENERATED BY DEFAULT');
      await s.delivery!.tick(); assert.equal((await s.delivery!.status(s.client!)).last_code, 'CORPORATE_IDENTITY_ALWAYS_REQUIRED');
      await reset(); const tls = await ready(); await stage(tls, [record(999)]);
      tls.cfg.corporateDelivery!.connection.destinationUrl = remoteUrl.toString().replace('localhost', '127.0.0.1');
      await tls.delivery!.tick(); assert.equal((await tls.delivery!.status(tls.client!)).blocked, true); assert.equal(await destinationCount(), 2);
    });
    await t.test('legacy lock prevents coexistence; persistent ownership prevents standalone sync and fallback', async () => {
      await reset(); await local.query('SELECT pg_advisory_lock(17320914,1)');
      const blocked = new Store(makeConfig()); await assert.rejects(blocked.open(), /CORPORATE_SYNC_STILL_RUNNING/); await blocked.close();
      await local.query('SELECT pg_advisory_unlock(17320914,1)');
      const s = await ready(); await close(s);
      await assert.rejects(assertNoDirectOwnership(local), /DIRECT_DELIVERY_OWNS_DESTINATION/);
      const fallback = new Store(config(base)); await assert.rejects(fallback.open(), /DIRECT_DELIVERY_OWNS_DESTINATION/); await fallback.close();
    });
    await t.test('12105 old receipts migrate without re-insertion and retain all original checkpoints and receipts', async () => {
      const cfg = await reset(12105);
      const controlBefore = (await local.query('SELECT * FROM corporate_sync.control')).rows;
      const sequenceBefore = (await remote.query('SELECT last_value::text FROM raw.olos_calls_raw_olos_call_id_seq')).rows[0].last_value;
      const s = await ready(cfg);
      assert.equal((await s.delivery!.status(s.client!)).confirmed_count, '12105');
      assert.equal((await s.delivery!.status(s.client!)).pending, 0);
      await s.delivery!.tick(); await s.reconcileCorporate();
      assert.equal(await destinationCount(), 12105); assert.equal(await count(local, 'corporate_sync.receipts'), 12105);
      assert.deepEqual((await local.query('SELECT * FROM corporate_sync.control')).rows, controlBefore);
      assert.equal((await remote.query('SELECT last_value::text FROM raw.olos_calls_raw_olos_call_id_seq')).rows[0].last_value, sequenceBefore);
      assert.equal(await count(local, 'olos_http.records'), 12105);
    });
    await t.test('12605 receipts are adopted with hashes, mappings, checkpoints, identity and backlog preserved; count mismatches still block', async () => {
      await reset(12605);
      const cfg = makeConfig(12605, { OLOS_CORPORATE_LEGACY_EXPECTED_COUNT: undefined });
      assert.equal(cfg.corporateDelivery!.expectedLegacyCount, 12605);
      // Model the reported checkpoint only in the disposable fixture; keep a small pending backlog.
      await local.query('UPDATE corporate_sync.control SET generation=27,last_confirmed_id=12605 WHERE singleton');
      const legacy = new Store(config(base));
      await legacy.open();
      try { await stage(legacy, [record(900001), record(900002), record(900003)]); }
      finally { await legacy.close(); }

      const snapshot = async () => ({
        control: (await local.query('SELECT * FROM corporate_sync.control')).rows,
        receipts: (await local.query('SELECT * FROM corporate_sync.receipts ORDER BY internal_id_olos')).rows,
        records: (await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows,
        reads: (await local.query('SELECT * FROM olos_http.reads ORDER BY id')).rows,
        localSequence: (await local.query('SELECT last_value::text,is_called FROM raw.olos_calls_internal_id_olos_seq')).rows,
        corporateSequence: (await remote.query('SELECT last_value::text,is_called FROM raw.olos_calls_raw_olos_call_id_seq')).rows,
        corporateRows: (await remote.query('SELECT * FROM raw.olos_calls ORDER BY internal_id_olos')).rows,
      });
      const before = await snapshot();
      assert.equal(before.control[0].version, 1);
      assert.equal(before.control[0].generation, '27');
      assert.equal(before.control[0].last_confirmed_id, '12605');
      assert.equal(before.control[0].confirmed_count, '12605');
      assert.equal(before.control[0].pending, null);
      assert.equal(before.receipts.length, 12605);
      assert.equal(new Set(before.receipts.map(row => row.internal_id_olos)).size, 12605);
      assert.equal(before.receipts[0].internal_id_olos, '1');
      assert.equal(before.receipts.at(-1)!.internal_id_olos, '12605');
      assert.equal(before.records.length, 12608);

      for (const expected of [12105, 12604, 12606]) {
        const rejected = await open(makeConfig(expected));
        try { await assert.rejects(rejected.reconcileCorporate(), /LEGACY_STATE_NOT_RECONCILED/); }
        finally { await close(rejected); }
        assert.equal(await count(local, 'olos_http.corporate_control'), 0);
        assert.equal(await count(local, 'olos_http.corporate_outbox'), 0);
      }
      assert.deepEqual(await snapshot(), before);

      const s = await open(cfg);
      assert.equal(await s.reconcileCorporate(), 12605);
      const state = await s.delivery!.status(s.client!);
      assert.equal(state.ready, true); assert.equal(state.paused, true);
      assert.equal(state.legacy_count, '12605'); assert.equal(state.confirmed_count, '12605');
      assert.equal(state.pending, 3);

      const receiptHashes = new Map(before.receipts.map(row => [row.internal_id_olos as string, row.payload_hash as string]));
      const corporateIds = new Map(before.corporateRows.map(row => [String(row.internal_id_olos), row.raw_olos_call_id as string]));
      const { shape } = await corporateSchema(remote, cfg.corporateDelivery!, false);
      const p = projection(shape, 's', true, cfg.corporateDelivery!.connection);
      const sourcePayloads = new Map((await local.query(`SELECT ${p.sql} FROM raw.olos_calls s`, p.parameters)).rows
        .map(raw => { const row = mapRow(raw, shape, cfg.corporateDelivery!.connection); return [row.internal_id_olos!, row] as const; }));
      const adopted = (await local.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows;
      assert.equal(adopted.length, before.records.length);
      for (let i = 0; i < adopted.length; i++) {
        const entry = adopted[i]!, previous = before.records[i]!, id = String(entry.target_id);
        assert.equal(entry.source_key, previous.source_key);
        assert.equal(entry.source_id, previous.source_id);
        assert.equal(id, previous.target_id);
        assert.notEqual(entry.source_id, id);
        assert.equal(entry.source_hash, previous.source_hash);
        assert.deepEqual(entry.payload, sourcePayloads.get(id));
        assert.equal(entry.payload_hash, digest(entry.payload));
        if (receiptHashes.has(id)) {
          assert.equal(entry.origin, 'legacy_receipt'); assert.equal(entry.state, 'confirmed');
          assert.equal(entry.payload_hash, receiptHashes.get(id));
          assert.equal(entry.remote_raw_id, corporateIds.get(id)); assert.ok(entry.confirmed_at);
        } else {
          assert.equal(entry.origin, 'legacy_backlog'); assert.equal(entry.state, 'pending');
          assert.equal(entry.remote_raw_id, null); assert.equal(entry.confirmed_at, null);
        }
      }
      assert.equal(await s.reconcileCorporate(), 12605);
      await s.delivery!.tick(); // Adoption remains paused: no backlog dispatch or re-insertion.
      assert.deepEqual((await local.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows, adopted);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await destinationCount(), 12605);
    });
    await t.test('scheduler continues real capture during corporate outage and controls pause/resume/shutdown', async () => {
      await reset(); const s = await ready();
      const saved = s.cfg.corporateDelivery!.connection.destinationUrl;
      s.cfg.corporateDelivery!.connection.destinationUrl = 'postgresql://postgres@localhost:1/madm';
      let captures = 0;
      const auth = new OlosAuthManager(async () => JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, token_type: 'bearer' }),
        { username: 'synthetic', password: 'synthetic', clientId: 'synthetic', clientSecret: 'synthetic' });
      const api = new OlosApi(async path => {
        if (path.endsWith('available-tables')) return JSON.stringify([
          { TableName: 'AttemptsRawData', Columns: ['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId'] },
          { TableName: 'Users', Columns: ['AgentId','UserName'] }, { TableName: 'Campaign', Columns: ['CampaignId','Description'] },
          { TableName: 'Disposition', Columns: ['DispositionId','Description'] },
        ]);
        if (path.endsWith('/read-data')) return '[]';
        return JSON.stringify([record(900 + ++captures)]);
      }, auth, async () => {});
      const worker = new Worker(s, api, new StaticCache(api, 3600000));
      const settings: Settings = { enabled: true, desired_state: 'RUNNING', runtime_state: 'STOPPED', interval_ms: 60000, last_error: null, updated_at: 'synthetic', updated_by: 'test' };
      const repo: SchedulerRepository = {
        async settings() { return { ...settings }; },
        async change(_, patch) { if (patch.mode) settings.desired_state = patch.mode; },
        async state(value) { settings.runtime_state = value; },
      };
      let now = Date.now();
      const consumer: ScheduledConsumer = {
        async cycle() { await worker.cycle(); },
        suspendDelivery() { s.delivery!.suspend(); }, resumeDelivery() { s.delivery!.allow(); },
        async settleDelivery() { await s.delivery!.settle(); }, async close() { await close(s); },
      };
      const scheduler = new DynamicScheduler(repo, async () => consumer, 5, true, { now: () => now, wait: () => pause() }, () => {});
      const running = scheduler.run();
      try {
        await eventually(() => captures >= 1 && !scheduler.status().cycle_in_progress);
        await s.delivery!.settle(); now += 60000;
        await eventually(() => captures >= 2 && !scheduler.status().cycle_in_progress);
        await scheduler.request('test', { mode: 'PAUSED' }); await eventually(() => scheduler.status().state === 'PAUSED');
        const atPause = captures; now += 600000; await pause(30); assert.equal(captures, atPause);
        assert.equal((await s.unresolved()).length, 0); assert.ok((await s.delivery!.status(s.client!)).pending >= 2);
        assert.equal((await local.query("SELECT count(*)::int AS n FROM olos_http.reads WHERE state='done' AND response_body IS NULL")).rows[0].n, 0);
        s.cfg.corporateDelivery!.connection.destinationUrl = saved;
        await scheduler.request('test', { mode: 'RUNNING' }); await eventually(() => captures > atPause && !scheduler.status().cycle_in_progress);
        await s.delivery!.settle(); assert.ok(await destinationCount() >= 4);
      } finally { scheduler.shutdown(); await running; }
      assert.equal(scheduler.status().state, 'STOPPED');
    });
  } finally { for (const s of stores.splice(0)) await s.close().catch(() => {}); await local.end(); await remote.end(); }
});
