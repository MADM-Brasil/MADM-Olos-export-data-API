import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type pg from 'pg';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { OlosApi } from '../src/api.js';
import { OlosAuthManager } from '../src/auth.js';
import { HttpTransport } from '../src/http.js';
import { StaticCache } from '../src/cache.js';
import { columns } from '../src/mapping.js';
import { observeLogs } from '../src/errors.js';

const catalog = [
  { TableName: 'AttemptsRawData', Columns: ['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId'] },
  { TableName: 'Users', Columns: ['AgentId','UserName'] },
  { TableName: 'Campaign', Columns: ['CampaignId','Description'] },
  { TableName: 'Disposition', Columns: ['DispositionId','Description'] },
];
type Read = { id: string; state: string; response_body: string | null; processed_count: number; error_code?: string };

// SQL boundary double: exercise the real Store methods without DB writes or migrations.
// Every unrecognized SQL statement fails; in particular target/marker writes are forbidden.
function database() {
  const reads: Read[] = [];
  const queries: string[] = [];
  const state = { locked: false, failStage: false, loseStageAck: false, failIntent: false, failPing: false };
  const connect = () => {
    let ownsLock = false;
    return {
      on() {},
      release() { if (ownsLock) state.locked = false; },
      async query(sql: string, values: unknown[] = []) {
        queries.push(sql);
        const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
        if (sql.includes("to_regclass('olos_http.corporate_control')")) return result([{ present: false }]);
        if (sql.includes('pg_try_advisory_lock')) {
          ownsLock = !state.locked; state.locked = true;
          return result([{ acquired: ownsLock }]);
        }
        if (sql.includes('information_schema.columns')) return result([
          { column_name: 'internal_id_olos', udt_name: 'int8' },
          ...columns.map(column_name => ({ column_name, udt_name: column_name === 'data_ligacao' ? 'timestamptz' : column_name === 'tma_origem' ? 'numeric' : 'text', is_nullable: 'YES', is_generated: 'NEVER' })),
        ]);
        if (sql.includes('FROM pg_constraint')) return result([{ contype: 'p', definition: 'PRIMARY KEY (internal_id_olos)' }]);
        if (sql.includes('FROM pg_indexes')) return result();
        if (sql.includes('FROM pg_class')) return result([{ extra_unique: false, relrowsecurity: false, triggers: 0 }]);
        if (sql.includes('pg_get_serial_sequence')) return result([{ name: 'raw.test_seq' }]);
        if (sql.includes('has_table_privilege') || sql.includes('has_sequence_privilege')) return result([{ ok: true }]);
        if (sql.startsWith('SET TIME ZONE') || sql.includes('target_table<>') || sql.startsWith('SELECT 1 FROM "raw"')) return result();
        if (sql === 'SELECT 1') { if (state.failPing) throw new Error('simulated DB outage'); return result([{}]); }
        if (sql.startsWith('SELECT id,spec,state')) return result(reads.filter(r => ['reading','received'].includes(r.state)).map(r => ({ ...r })));
        if (sql.startsWith('INSERT INTO olos_http.reads')) {
          if (state.failIntent) throw new Error('simulated intent failure');
          reads.push({ id: String(values[0]), state: 'reading', response_body: null, processed_count: 0 });
          return result([], 1);
        }
        if (sql.startsWith('UPDATE olos_http.reads SET response_body=')) {
          if (state.failStage) throw new Error('simulated persistence failure');
          const read = reads.find(r => r.id === values[0] && r.state === 'reading');
          if (!read) return result();
          read.response_body = String(values[1]); read.state = 'received';
          if (state.loseStageAck) throw new Error('simulated acknowledgement loss');
          return result([], 1);
        }
        if (sql.startsWith('UPDATE olos_http.reads SET error_code=')) {
          const read = reads.find(r => r.id === values[0]);
          if (read) read.error_code = String(values[1]);
          return result([], read ? 1 : 0);
        }
        throw new Error('Unexpected SQL in capture test');
      },
    } as unknown as pg.PoolClient;
  };
  return { reads, queries, state, connect };
}

async function fixture(t: TestContext, options: { body?: string; authStatus?: number; catalogStatus?: number; readStatus?: number; timeout?: boolean } = {}) {
  const db = database();
  const calls: string[] = [];
  const logs: string[] = [];
  const unsubscribe = observeLogs(entry => {
    logs.push(JSON.stringify(entry));
  });
  t.after(() => unsubscribe());
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    calls.push(req.url!);
    if (req.url === '/api/auth') {
      assert.match(body, /name="grant_type"\r\n\r\npassword/);
      res.writeHead(options.authStatus ?? 200);
      res.end(JSON.stringify({ access_token: 'PRIVATE_TOKEN', refresh_token: 'PRIVATE_REFRESH', token_type: 'bearer', expires_in: 3600 }));
    } else if (req.url === '/api/export-data/available-tables') {
      res.writeHead(options.catalogStatus ?? 200); res.end(JSON.stringify(catalog));
    } else if (req.url === '/api/export-data/read-data-current-day') {
      assert.equal(req.method, 'POST');
      assert.match(req.headers['content-type']!, /^multipart\/form-data/);
      assert.match(body, /name="TableName"\r\n\r\nAttemptsRawData/);
      assert.equal(db.reads.at(-1)!.state, 'reading'); // intent precedes network effect
      if (options.timeout) return;
      res.writeHead(options.readStatus ?? 200); res.end(options.body ?? '[]');
    } else { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const cfg = config({ DATABASE_URL: 'postgresql://unused@127.0.0.1:1/test', OLOS_SOURCE_KEY: 'capture-test', SOURCE_ID_UNIQUENESS_CONFIRMED: 'false' });
  const stores: Store[] = [];
  const http = new HttpTransport(`http://127.0.0.1:${address.port}`, options.timeout ? 100 : 2000, 10000, new AbortController().signal);
  const api = new OlosApi(http.request, new OlosAuthManager(http.request, { username: 'fixture', password: 'PRIVATE_PASSWORD', clientId: 'fixture', clientSecret: 'PRIVATE_SECRET' }));
  const makeStore = () => {
    const store = new Store(cfg); stores.push(store);
    t.mock.method(store.pool, 'connect', async () => db.connect());
    return store;
  };
  const makeWorker = (store: Store) => new Worker(store, api, new StaticCache(api, 3600000));
  t.after(async () => {
    await http.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const store of stores) if (store.client) await store.close();
    const writes = db.queries.filter(sql => /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql));
    assert(writes.every(sql => /^(INSERT INTO|UPDATE) olos_http\.reads\b/.test(sql)));
    assert.doesNotMatch(logs.join(''), /PRIVATE_|AttemptsRawDataID|OriginalPhoneNumber/);
  });
  const store = makeStore(); await store.open();
  return { db, calls, store, makeStore, makeWorker, worker: makeWorker(store), logs };
}

for (const [label, body] of [
  ['records', ' \r\n[{"AttemptsRawDataID":9007199254740993,"OriginalPhoneNumber":"PRIVATE_PHONE"}]\n'],
  ['empty', ' []\r\n'],
  ['unconfirmed JSON envelope', '{"unknown":"PRIVATE_VALUE"}'],
  ['UTF-8 BOM', '\uFEFF[]'],
] as const) test(`capture ${label}: exact body received without normalization, destination or marker writes`, async t => {
  const f = await fixture(t, { body });
  const id = await f.worker.captureOnce();
  assert.equal(f.db.reads[0]!.id, id);
  assert.equal(f.db.reads[0]!.response_body, body);
  assert.equal(f.db.reads[0]!.state, 'received');
  assert.equal(f.db.reads[0]!.processed_count, 0);
  assert.deepEqual(f.calls, ['/api/auth','/api/export-data/available-tables','/api/export-data/read-data-current-day']);
  assert.match(f.logs.join(''), /capture_received/);
  await assert.rejects(f.worker.captureOnce(), /RECOVERY_REQUIRED/);
  assert.equal(f.calls.length, 3);
});

test('capture authentication failure creates no intent and sends no data request', async t => {
  const f = await fixture(t, { authStatus: 401 });
  await assert.rejects(f.worker.captureOnce(), /HTTP_401/);
  assert.deepEqual(f.calls, ['/api/auth']); assert.equal(f.db.reads.length, 0);
});
test('capture catalog failure does not retry, create intent or consume', async t => {
  const f = await fixture(t, { catalogStatus: 503 });
  await assert.rejects(f.worker.captureOnce(), /HTTP_503/);
  assert.equal(f.calls.length, 2); assert.equal(f.db.reads.length, 0);
});
test('capture HTTP timeout leaves reading and blocks further requests after restart', async t => {
  const f = await fixture(t, { timeout: true });
  await assert.rejects(f.worker.captureOnce(), /RECOVERY_REQUIRED/);
  assert.equal(f.db.reads[0]!.state, 'reading');
  await f.store.close();
  const next = f.makeStore(); await next.open();
  await assert.rejects(f.makeWorker(next).captureOnce(), /RECOVERY_REQUIRED/);
  assert.equal(f.calls.length, 3);
});
for (const status of [401,403,429,500,421]) test(`capture HTTP ${status} never refreshes/retries the transactional POST`, async t => {
  const f = await fixture(t, { readStatus: status });
  await assert.rejects(f.worker.captureOnce(), /RECOVERY_REQUIRED/);
  assert.equal(f.db.reads[0]!.state, 'reading');
  assert.equal(f.db.reads[0]!.error_code, `HTTP_${status}`);
  assert.equal(f.calls.length, 3);
});
for (const ackLost of [false,true]) test(`capture response persistence failure (ack lost=${ackLost}) stays unresolved`, async t => {
  const f = await fixture(t, { body: '[{"unconfirmed":"PRIVATE_VALUE"}]' });
  f.db.state.failStage = !ackLost; f.db.state.loseStageAck = ackLost;
  await assert.rejects(f.worker.captureOnce(), /RECOVERY_REQUIRED/);
  assert.equal(f.db.reads[0]!.state, ackLost ? 'received' : 'reading');
  await assert.rejects(f.worker.captureOnce(), /RECOVERY_REQUIRED/);
  assert.equal(f.calls.length, 3);
});
test('capture requires exclusive source lock and rejects overlapping operation', async t => {
  const f = await fixture(t);
  const second = f.makeStore(); await assert.rejects(second.open(), /CONSUMER_ALREADY_ACTIVE/);
  const running = f.worker.captureOnce();
  await assert.rejects(f.worker.captureOnce(), /POLL_ALREADY_ACTIVE/);
  await running; assert.equal(f.calls.length, 3);
});
test('capture cannot consume if intent persistence fails', async t => {
  const f = await fixture(t); f.db.state.failIntent = true;
  await assert.rejects(f.worker.captureOnce());
  assert.equal(f.calls.length, 2); assert.equal(f.db.reads.length, 0);
});
test('capture cannot authenticate or consume when database ping fails', async t => {
  const f = await fixture(t); f.db.state.failPing = true;
  await assert.rejects(f.worker.captureOnce());
  assert.equal(f.calls.length, 0); assert.equal(f.db.reads.length, 0);
});
