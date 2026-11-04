import test from 'node:test';
import assert from 'node:assert/strict';
import { historyPeriod, inHistoryPeriod } from '../src/corporate-delivery/history-period.js';
import { shape } from './corporate-sync.fixture.js';

test('history admission preserves microsecond boundaries for September/October in Sao Paulo', () => {
  const period=historyPeriod(shape());
  assert.equal(period.start,'2026-09-01T03:00:00.000000Z');
  assert.equal(period.end,'2026-11-01T03:00:00.000000Z');
  for (const value of ['2026-09-01T03:00:00.000000Z','2026-10-01T03:00:00.000000Z','2026-11-01T02:59:59.999999Z']) {
    assert.equal(inHistoryPeriod({data_ligacao:value},period),true,value);
  }
  for (const value of [null,42,'','2026-09-01T02:59:59.999999Z',period.end,'2025-10-01T10:00:00.000000Z',
    '2026-10-01T10:00:00Z','2026-10-01T10:00:00.000000Z\n']) {
    assert.equal(inHistoryPeriod({data_ligacao:value},period),false,String(value));
  }
});

test('history admission respects the already confirmed destination wall-clock projection', () => {
  const wall=shape();wall.set('data_ligacao',{...wall.get('data_ligacao')!,type:'timestamp'});
  assert.throws(()=>historyPeriod(wall),/TIMESTAMP_SEMANTICS_NOT_CONFIRMED/);
  assert.throws(()=>historyPeriod(wall,'Invalid/Zone'),/DRAIN_HISTORY_PERIOD_INVALID/);
  const period=historyPeriod(wall,'America/Sao_Paulo');
  assert.equal(period.start,'2026-09-01T00:00:00.000000');
  assert.equal(period.end,'2026-11-01T00:00:00.000000');
  assert.equal(inHistoryPeriod({data_ligacao:'2026-10-31T23:59:59.999999'},period),true);
  assert.equal(inHistoryPeriod({data_ligacao:period.end},period),false);
  assert.equal(inHistoryPeriod({data_ligacao:period.start+'Z'},period),false);
});
