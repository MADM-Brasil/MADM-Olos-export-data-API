import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from '../src/config.js';
import { deliveryConfig } from '../src/corporate-delivery/config.js';
import { tma } from '../src/corporate-sync/mapping.js';
import { parseSelection, parseReconciliation, validateSelection } from '../src/corporate-delivery/selection.js';
import { CorporateDelivery } from '../src/corporate-delivery/delivery.js';
import type { Pool } from 'pg';
import { handlingSeconds } from '../src/mapping.js';

const env = { DATABASE_URL: 'postgresql://test@localhost/local', OLOS_SOURCE_KEY: 'synthetic',
  ATTEMPTS_PERSISTENCE_MODE: 'corporate', OLOS_CORPORATE_DATABASE_URL: 'postgresql://test@localhost/madm' };
test('corporate direct mode is opt-in and independent from Corporate Sync configuration', () => {
  assert.equal(config({ DATABASE_URL: env.DATABASE_URL, OLOS_SOURCE_KEY: 'test', CORPORATE_SYNC_ENABLED: 'true' }).corporateDelivery, undefined);
  const cfg = deliveryConfig(env)!;
  assert.equal(cfg.connection.writeEnabled, false);
  assert.equal(cfg.expectedLegacyCount, 12605);
  assert.equal(deliveryConfig({ ...env, OLOS_CORPORATE_LEGACY_EXPECTED_COUNT: '12105' })!.expectedLegacyCount, 12105);
  assert.throws(() => deliveryConfig({ ...env, OLOS_CORPORATE_WRITE_ENABLED: 'true' }), /CORPORATE_WRITE_NOT_AUTHORIZED/);
  assert.equal(deliveryConfig({ ...env, OLOS_CORPORATE_WRITE_ENABLED: 'true', OLOS_CORPORATE_WRITE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY' })!.connection.writeEnabled, true);
});
test('corporate URL is explicit, fixed to madm and cannot weaken certificate verification', () => {
  const localWithOptions = 'postgresql://test@localhost/local?sslmode=require';
  assert.equal(config({ ...env, DATABASE_URL: localWithOptions }).databaseUrl, localWithOptions);
  for (const value of ['postgresql://test@localhost/other', 'postgresql://test@localhost/madm?sslmode=disable', '']) {
    assert.throws(() => deliveryConfig({ ...env, OLOS_CORPORATE_DATABASE_URL: value }));
  }
  assert.throws(() => deliveryConfig({ ...env, OLOS_CORPORATE_TLS_VERIFY: 'false' }), /CORPORATE_TLS_REQUIRED/);
  assert.equal(deliveryConfig(env)!.connection.destinationTls, true);
});
test('approved TMA half-away policy includes positive fractions below .5 mapping to zero', () => {
  const cfg = deliveryConfig(env)!.connection;
  for (const [value, expected] of [['0.001','0'], ['0.49','0'], ['0.5','1'], ['1.5','2'], ['-0.5','-1'], ['-0.49','0']]) {
    assert.equal(tma(value!, cfg), expected);
  }
  assert.equal(handlingSeconds('2026-10-01T00:00:00.000000Z', '2026-10-01T00:00:00.499999Z', undefined, true), 0);
  assert.equal(handlingSeconds('2026-10-01T00:00:00.000000Z', '2026-10-01T00:00:00.500000Z', undefined, true), 1);
  assert.equal(handlingSeconds('2026-10-01T00:00:00.000000Z', '2026-10-01T00:00:00.499999Z'), 0.5);
});
test('runtime import graph never reaches the standalone Corporate Sync worker or CLI', () => {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    assert.doesNotMatch(file, /corporate-sync\/(worker|cli)\.ts$/);
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/from ['"](\.[^'"]+\.js)['"]/g)) visit(resolve(dirname(file), match[1]!.replace(/\.js$/, '.ts')));
  }
  visit(resolve('src/main.ts'));
  for (const name of ['delivery', 'reconcile', 'contract', 'config']) {
    assert.doesNotMatch(readFileSync(resolve(`src/corporate-delivery/${name}.ts`), 'utf8'), /setTimeout|setInterval|sequentialPolling|new DynamicScheduler/);
  }
});

const selectedIds = ['35091119', '35091120', '35091121'];
const selectedConsent = `AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:${selectedIds.join(',')}`;
test('selective authorization is explicit, bounded and bound to exact canonical IDs', () => {
  const cfg = deliveryConfig(env)!;
  assert.deepEqual(parseSelection(cfg, ['--source-ids', selectedIds.join(','), '--confirm', selectedConsent]).sourceIds, selectedIds);
  for (const ids of [[], ['1','2','3','4'], ['1','1'], ['0'], ['01'], ['-1'], ['1.0'], ['1e3'], [' 1'], ['1;DROP'], ['9223372036854775808']]) {
    assert.throws(() => validateSelection(cfg, { sourceIds: ids, confirmation: `AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:${ids.join(',')}` }), /SOURCE_IDS_INVALID/);
  }
  for (const confirmation of ['', 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY', 'AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY', `${selectedConsent},4`]) {
    assert.throws(() => validateSelection(cfg, { sourceIds: selectedIds, confirmation }), /WRITE_NOT_AUTHORIZED/);
  }
  assert.throws(() => validateSelection(cfg, { sourceIds: [...selectedIds].reverse(), confirmation: selectedConsent }), /WRITE_NOT_AUTHORIZED/);
  assert.throws(() => validateSelection(undefined, { sourceIds: selectedIds, confirmation: selectedConsent }), /MODE_REQUIRED/);
  assert.throws(() => validateSelection({ ...cfg, connection: { ...cfg.connection, writeEnabled: true } },
    { sourceIds: selectedIds, confirmation: selectedConsent }), /GENERAL_WRITE_DISABLED/);
  for (const args of [[], ['--source-ids', '1'], ['--source-ids', '1', '--confirm', 'x', '--extra'], ['--ids','1','--confirm','x']]) {
    assert.throws(() => parseSelection(cfg, args), /PARAMETERS_INVALID/);
  }
});
test('unauthorized selective calls never acquire a connection or enter the delivery protocol', async () => {
  let connections = 0;
  const pool = { connect: async () => { connections++; throw new Error('must not connect'); } } as unknown as Pool;
  const delivery = new CorporateDelivery(deliveryConfig(env)!, 'synthetic', '"raw"."olos_calls"', pool, () => true, () => {});
  await assert.rejects(delivery.deliverSelected({ sourceIds: selectedIds, confirmation: '' }), /WRITE_NOT_AUTHORIZED/);
  await delivery.tick(); delivery.kick(); await delivery.settle();
  assert.equal(connections, 0);
});

test('selective reconciliation consent is distinct, bound to attempt ID and exact bounded list', async () => {
  const cfg = deliveryConfig(env)!;
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const confirmation = `AUTHORIZE_EXPORTDATA_SELECTIVE_RECONCILIATION:${attemptId}:${selectedIds.join(',')}`;
  assert.deepEqual(parseReconciliation(cfg, ['--source-ids', selectedIds.join(','), '--attempt-id', attemptId, '--confirm', confirmation]),
    { sourceIds: selectedIds, attemptId, confirmation });
  for (const args of [[], ['--source-ids', selectedIds.join(','), '--confirm', confirmation],
    ['--source-ids', selectedIds.join(','), '--attempt-id', attemptId, '--confirm', confirmation, 'extra']]) {
    assert.throws(() => parseReconciliation(cfg, args), /PARAMETERS_INVALID/);
  }
  const request = { sourceIds: selectedIds, attemptId, confirmation };
  assert.throws(() => validateSelection(cfg, request), /WRITE_NOT_AUTHORIZED/);
  assert.throws(() => validateSelection(cfg, { ...request, confirmation: selectedConsent }, 'reconciliation', attemptId), /WRITE_NOT_AUTHORIZED/);
  assert.throws(() => validateSelection(cfg, request, 'reconciliation', 'bad'), /ATTEMPT_ID_INVALID/);
  assert.throws(() => validateSelection(cfg, request, 'reconciliation', '22222222-2222-4222-8222-222222222222'), /WRITE_NOT_AUTHORIZED/);
  assert.throws(() => validateSelection(cfg, { ...request, sourceIds: ['1','2','3','4'] }, 'reconciliation', attemptId), /SOURCE_IDS_INVALID/);
  let connections = 0;
  const pool = { connect: async () => { connections++; throw new Error('must not connect'); } } as unknown as Pool;
  const delivery = new CorporateDelivery(cfg, 'synthetic', '"raw"."olos_calls"', pool, () => true, () => {});
  await assert.rejects(delivery.reconcileSelected({ ...request, confirmation: selectedConsent }), /WRITE_NOT_AUTHORIZED/);
  assert.equal(connections, 0);
});

test('v1 historical selection requires explicit contract, exact set/read and separate reconciliation consent before connecting', async () => {
  const cfg = deliveryConfig(env)!;
  const ids = ['47561569','47559439','47558756'];
  const historyReadId = '132eb226-f4e4-419d-b79f-21dd0e6e64c1';
  const confirmation = `AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:${ids.join(',')}`;
  const prefix = ['--source-ids',ids.join(','),'--confirm',confirmation];
  const suffix = ['--contract','v1','--preserve-history-read',historyReadId];
  const selection = { sourceIds: ids, confirmation, historyReadId, contract: 'v1' as const };
  assert.deepEqual(parseSelection(cfg,[...prefix,...suffix]),selection);
  assert.equal(parseSelection(cfg,[...prefix,'--preserve-history-read',historyReadId]).contract,undefined);
  for (const args of [[...prefix,'--contract','v1'], [...prefix,...suffix,'extra'],
    [...prefix,'--contract','v2','--preserve-history-read',historyReadId],
    [...prefix,'--contract','v1','--contract','v1','--preserve-history-read',historyReadId]]) {
    assert.throws(()=>parseSelection(cfg,args),/SCOPE_INVALID|PARAMETERS_INVALID/);
  }
  const attemptId='11111111-1111-4111-8111-111111111111';
  const consent=`AUTHORIZE_EXPORTDATA_SELECTIVE_RECONCILIATION:${attemptId}:${ids.join(',')}`;
  assert.deepEqual(parseReconciliation(cfg,['--source-ids',ids.join(','),'--attempt-id',attemptId,'--confirm',consent,...suffix]),
    {...selection,attemptId,confirmation:consent});
  let connections=0;
  const pool={connect:async()=>{connections++;throw new Error('must not connect');}} as unknown as Pool;
  const delivery=new CorporateDelivery(cfg,'synthetic','"raw"."olos_calls"',pool,()=>true,()=>{});
  for (const sourceIds of [ids.slice(0,2),['47561569','47559439','1'],[...ids,'1'],[ids[0]!,ids[0]!,ids[1]!]]) {
    await assert.rejects(delivery.deliverSelected({...selection,sourceIds}),/HISTORY_HOMOLOGATION_SCOPE_INVALID/);
  }
  await assert.rejects(delivery.deliverSelected({...selection,historyReadId:attemptId}),/HISTORY_HOMOLOGATION_SCOPE_INVALID/);
  await assert.rejects(delivery.deliverSelected({sourceIds:ids,confirmation,contract:'v1'}),/SELECTIVE_CONTRACT_SCOPE_INVALID/);
  await assert.rejects(delivery.reconcileSelected({...selection,attemptId}),/SELECTIVE_WRITE_NOT_AUTHORIZED/);
  assert.equal(connections,0);
});
