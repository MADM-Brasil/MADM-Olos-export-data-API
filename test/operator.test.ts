import test from 'node:test';
import assert from 'node:assert/strict';
import { rows } from '../src/api.js';
import { mapRecord } from '../src/mapping.js';
import { operatorComplementProposal } from '../src/corporate-delivery/operator-complement.js';
import { deliveryConfig } from '../src/corporate-delivery/config.js';
import { deliveryDigest, mapDeliveryRow, operatorId, withOperator } from '../src/corporate-delivery/payload.js';
import { digest } from '../src/corporate-sync/mapping.js';
import { parseOperatorRequest, validateOperatorRequest, operatorAdmin } from '../src/corporate-delivery/operator-admin.js';
import { row, shape } from './corporate-sync.fixture.js';
import type { PoolClient } from 'pg';
const cfg = deliveryConfig({ ATTEMPTS_PERSISTENCE_MODE: 'corporate', DATABASE_URL: 'postgresql://test@localhost/local',
  OLOS_CORPORATE_DATABASE_URL: 'postgresql://test@localhost/madm', OLOS_SOURCE_KEY: 'synthetic' })!;
const cache = { users: new Map([['52','Name'],['0','Zero name']]), campaigns: new Map<string,string>(), dispositions: new Map<string,string>() };

test('operator contract preserves AgentId numbers, strings, zero and unknown without inventing an agent', () => {
  for (const [raw, expected] of [['52','52'],['1599','1599'],['0','0'],['null',null],['"00052"','00052'],['"-1"','-1'],['9007199254740993','9007199254740993'],['""','']] as const) {
    const mapped = mapRecord(rows(`[{"AttemptsRawDataID":1,"CallId":"call","AgentId":${raw}}]`)[0]!, cache);
    assert.equal(operatorId(mapped.agent_id), expected);
    assert.equal(mapped.olos_call_id, 'call'); assert.equal(mapped.source_id, '1');
  }
  const missing = mapRecord({ AttemptsRawDataID: '1' }, cache);
  assert.equal(operatorId(missing.agent_id), null);
  assert.equal(mapRecord({ AttemptsRawDataID: '1', AgentId: 52 }, cache).nome_agente, 'Name');
  assert.equal(mapRecord({ AttemptsRawDataID: '1', AgentId: 1599 }, cache).nome_agente, null);
  for (const invalid of [true, {}, [], 9007199254740992]) assert.throws(() => mapRecord({ AttemptsRawDataID: '1', AgentId: invalid }, cache));
});
test('operator v2 has a separate hash; legacy digests and call identities remain unchanged', () => {
  const legacy = row(), extended = shape();
  extended.set('id_operador_olos', { name: 'id_operador_olos', type: 'text', nullable: true, length: null, precision: null });
  const original = digest(legacy);
  assert.equal(deliveryDigest(legacy), original);
  const v2 = withOperator(legacy, '52');
  assert.equal(v2.internal_id_olos, legacy.internal_id_olos); assert.equal(v2.olos_call_id, legacy.olos_call_id);
  assert.notEqual(deliveryDigest(v2), original);
  assert.notEqual(deliveryDigest(v2), deliveryDigest(withOperator(legacy, '1599')));
  assert.notEqual(deliveryDigest(withOperator(legacy,null)), original);
  assert.deepEqual(mapDeliveryRow(v2, extended, cfg.connection), v2);
  assert.throws(() => mapDeliveryRow(v2, shape(), cfg.connection), /OPERATOR_SCHEMA_REQUIRED/);
  assert.throws(() => mapDeliveryRow({ ...v2, id_operador_olos: undefined }, extended, cfg.connection), /OPERATOR_ID_INVALID/);
  assert.equal(digest(legacy), original);
});
test('operator administrative changes require exact hashes/list authorization before connecting', async () => {
  const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64);
  assert.deepEqual(parseOperatorRequest(cfg, 'corporate-operator-plan', []), { kind: 'plan' });
  assert.throws(() => parseOperatorRequest(cfg,'corporate-adopt-operator',[]), /PARAMETERS_INVALID/);
  assert.throws(() => validateOperatorRequest(cfg, { kind: 'adopt', previousHash: oldHash, schemaHash: newHash, confirmation: '' }), /NOT_AUTHORIZED/);
  assert.throws(() => validateOperatorRequest(cfg, { kind: 'prepare', ids: ['1','2','3','4'], confirmation: '' }), /SOURCE_IDS_INVALID/);
  assert.throws(() => validateOperatorRequest(cfg, { kind: 'prepare', ids: ['1','1'], confirmation: '' }), /SOURCE_IDS_INVALID/);
  assert.throws(() => validateOperatorRequest({ ...cfg, connection: { ...cfg.connection, writeEnabled: true } }, { kind: 'plan' }), /WRITE_DISABLED/);
  let calls = 0;
  const client = { query: async () => { calls++; throw new Error('must not query'); } } as unknown as PoolClient;
  await assert.rejects(operatorAdmin(client,cfg,'synthetic','"raw"."olos_calls"', { kind:'prepare',ids:['1'],confirmation:'' }), /NOT_AUTHORIZED/);
  assert.equal(calls, 0);
});

test('offline complement refuses to reinterpret an already confirmed v2 operator', () => {
  const extended=shape();
  extended.set('id_operador_olos',{name:'id_operador_olos',type:'text',nullable:true,length:null,precision:null});
  const payload=withOperator(row(),'52');
  const proof={source_id:'1',target_id:'1',source_hash:'a'.repeat(64),payload_hash:deliveryDigest(payload),
    payload,agent_id:'1599',state:'confirmed',remote_raw_id:'8000000001',confirmed_at:'2026-11-03'};
  assert.throws(()=>operatorComplementProposal([proof],extended,{trigger_body:'fixture',normalizer_body:'fixture'},cfg),/OPERATOR_REVISION_DIVERGES/);
});
