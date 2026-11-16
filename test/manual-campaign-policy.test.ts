import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCorporateDelivery } from '../src/corporate-delivery/campaign-policy.js';

function classify(campaignId: string, agentId: string, name: string) {
  const result = classifyCorporateDelivery(campaignId, agentId, name);
  return { state: result.state, policy: result.deliveryPolicyCode };
}

test('campanha 48 com operador valido deve ser excluida', () => {
  assert.deepEqual(classify('48', '1674', 'Operador Teste'), {
    state: 'skipped',
    policy: 'MANUAL_CAMPAIGN_EXCLUDED',
  });
});

test('campanha 48 com operador invalido deve ser excluida', () => {
  assert.deepEqual(classify('48', '0', 'unknown'), {
    state: 'skipped',
    policy: 'MANUAL_CAMPAIGN_EXCLUDED',
  });
});

test('campanha 35 com operador valido continua pendente', () => {
  assert.deepEqual(classify('35', '1674', 'Operador Teste'), {
    state: 'pending',
    policy: null,
  });
});

test('campanha 35 com operador invalido continua skipped', () => {
  assert.deepEqual(classify('35', '0', 'unknown'), {
    state: 'skipped',
    policy: null,
  });
});

test('campanha 25 com operador valido deve ser excluida', () => {
  assert.deepEqual(classify('25', '1674', 'Operador Teste'), {
    state: 'skipped',
    policy: 'MANUAL_CAMPAIGN_EXCLUDED',
  });
});
