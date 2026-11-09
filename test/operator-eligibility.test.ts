import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleOperator } from '../src/corporate-delivery/operator-eligibility.js';

test('aceita operador identificado', () => {
  assert.equal(eligibleOperator('1592', 'João Silva'), true);
  assert.equal(eligibleOperator('1100', 'Maria Souza'), true);
});

test('rejeita ID de operador inválido', () => {
  assert.equal(eligibleOperator(null, 'João Silva'), false);
  assert.equal(eligibleOperator('0', 'João Silva'), false);
  assert.equal(eligibleOperator('-1', 'João Silva'), false);
  assert.equal(eligibleOperator('ABC', 'João Silva'), false);
});

test('rejeita nomes ausentes e placeholders', () => {
  for (const name of [
    null, '', '   ', 'null', 'unknown',
    'sem operador', 'não identificado', '12345'
  ]) {
    assert.equal(
      eligibleOperator('1592', name),
      false,
      String(name)
    );
  }
});
