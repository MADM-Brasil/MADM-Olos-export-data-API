import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { columns, digest } from '../src/corporate-sync/mapping.js';
import { observeLogs } from '../src/errors.js';
import { corporateControl } from '../src/corporate-delivery/commands.js';
import { logVerification, recoverCollision, recoveryRequest, verifyPending, type RecoveryHooks } from '../src/corporate-delivery/recovery.js';
import { fixture } from './corporate-sync.fixture.js';

const enabled = process.env.OLOS_DIRECT_DISPOSABLE_TEST === 'true';
const authorization = { OLOS_CORPORATE_RECOVERY_CONFIRMATION: 'AUTHORIZE_CORPORATE_COLLISION_RECOVERY' };
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
    await remote.query('DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE');
    await local.query(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8'));
    for (const name of ['001_ingestion.sql','corporate-sync/001_control.sql','002_corporate_delivery.sql','003_corporate_outbox_skipped.sql','005_corporate_campaign_policy.sql','006_corporate_collision_recovery.sql']) {
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
  const control = async () => (await local.query('SELECT * FROM olos_http.corporate_control')).rows[0];
  const entries = async () => (await local.query('SELECT * FROM olos_http.corporate_outbox ORDER BY target_id')).rows;
  const evidenceCount = async () => (await local.query('SELECT count(*)::int AS n FROM olos_http.corporate_collision_recoveries')).rows[0].n;
  async function snapshot() {
    return { control: await control(), entries: await entries(), records: (await local.query('SELECT * FROM olos_http.records ORDER BY target_id')).rows,
      reads: (await local.query('SELECT * FROM olos_http.reads ORDER BY id')).rows,
      remote: (await remote.query('SELECT * FROM raw.olos_calls ORDER BY raw_olos_call_id')).rows,
      sequence: (await remote.query('SELECT * FROM raw.olos_calls_raw_olos_call_id_seq')).rows };
  }
  async function insertRemote(index: number, changes: Record<string, unknown> = {}) {
    const payload = { ...(await entries())[index]!.payload, ...changes };
    await remote.query(`INSERT INTO raw.olos_calls(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(name => payload[name]));
  }
  try {
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
      await assert.rejects(client(async db => {
        const ambiguous = new Proxy(db, { get(connection, key) {
          if (key === 'query') return async (sql: string, parameters?: unknown[]) => {
            const result = await connection.query(sql, parameters);
            if (sql === 'COMMIT') throw new Error('synthetic lost commit acknowledgement');
            return result;
          };
          return Reflect.get(connection, key);
        } });
        return recoverCollision(ambiguous, dc, source, target, recoveryRequest(input, authorization, source));
      }), /RECOVERY_COMMIT_UNKNOWN/);
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
    await t.test('audit migration can be reapplied without changing the queue or evidence', async () => {
      await reset(1); await recover(args((await verify()).verification_digest)); const before = await snapshot();
      await local.query(await readFile(new URL('../migrations/006_corporate_collision_recovery.sql', import.meta.url), 'utf8'));
      assert.equal(await evidenceCount(), 1); assert.deepEqual(await snapshot(), before);
    });
  } finally { await store?.close(); await pool.end(); await local.end(); await remote.end(); }
});
