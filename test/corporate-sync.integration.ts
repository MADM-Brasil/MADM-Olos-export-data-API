import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type Client } from 'pg';
import type { Config } from '../src/corporate-sync/config.js';
import { lock, migrate } from '../src/corporate-sync/database.js';
import { SyncError } from '../src/corporate-sync/errors.js';
import { columns, type Row } from '../src/corporate-sync/mapping.js';
import { run } from '../src/corporate-sync/worker.js';
import { fixture, row, testConfig } from './corporate-sync.fixture.js';

// Only the isolated runner can opt in. Never use DATABASE_URL or operational/corporate credentials.
const sourceUrl = process.env.CORPORATE_SYNC_TEST_SOURCE_URL;
const destinationUrl = process.env.CORPORATE_SYNC_TEST_DESTINATION_URL;
const enabled = process.env.CORPORATE_SYNC_DISPOSABLE_TEST === 'true';
function guard(url: string | undefined, database: string): string {
  const parsed = new URL(url ?? '');
  assert.match(parsed.hostname, /^corporate-sync-pg-[a-z0-9-]+$/);
  assert.equal(parsed.pathname, `/${database}`);
  assert.equal(parsed.username, 'postgres');
  assert.equal(parsed.password, '');
  assert.equal(parsed.search, '');
  return parsed.toString();
}

test('corporate-sync isolated PostgreSQL integration', { skip: !enabled }, async t => {
  const source = new pg.Client({ connectionString: guard(sourceUrl, 'corporate_sync_test_source') });
  const destination = new pg.Client({ connectionString: guard(destinationUrl, 'corporate_sync_test_destination') });
  await source.connect(); await destination.connect();
  const cfg = (overrides: NodeJS.ProcessEnv = {}): Config => testConfig({
    CORPORATE_SYNC_SOURCE_URL: sourceUrl!, CORPORATE_SYNC_DESTINATION_URL: destinationUrl!, ...overrides,
  });
  const sync = (value = cfg(), hooks = {}) => run(value, new AbortController().signal, hooks);
  async function reset(withControls = true): Promise<void> {
    await source.query('ROLLBACK'); await destination.query('ROLLBACK');
    await source.query('DROP SCHEMA IF EXISTS corporate_sync CASCADE; DROP SCHEMA IF EXISTS raw CASCADE');
    await destination.query(
      'DROP SCHEMA IF EXISTS raw CASCADE; DROP SCHEMA IF EXISTS core CASCADE'
    );
    await source.query(fixture(true)); await destination.query(fixture(false));
    if (withControls) await migrate(source);
  }
  async function insert(db: Client, value: Row, extra = ''): Promise<void> {
    await db.query(`INSERT INTO raw.olos_calls (${columns.join(',')}${extra ? ',kommo_status_processamento' : ''})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}${extra ? ",'SYNTHETIC'" : ''})`, columns.map(name => value[name]));
  }
  async function count(db: Client, table = 'raw.olos_calls'): Promise<number> {
    return Number((await db.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);
  }
  async function state(): Promise<Record<string, unknown>> {
    return (await source.query('SELECT generation::text, confirmed_count::text, last_confirmed_id::text, pending FROM corporate_sync.control')).rows[0];
  }
  try {
    await t.test('local migration is idempotent and absent from destination', async () => {
      await reset(); await migrate(source);
      assert.equal((await destination.query("SELECT to_regclass('corporate_sync.control') AS table_name")).rows[0].table_name, null);
      assert.equal(await count(source, 'corporate_sync.receipts'), 0);
    });
    await t.test('check and dry-run work with read-only sessions and no migration; no writes on either side', async () => {
      await reset(false); await insert(source, row());
      const read = cfg();
      await source.query("ALTER DATABASE corporate_sync_test_source SET default_transaction_read_only=on");
      await destination.query("ALTER DATABASE corporate_sync_test_destination SET default_transaction_read_only=on");
      try {
        await sync({ ...read, mode: 'check', writeEnabled: false, identityConfirmed: false, tmaConfirmed: false });
        await sync({ ...read, mode: 'dry-run', writeEnabled: false, identityConfirmed: false, tmaConfirmed: false });
      } finally {
        await source.query('ALTER DATABASE corporate_sync_test_source RESET default_transaction_read_only');
        await destination.query('ALTER DATABASE corporate_sync_test_destination RESET default_transaction_read_only');
      }
      assert.equal(await count(destination), 0);
      assert.equal((await source.query("SELECT to_regclass('corporate_sync.control') AS name")).rows[0].name, null);
    });
    await t.test('bounded incremental batches, repeated CallId, omitted raw and kommo fields', async () => {
      await reset();
      for (const id of ['1', '2', '3']) await insert(source, { ...row(id), telefone: `synthetic-${id}` }, 'extras');
      await sync(); assert.equal(await count(destination), 2);
      await sync(); await sync(); assert.equal(await count(destination), 3);
      assert.equal(await count(source, 'corporate_sync.receipts'), 3);
      assert.equal((await state()).confirmed_count, '3');
      const result = await destination.query('SELECT raw_olos_call_id, kommo_status_processamento, data_ligacao::text FROM raw.olos_calls');
      assert.ok(result.rows.every(r => r.raw_olos_call_id !== null && r.kommo_status_processamento === null && r.data_ligacao.includes('.123456')));
    });
    await t.test('late commits below last ID are not lost by the checkpoint', async () => {
      await reset(); await insert(source, row('10')); await sync();
      await insert(source, { ...row('2'), telefone: 'late' }); await sync();
      assert.equal(await count(destination), 2); assert.equal((await state()).confirmed_count, '2');
      assert.equal((await state()).last_confirmed_id, '2');
    });
    await t.test('remote commit followed by crash replays frozen payload and preserves corporate kommo', async () => {
      await reset(); await insert(source, row(), 'extras');
      await assert.rejects(sync(cfg(), { afterRemoteCommit: async () => { throw new SyncError('TEST_CRASH'); } }), /TEST_CRASH/);
      assert.equal(await count(destination), 1); assert.equal(await count(source, 'corporate_sync.receipts'), 0);
      assert.equal((await state()).generation, '0'); assert.ok((await state()).pending);
      await source.query("UPDATE raw.olos_calls SET nome_agente='changed after frozen batch'");
      await destination.query("UPDATE raw.olos_calls SET kommo_status_processamento='PROCESSED'");
      await sync(); assert.equal(await count(destination), 1);
      assert.equal((await state()).generation, '1'); assert.equal((await state()).pending, null);
      const actual = (await destination.query('SELECT nome_agente,kommo_status_processamento FROM raw.olos_calls')).rows[0];
      assert.deepEqual(actual, { nome_agente: 'Synthetic Agent', kommo_status_processamento: 'PROCESSED' });
    });
    await t.test('ambiguous commit retries the same batch and confirms an exact duplicate', async () => {
      await reset(); await insert(source, row()); let attempts = 0;
      await sync(cfg(), { afterRemoteCommit: async () => { if (attempts++ === 0) throw Object.assign(new Error('secret'), { code: 'ECONNRESET' }); } });
      assert.equal(attempts, 2); assert.equal(await count(destination), 1); assert.equal((await state()).confirmed_count, '1');
    });
    await t.test('failure after remote inserts rolls them all back without local acknowledgement', async () => {
      await reset(); await insert(source, row()); await insert(source, { ...row('2'), telefone: 'two' });
      await assert.rejects(sync(cfg(), { beforeRemoteCommit: async () => { throw new SyncError('TEST_REMOTE_ROLLBACK'); } }), /TEST_REMOTE_ROLLBACK/);
      assert.equal(await count(destination), 0); assert.equal((await state()).confirmed_count, '0');
      assert.equal(await count(source, 'corporate_sync.receipts'), 0); assert.ok((await state()).pending);
      await sync(); assert.equal(await count(destination), 2);
    });
    await t.test('failure before local commit rolls back both receipts and checkpoint then safely replays', async () => {
      await reset(); await insert(source, row());
      await assert.rejects(sync(cfg(), { beforeLocalCommit: async () => { throw new SyncError('TEST_LOCAL_ROLLBACK'); } }), /TEST_LOCAL_ROLLBACK/);
      assert.equal(await count(destination), 1); assert.equal((await state()).generation, '0');
      assert.equal(await count(source, 'corporate_sync.receipts'), 0); assert.ok((await state()).pending);
      await sync(); assert.equal((await state()).confirmed_count, '1'); assert.equal(await count(destination), 1);
    });
    await t.test('retry exhaustion preserves the frozen batch and never acknowledges failed transactions', async () => {
      await reset(); await insert(source, row()); let attempts = 0;
      await assert.rejects(sync(cfg({ CORPORATE_SYNC_MAX_RETRIES: '2' }), { beforeRemoteCommit: async () => {
        attempts++; throw Object.assign(new Error('synthetic'), { code: '40001' });
      } }));
      assert.equal(attempts, 3); assert.equal(await count(destination), 0); assert.equal((await state()).confirmed_count, '0');
      assert.ok((await state()).pending);
    });
    await t.test('stop before remote commit rolls back; stop after acknowledged remote commit completes checkpoint', async () => {
      await reset(); await insert(source, row()); const before = new AbortController();
      await assert.rejects(run(cfg(), before.signal, { beforeRemoteCommit: async () => { before.abort(); } }), /STOP_REQUESTED/);
      assert.equal(await count(destination), 0); assert.equal((await state()).confirmed_count, '0');
      const after = new AbortController();
      await run(cfg(), after.signal, { afterRemoteCommit: async () => { after.abort(); } });
      assert.equal(await count(destination), 1); assert.equal((await state()).confirmed_count, '1');
    });
    await t.test('existing identical record is acknowledged without overwriting extras', async () => {
      await reset(); await insert(source, row()); await insert(destination, row(), 'extras'); await sync();
      assert.equal((await destination.query('SELECT kommo_status_processamento,raw_olos_call_id::text FROM raw.olos_calls')).rows[0].kommo_status_processamento, 'SYNTHETIC');
      assert.equal(await count(source, 'corporate_sync.receipts'), 1);
    });
    await t.test('PK collision rolls back the whole batch and retains pending/checkpoint', async () => {
      await reset(); await insert(source, row()); await insert(source, { ...row('2'), telefone: 'two' });
      await insert(destination, { ...row('2'), telefone: 'unrelated' });
      await assert.rejects(sync(), /INTERNAL_ID_COLLISION/);
      assert.equal(await count(destination), 1); assert.equal((await state()).confirmed_count, '0');
      assert.ok((await state()).pending); assert.equal(await count(source, 'corporate_sync.receipts'), 0);
    });
    await t.test('same logical identity but different payload blocks without overwrite', async () => {
      await reset(); await insert(source, row()); await insert(destination, { ...row(), nome_agente: 'corporate original' });
      await assert.rejects(sync(), /EXISTING_CALL_DIVERGES/);
      assert.equal((await destination.query('SELECT nome_agente FROM raw.olos_calls')).rows[0].nome_agente, 'corporate original');
    });
    await t.test('logical call under another internal ID blocks, including duplicates within a batch', async () => {
      await reset(); await insert(source, row()); await insert(destination, row('99'));
      await assert.rejects(sync(), /LOGICAL_CALL_AT_DIFFERENT_ID/);
      await reset(); await insert(source, row()); await insert(source, row('2'));
      await assert.rejects(sync(), /DUPLICATE_LOGICAL_IDENTITY/); assert.equal(await count(destination), 0);
    });
    await t.test('fraction policy blocks by default; explicit truncate and round policies are applied', async () => {
      await reset(); await insert(source, { ...row(), tma_origem: '10.6' });
      await assert.rejects(sync(), /TMA_FRACTION_REJECTED/); assert.equal(await count(destination), 0);
      await reset(); await insert(source, { ...row(), tma_origem: '10.6' });
      await sync(cfg({ CORPORATE_SYNC_TMA_POLICY: 'truncate', CORPORATE_SYNC_TMA_CONFIRMATION: 'CONFIRM_TMA_truncate' }));
      assert.equal((await destination.query('SELECT tma_origem FROM raw.olos_calls')).rows[0].tma_origem, 10);
      await reset(); await insert(source, { ...row(), tma_origem: '10.6' });
      await sync(cfg({ CORPORATE_SYNC_TMA_POLICY: 'round-half-away', CORPORATE_SYNC_TMA_CONFIRMATION: 'CONFIRM_TMA_round-half-away' }));
      assert.equal((await destination.query('SELECT tma_origem FROM raw.olos_calls')).rows[0].tma_origem, 11);
    });
    await t.test('out-of-range and incomplete identities cause zero corporate writes', async () => {
      for (const invalid of [{ ...row(), tma_origem: '2147483648' }, { ...row(), id_campanha_olos: null }]) {
        await reset(); await insert(source, invalid);
        await assert.rejects(sync(), /INTEGER_OUT_OF_RANGE|REQUIRED_VALUE_MISSING/);
        assert.equal(await count(destination), 0);
      }
    });
    await t.test('timestamp without zone requires confirmation; microseconds survive conversion', async () => {
      await reset(); await destination.query('ALTER TABLE raw.olos_calls ALTER COLUMN data_ligacao TYPE timestamp');
      await insert(source, row()); await assert.rejects(sync(), /TIMESTAMP_SEMANTICS_NOT_CONFIRMED/);
      await sync(cfg({ CORPORATE_SYNC_TIMESTAMP_ZONE: 'America/Sao_Paulo', CORPORATE_SYNC_TIMESTAMP_CONFIRMATION: 'CONFIRM_TIMESTAMP_America/Sao_Paulo' }));
      assert.equal((await destination.query('SELECT data_ligacao::text AS time FROM raw.olos_calls')).rows[0].time, '2026-01-01 09:00:00.123456');
    });
    await t.test('incompatible types, default ID generation, extra unique indexes, required extras, triggers and RLS block writes', async () => {
      for (const ddl of [
        'ALTER TABLE raw.olos_calls ALTER COLUMN tma_origem TYPE numeric',
        'ALTER TABLE raw.olos_calls ALTER COLUMN internal_id_olos SET NOT NULL; ALTER TABLE raw.olos_calls ALTER COLUMN internal_id_olos ADD GENERATED ALWAYS AS IDENTITY',
        'CREATE UNIQUE INDEX forbidden_call_id_unique ON raw.olos_calls(olos_call_id)',
        'ALTER TABLE raw.olos_calls ADD COLUMN required_extra text NOT NULL',
        'ALTER TABLE raw.olos_calls ENABLE ROW LEVEL SECURITY',
        `CREATE FUNCTION raw.test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
         CREATE TRIGGER unsafe BEFORE INSERT ON raw.olos_calls FOR EACH ROW EXECUTE FUNCTION raw.test_trigger()`,
      ]) {
        await reset(); await insert(source, row()); await destination.query(ddl);
        await assert.rejects(sync(), /SCHEMA_|DESTINATION_/); assert.equal(await count(destination), 0);
      }
    });
    await t.test('one local owner; concurrent instance cannot write', async () => {
      await reset(); await insert(source, row()); await lock(source);
      try { await assert.rejects(sync(), /SYNC_ALREADY_RUNNING/); assert.equal(await count(destination), 0); }
      finally { await source.query('SELECT pg_advisory_unlock(17320914,1)'); }
    });
    await t.test('two concurrent starts converge without duplicate delivery', async () => {
      await reset(); await insert(source, row());
      const outcomes = await Promise.allSettled([sync(), sync()]);
      assert.ok(outcomes.some(r => r.status === 'fulfilled'));
      for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(String(outcome.reason), /SYNC_ALREADY_RUNNING/);
      assert.equal(await count(destination), 1); assert.equal(await count(source, 'corporate_sync.receipts'), 1);
    });
    await t.test('start waits between committed batches', async () => {
      await reset();
      await insert(source, row('1'));
      await insert(source, { ...row('2'), telefone: 'second-call' });

      const abort = new AbortController();
      const commits: number[] = [];
      const config = {
        ...cfg({
          CORPORATE_SYNC_BATCH_SIZE: '1',
          CORPORATE_SYNC_BATCH_DELAY_MS: '250'
        }),
        mode: 'start' as const
      };

      await run(config, abort.signal, {
        afterRemoteCommit: async () => {
          commits.push(Date.now());
          if (commits.length === 2) abort.abort();
        }
      });

      assert.equal(commits.length, 2);
      assert.ok(
        commits[1]! - commits[0]! >= 200,
        'start must wait between committed batches'
      );
      assert.equal(await count(destination), 2);
      assert.equal(await count(source, 'corporate_sync.receipts'), 2);
    });

    await t.test('once finishes without waiting for batch delay', async () => {
      await reset();
      await insert(source, row('1'));

      const abort = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, 1500);

      try {
        await run({
          ...cfg({
            CORPORATE_SYNC_BATCH_SIZE: '1',
            CORPORATE_SYNC_BATCH_DELAY_MS: '60000'
          }),
          mode: 'once'
        }, abort.signal);
      } finally {
        clearTimeout(timeout);
      }

      assert.equal(timedOut, false);
      assert.equal(await count(destination), 1);
      assert.equal(await count(source, 'corporate_sync.receipts'), 1);
    });

    await t.test('binding prevents silently changing conversion policy on existing control', async () => {
      await reset(); await insert(source, row()); await sync();
      await assert.rejects(sync(cfg({ CORPORATE_SYNC_TMA_POLICY: 'truncate', CORPORATE_SYNC_TMA_CONFIRMATION: 'CONFIRM_TMA_truncate' })), /CHECKPOINT_BINDING_MISMATCH/);
    });
    await t.test('pre-aborted run writes no batch and disabled programmatic run never connects', async () => {
      await reset(); await insert(source, row()); const abort = new AbortController(); abort.abort();
      await assert.rejects(run(cfg(), abort.signal), /STOP_REQUESTED/); assert.equal(await count(destination), 0);
      await assert.rejects(run({ ...cfg(), writeEnabled: false, sourceUrl: 'invalid' }, abort.signal), /WRITE_NOT_AUTHORIZED/);
    });
    await t.test('destination needs only SELECT and INSERT, without UPDATE or DDL permissions', async () => {
      await reset(); await insert(source, row());
      await destination.query('CREATE ROLE corporate_sync_writer LOGIN');
      await destination.query('GRANT USAGE ON SCHEMA raw, core TO corporate_sync_writer; GRANT SELECT,INSERT ON raw.olos_calls TO corporate_sync_writer; GRANT EXECUTE ON FUNCTION core.gerar_telefone_match_key(text) TO corporate_sync_writer');
      const restricted = new URL(destinationUrl!); restricted.username = 'corporate_sync_writer';
      await sync(cfg({ CORPORATE_SYNC_DESTINATION_URL: restricted.toString() }));
      assert.equal(await count(destination), 1);
    });
    await t.test('same physical database via different usernames is rejected', async () => {
      await reset(); await source.query('GRANT USAGE ON SCHEMA raw TO corporate_sync_writer; GRANT SELECT,INSERT ON raw.olos_calls TO corporate_sync_writer');
      const same = new URL(sourceUrl!); same.username = 'corporate_sync_writer';
      await assert.rejects(sync(cfg({ CORPORATE_SYNC_DESTINATION_URL: same.toString() })), /SOURCE_EQUALS_DESTINATION/);
    });
  } finally { await source.end(); await destination.end(); }
});
