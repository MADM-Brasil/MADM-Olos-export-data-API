import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('filtro automático exige operador válido antes do LIMIT', () => {
  const source = readFileSync(
    'src/corporate-delivery/delivery.ts', 'utf8'
  );

  assert.match(source, /r\.agent_id ~ '\^\[1-9\]\[0-9\]\*\$'/);
  assert.match(source, /jsonb_typeof\(o\.payload->'nome_agente'\)='string'/);
  assert.match(source, /ORDER BY o\.target_id LIMIT \$2/);
  assert.match(source, /FOR UPDATE OF o,r/);
  assert.match(source, /const entries = homologation/);
});

test('política rejeita placeholders e preserva operador legítimo', () => {
  const source = readFileSync(
    'src/corporate-delivery/delivery.ts', 'utf8'
  );

  const match = source.match(
    /const operatorNamePlaceholderPattern =\s*'([^']+)'/
  );
  assert.ok(match);

  const pattern = new RegExp(match[1] ?? '', 'i');

  for (const name of [
    '12345', '-1', 'null', 'undefined',
    'n/a', 'unknown', 'sem operador',
    'sem agente', 'não identificado'
  ]) {
    assert.equal(pattern.test(name), true, name);
  }

  for (const name of ['João Silva', 'Maria Souza', 'Agent']) {
    assert.equal(pattern.test(name), false, name);
  }
});

test('filtro não exige CPF ou email', () => {
  const source = readFileSync(
    'src/corporate-delivery/delivery.ts', 'utf8'
  );

  const start = source.indexOf('const entries = homologation');
  const end = source.indexOf('if (!entries.length)', start);

  assert.ok(start >= 0 && end > start);

  const selection = source.slice(start, end);

  assert.doesNotMatch(selection, /payload->'cpf'/);
  assert.doesNotMatch(selection, /payload->'email'/);
});
