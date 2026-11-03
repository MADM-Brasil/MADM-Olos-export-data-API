import test from 'node:test';
import assert from 'node:assert/strict';
import { hasIdentifiedOperator, operatorNameWhitespace } from '../src/corporate-delivery/identified-operator.js';

test('operator admission requires the original positive AgentId and a populated frozen name', () => {
  for (const agent_id of [null, undefined, 0, 7, '', '0', '-1', '-2', '007', '7.0', '7e1', ' 7', '7 ', '7\n', 'NaN']) {
    assert.equal(hasIdentifiedOperator({ agent_id, payload: { nome_agente: 'Agent' } }), false, String(agent_id));
  }
  for (const nome_agente of [null, undefined, '', ' ', '\t\n', operatorNameWhitespace, 7, {}]) {
    assert.equal(hasIdentifiedOperator({ agent_id: '7', payload: { nome_agente } }), false);
  }
  for (const agent_id of ['7', '1658', '9007199254740993']) {
    const entry = { agent_id, payload: { nome_agente: '  Operador Á  ', olos_call_id: '1031756916',
      internal_id_olos: '47561569', nome_tabulacao_olos: null, tma_origem: '0' } };
    const before = structuredClone(entry);
    assert.equal(hasIdentifiedOperator(entry), true);
    assert.deepEqual(entry, before);
  }
});
