import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config } from '../src/corporate-sync/config.js';
import { compare, digest, integerValue, mapRow, projection, tma } from '../src/corporate-sync/mapping.js';
import { retryable, safeCode, SyncError } from '../src/corporate-sync/errors.js';
import { pause } from '../src/corporate-sync/worker.js';
import { row, shape, testConfig } from './corporate-sync.fixture.js';

test('write requires explicit enable, confirmation, logical identity and TMA policy', () => {
  for (const env of [
    { CORPORATE_SYNC_ENABLED: 'false' }, { CORPORATE_SYNC_WRITE_CONFIRMATION: '' },
    { CORPORATE_SYNC_IDENTITY_CONFIRMATION: '' }, { CORPORATE_SYNC_TMA_CONFIRMATION: '' },
  ]) assert.throws(() => testConfig(env));
  assert.equal(testConfig().writeEnabled, true);
});
test('configuration has no operational/OLOS fallback and rejects URL options', () => {
  assert.throws(() => config('check', { DATABASE_URL: 'postgresql://u@host/db' }), /DATABASE_URL_INVALID/);
  assert.throws(() => testConfig({ CORPORATE_SYNC_SOURCE_URL: 'postgresql://u@host/db?sslmode=no-verify' }), /DATABASE_URL_INVALID/);
  assert.throws(() => testConfig({ CORPORATE_SYNC_BATCH_SIZE: '0' }), /CONFIG_INTEGER_INVALID/);
  assert.throws(() => testConfig({ CORPORATE_SYNC_TMA_POLICY: 'floor' }), /TMA_POLICY_INVALID/);
});
test('CLI defaults reject real synchronization and emits no credential or raw error', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/corporate-sync/cli.ts', 'once'], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH!, CORPORATE_SYNC_SOURCE_URL: 'postgresql://postgres:secret-value@127.0.0.1:1/source',
      CORPORATE_SYNC_DESTINATION_URL: 'postgresql://postgres:secret-value@127.0.0.1:1/destination' },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout.trim()).code, 'WRITE_NOT_AUTHORIZED');
  assert.doesNotMatch(result.stdout + result.stderr, /secret-value|postgresql|ECONNREFUSED|password/);
});
test('endpoint/mapping binding ignores password rotation and changes with policy', () => {
  const first = testConfig({ CORPORATE_SYNC_SOURCE_URL: 'postgresql://postgres:one@127.0.0.1/corporate_sync_test_source' });
  const second = testConfig({ CORPORATE_SYNC_SOURCE_URL: 'postgresql://postgres:two@127.0.0.1/corporate_sync_test_source' });
  assert.equal(first.binding, second.binding);
  assert.notEqual(first.binding, testConfig({ CORPORATE_SYNC_TMA_POLICY: 'truncate', CORPORATE_SYNC_TMA_CONFIRMATION: 'CONFIRM_TMA_truncate' }).binding);
});
test('decimal TMA rejects fractions by default and never silently converts', () => {
  const cfg = testConfig();
  assert.equal(tma('10.000', cfg), '10');
  assert.throws(() => tma('10.001', cfg), /TMA_FRACTION_REJECTED/);
  assert.throws(() => tma('10.001', { tmaPolicy: 'truncate', tmaConfirmed: false }), /TMA_POLICY_NOT_CONFIRMED/);
  assert.equal(tma('-10.99', { tmaPolicy: 'truncate', tmaConfirmed: true }), '-10');
  assert.equal(tma('-10.50', { tmaPolicy: 'round-half-away', tmaConfirmed: true }), '-11');
  assert.equal(tma('10.49999999999999999999999', { tmaPolicy: 'round-half-away', tmaConfirmed: true }), '10');
  assert.throws(() => tma('2147483647.5', { tmaPolicy: 'round-half-away', tmaConfirmed: true }), /INTEGER_OUT_OF_RANGE/);
  for (const raw of ['NaN', 'Infinity', '1e2', '', ' 1']) assert.throws(() => tma(raw, cfg));
});
test('integer bounds preserve bigint precision and accept int32 boundaries', () => {
  assert.equal(integerValue('9223372036854775807', 64), '9223372036854775807');
  assert.equal(integerValue('-2147483648', 32), '-2147483648');
  assert.equal(integerValue('2147483647', 32), '2147483647');
  for (const value of ['2147483648', '-2147483649', '1.1']) assert.throws(() => integerValue(value, 32));
  assert.throws(() => integerValue('9223372036854775808', 64));
});
test('mapping omits raw_olos_call_id and kommo, requires complete logical identity', () => {
  const cfg = testConfig();
  const result = mapRow({ ...row(), raw_olos_call_id: '42', kommo_id: '50' }, shape(), cfg);
  assert.ok(!('kommo_id' in result)); assert.ok(!('raw_olos_call_id' in result));
  for (const name of ['olos_call_id', 'data_ligacao', 'telefone', 'id_campanha_olos']) {
    assert.throws(() => mapRow({ ...row(), [name]: null }, shape(), cfg), /REQUIRED_VALUE_MISSING/);
  }
  assert.throws(() => mapRow({ ...row(), internal_id_olos: 9007199254740992 }, shape(), cfg), /VALUE_TYPE_INVALID/);
});
test('text length, timestamp precision and required fields fail before SQL insert', () => {
  const s = shape(); const cfg = testConfig();
  for (const time of ['2026-02-30T12:00:00.000000Z', '2026-01-01T24:00:00.000000Z', '0000-01-01T12:00:00.000000Z']) {
    assert.throws(() => mapRow({ ...row(), data_ligacao: time }, s, cfg), /TIMESTAMP_INVALID/);
  }
  s.get('telefone')!.length = 3;
  assert.throws(() => mapRow(row(), s, cfg), /TEXT_TOO_LONG/);
  s.get('telefone')!.length = null;
  s.get('data_ligacao')!.precision = 3;
  assert.throws(() => mapRow(row(), s, cfg), /TIMESTAMP_PRECISION_LOSS/);
  s.get('data_ligacao')!.precision = 6;
  s.get('email')!.nullable = false;
  assert.throws(() => mapRow(row(), s, cfg), /REQUIRED_VALUE_MISSING/);
});
test('same CallId alone is never treated as identical; matching identity still requires all fields', () => {
  compare(row(), row());
  assert.throws(() => compare({ ...row(), telefone: 'different' }, row()), /INTERNAL_ID_COLLISION/);
  assert.throws(() => compare({ ...row(), nome_agente: 'different' }, row()), /EXISTING_CALL_DIVERGES/);
  assert.notEqual(digest(row()), digest({ ...row(), email: 'synthetic@example.invalid' }));
});
test('timestamp projection retains microseconds and converts explicitly to wall-clock zone', () => {
  const s = shape();
  assert.match(projection(s, 's', true, testConfig()).sql, /HH24:MI:SS.US/);
  s.get('data_ligacao')!.type = 'timestamp';
  const result = projection(s, 's', true, { ...testConfig(), timestampZone: 'America/Sao_Paulo' });
  assert.deepEqual(result.parameters, ['America/Sao_Paulo']);
  assert.match(result.sql, /AT TIME ZONE \$1/);
});
test('logs expose only fixed codes, never PostgreSQL messages/details', () => {
  const error = { code: '23505', message: 'password email phone cpf', detail: 'secret' };
  assert.equal(safeCode(error), 'DATABASE_OR_RUNTIME_FAILURE');
  assert.equal(retryable(error), false);
  assert.equal(retryable({ code: '40001' }), true);
  assert.equal(retryable({ code: 'ECONNRESET' }), true);
  assert.equal(retryable(new SyncError('INTERNAL_ID_COLLISION')), false);
});
test('backoff is interruptible immediately', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(pause(60000, abort.signal), /STOP_REQUESTED/);
});
