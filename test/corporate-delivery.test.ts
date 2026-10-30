import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from '../src/config.js';
import { deliveryConfig } from '../src/corporate-delivery/config.js';
import { tma } from '../src/corporate-sync/mapping.js';
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
