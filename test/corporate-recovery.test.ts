import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryRequest } from '../src/corporate-delivery/recovery.js';
import { corporateControl } from '../src/corporate-delivery/commands.js';
import { config } from '../src/config.js';

const authorization = { OLOS_CORPORATE_RECOVERY_CONFIRMATION: 'AUTHORIZE_CORPORATE_COLLISION_RECOVERY' };
const args = ['--confirm-source', 'synthetic', '--verification', 'a'.repeat(64), '--request-id', '00000000-0000-4000-8000-000000000001', '--evidence', 'INC-42'];
test('collision recovery requires separate authorization, exact source, proof and an idempotency ID', () => {
  assert.throws(() => recoveryRequest(args, {}, 'synthetic'), /NOT_AUTHORIZED/);
  assert.throws(() => recoveryRequest(args, { OLOS_CORPORATE_WRITE_CONFIRMATION: 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY' }, 'synthetic'), /NOT_AUTHORIZED/);
  assert.throws(() => recoveryRequest(args, authorization, 'other'), /SOURCE_MISMATCH/);
  for (const input of [[], args.slice(0, 6), [...args, 'extra'], args.map((v, i) => i === 3 ? 'bad' : v), args.map((v, i) => i === 5 ? 'bad' : v), args.map((v, i) => i === 7 ? 'name@example.com' : v)]) {
    assert.throws(() => recoveryRequest(input, authorization, 'synthetic'), /ARGUMENTS/);
  }
  assert.equal(recoveryRequest(args, authorization, 'synthetic').evidence, 'INC-42');
});
test('CLI rejects missing authorization and wrong source before opening any database', async () => {
  const cfg = config({ DATABASE_URL: 'postgresql://test@localhost/local', OLOS_SOURCE_KEY: 'synthetic',
    ATTEMPTS_PERSISTENCE_MODE: 'corporate', OLOS_CORPORATE_DATABASE_URL: 'postgresql://test@localhost/madm' });
  await assert.rejects(corporateControl(cfg, 'corporate-recover-collision', args, {}), /NOT_AUTHORIZED/);
  await assert.rejects(corporateControl(cfg, 'corporate-recover-collision', args.map((v, i) => i === 1 ? 'other' : v), authorization), /SOURCE_MISMATCH/);
  await assert.rejects(corporateControl(cfg, 'corporate-verify-pending', ['--repair']), /ARGUMENTS/);
});

test('quarantine requires its own authorization and cannot reuse a release authorization', async () => {
  const quarantineAuthorization = { OLOS_CORPORATE_QUARANTINE_CONFIRMATION: 'AUTHORIZE_CORPORATE_COLLISION_QUARANTINE' };
  assert.throws(() => recoveryRequest(args, authorization, 'synthetic', true), /NOT_AUTHORIZED/);
  assert.throws(() => recoveryRequest(args, quarantineAuthorization, 'synthetic'), /NOT_AUTHORIZED/);
  assert.equal(recoveryRequest(args, quarantineAuthorization, 'synthetic', true).action, 'quarantine');
  assert.equal(recoveryRequest(args, authorization, 'synthetic').action, 'release');
  const cfg = config({ DATABASE_URL: 'postgresql://test@localhost/local', OLOS_SOURCE_KEY: 'synthetic',
    ATTEMPTS_PERSISTENCE_MODE: 'corporate', OLOS_CORPORATE_DATABASE_URL: 'postgresql://test@localhost/madm' });
  await assert.rejects(corporateControl(cfg, 'corporate-quarantine-collisions', args, authorization), /NOT_AUTHORIZED/);
  await assert.rejects(corporateControl(cfg, 'corporate-quarantine-collisions', args.map((v, i) => i === 1 ? 'other' : v), quarantineAuthorization), /SOURCE_MISMATCH/);
});
