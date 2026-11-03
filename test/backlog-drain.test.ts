import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { drainCommand } from '../src/corporate-delivery/drain.js';
import { drainConsent, drainHash, parseDrainRequest, validateDrainLimits, type DrainLimits } from '../src/corporate-delivery/drain-request.js';
import { preservedHistoryRead } from '../src/corporate-delivery/preserved-history.js';

const limits: DrainLimits={batchSize:100,maxBatches:1,delayMs:1000,maxBatchMs:10000,statementTimeoutMs:2000,
  contract:'v1',historyReadId:preservedHistoryRead};
const args=['--batch-size','100','--max-batches','1','--delay-ms','1000','--max-batch-ms','10000',
  '--statement-timeout-ms','2000','--contract','v1','--preserve-history-read',preservedHistoryRead];
const runId='11111111-1111-4111-8111-111111111111', planHash='a'.repeat(64);
test('drain requires finite canonical limits, explicit v1/history and independent consent', () => {
  assert.deepEqual(parseDrainRequest('corporate-drain-plan',args),{kind:'plan',limits});
  const confirmation=drainConsent('execute',runId,planHash);
  const suffix=['--run-id',runId,'--plan-hash',planHash,'--confirm',confirmation];
  assert.deepEqual(parseDrainRequest('corporate-drain-backlog',[...args,...suffix]),{kind:'execute',limits,runId,planHash,confirmation});
  for (const extra of [[],['--batch-size','100'],['--unlimited','true'],['--contract','v2']]) {
    assert.throws(() => parseDrainRequest('corporate-drain-backlog',[...args,...extra]),/DRAIN_/);
  }
  for (const changed of [args.slice(2),[...args,'--batch-size','100'],args.map(a => a==='100'?'1e2':a),
    args.map(a => a==='100'?'0100':a),args.map(a => a==='v1'?'v2':a),args.map(a => a===preservedHistoryRead?runId:a)]) {
    assert.throws(() => parseDrainRequest('corporate-drain-plan',changed),/DRAIN_/);
  }
  for (const mutation of [{batchSize:0},{batchSize:1001},{batchSize:1.5},{maxBatches:0},{maxBatches:101},
    {batchSize:1000,maxBatches:11},{delayMs:0},{delayMs:60001},{maxBatchMs:0},{maxBatchMs:60001},
    {statementTimeoutMs:15001},{maxBatchMs:1000,statementTimeoutMs:2000}]) {
    assert.throws(() => validateDrainLimits({...limits,...mutation}),/DRAIN_/);
  }
  for (const batchSize of [1,100,250,500,1000]) validateDrainLimits({...limits,batchSize});
  assert.throws(() => parseDrainRequest('corporate-drain-reconcile',suffix),/DRAIN_NOT_AUTHORIZED/);
  assert.throws(() => parseDrainRequest('corporate-drain-cancel',suffix),/DRAIN_NOT_AUTHORIZED/);
  assert.deepEqual(parseDrainRequest('corporate-drain-reconcile',['--run-id',runId,'--plan-hash',planHash,
    '--confirm',drainConsent('reconcile',runId,planHash)]),{kind:'reconcile',runId,planHash,confirmation:drainConsent('reconcile',runId,planHash)});
  assert.deepEqual(parseDrainRequest('corporate-drain-cancel',['--run-id',runId,'--plan-hash',planHash,
    '--confirm',drainConsent('cancel',runId,planHash)]),{kind:'cancel',runId,planHash,confirmation:drainConsent('cancel',runId,planHash)});
});
test('manifest hashes bind every parameter and evidence, independent of JSON object order', () => {
  assert.equal(drainHash({a:1,b:{x:2,y:3}}),drainHash({b:{y:3,x:2},a:1}));
  const original={limits,evidence:[{source_id:'123',payload_hash:planHash}]};
  for (const change of [{limits:{...limits,maxBatches:2}}, {limits:{...limits,delayMs:2000}},
    {limits:{...limits,maxBatchMs:20000}}, {evidence:[{source_id:'124',payload_hash:planHash}]}]) {
    assert.notEqual(drainHash(original),drainHash({...original,...change}));
  }
});
test('unauthorized drain and general write mode fail before opening any database connection', async () => {
  const cfg=config({DATABASE_URL:'postgresql://test@127.0.0.1:1/local',OLOS_SOURCE_KEY:'synthetic',
    ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:'postgresql://test@localhost:1/madm'});
  await assert.rejects(drainCommand(cfg,{kind:'execute',limits,runId,planHash,confirmation:''}),/DRAIN_NOT_AUTHORIZED/);
  cfg.corporateDelivery!.connection.writeEnabled=true;
  await assert.rejects(drainCommand(cfg,{kind:'plan',limits}),/DRAIN_REQUIRES_GENERAL_WRITE_DISABLED/);
});
