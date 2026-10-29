import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDatabaseUrl} from '../src/config.js';
import {baselineTime,normalize,inspectContract} from '../src/normalization.js';

test('local module rejects corporate URLs and never falls back to DATABASE_URL',()=>{
  for(const value of ['postgresql://olos_local@corporate/db','postgresql://olos_local@localhost/corporate',
    'postgresql://postgres@localhost/olos_http_local','postgresql://olos_local@localhost/olos_http_local?sslmode=disable']){
    assert.throws(()=>localDatabaseUrl(value),/LOCAL_DATABASE_TARGET_REJECTED/);
  }
  assert.equal(localDatabaseUrl('postgresql://olos_local@postgres/olos_http_local'),'postgresql://olos_local@postgres/olos_http_local');
});
test('baseline requires explicit timezone and preserves microsecond boundaries',()=>{
  assert.throws(()=>baselineTime('2026-10-28 12:00:00'),/SOURCE_TIME_ZONE_REQUIRED/);
  const before=normalize({AttemptsRawDataID:'1',StartDate:'2026-10-28T12:00:00.123455Z'},'2026-10-28T12:00:00.123456Z');
  const equal=normalize({AttemptsRawDataID:'1',StartDate:'2026-10-28T09:00:00.123456-03:00'},'2026-10-28T12:00:00.123456Z');
  assert.equal(before.disposition,'before_baseline');assert.equal(equal.disposition,'eligible');
  assert.equal(equal.document.internal_id_olos,null);assert.equal(equal.document.cpf,null);
});
test('contract sample is local evidence, preserves numeric tokens and never asserts global uniqueness',()=>{
  const result=inspectContract('[{"AttemptsRawDataID":9007199254740993,"StartDate":"2026-10-28T12:00:00Z"}]');
  assert.equal(result.records,1);assert.equal(result.globalUniquenessProven,false);
  assert.throws(()=>inspectContract('[]'),/CONTRACT_SAMPLE_EMPTY/);
  assert.throws(()=>inspectContract('[{"StartDate":"2026-10-28T12:00:00Z"}]'),/SOURCE_ID_INVALID/);
});
