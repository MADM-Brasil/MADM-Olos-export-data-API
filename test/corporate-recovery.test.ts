import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import { legacyReversionRequest } from '../src/corporate-delivery/legacy-recovery.js';
import { recoveryRequest,recoverCollision } from '../src/corporate-delivery/recovery.js';
import { observeLogs,type LogEntry } from '../src/errors.js';
import { SyncError } from '../src/corporate-sync/errors.js';
import { corporateControl } from '../src/corporate-delivery/commands.js';
import { config } from '../src/config.js';

const authorization = { OLOS_CORPORATE_RECOVERY_CONFIRMATION: 'AUTHORIZE_CORPORATE_COLLISION_RECOVERY' };
const args = ['--confirm-source', 'synthetic', '--verification', 'a'.repeat(64), '--request-id', '00000000-0000-4000-8000-000000000001', '--evidence', 'INC-42'];
test('collision recovery diagnostics allow only a fixed category, stage and validated PostgreSQL SQLSTATE',async()=>{
  const dc=config({DATABASE_URL:'postgresql://test@localhost/local',OLOS_SOURCE_KEY:'synthetic',ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:'postgresql://test@localhost/madm'}).corporateDelivery!;
  const sensitive='PRIVATE query SELECT payload cpf phone email password postgresql://user:secret@host/db stack cause';
  const database=(code:unknown)=>Object.assign(new pg.DatabaseError(sensitive,0,'error'),{code,detail:sensitive,hint:sensitive,where:sensitive,internalQuery:sensitive,stack:sensitive,cause:sensitive});
  const getterError=Object.defineProperties({}, {code:{get(){throw new Error(sensitive);}},message:{get(){throw new Error(sensitive);}},toJSON:{value(){throw new Error(sensitive);}}});
  const cases:[unknown,string,string|null][]=[
    [database('42P01'),'database','42P01'],[database('55P03'),'database','55P03'],
    ...['42P01\nPRIVATE','42p01','password',undefined,42].map(code=>[database(code),'database',null] as [unknown,string,null]),
    [Object.assign(new Error(sensitive),{code:'ECONNRESET'}),'connection',null],
    [Object.assign(new Error(sensitive),{code:'42P01'}),'runtime',null],
    [new SyncError(sensitive),'policy',null],[sensitive,'runtime',null],[getterError,'runtime',null],
  ];
  for(const [failure,category,sqlstate] of cases){
    const calls:string[]=[],events:LogEntry[]=[];
    const local={async query(sql:string){calls.push(sql);if(sql==='ROLLBACK')return {rows:[]};throw failure;}} as unknown as PoolClient;
    const stop=observeLogs(entry=>{if(entry.event==='corporate_collision_recovery_failed')events.push(entry);});
    try{await assert.rejects(recoverCollision(local,dc,'synthetic','"raw"."olos_calls"',recoveryRequest(args,authorization,'synthetic')),e=>e===failure);}finally{stop();}
    assert.deepEqual(calls,['BEGIN','ROLLBACK']);assert.equal(events.length,1);
    assert.deepEqual(Object.keys(events[0]!).sort(),['category','event','sqlstate','stage','table','time']);
    assert.equal(events[0]!.stage,'local_locks');assert.equal(events[0]!.category,category);assert.equal(events[0]!.sqlstate,sqlstate);
    assert.doesNotMatch(JSON.stringify(events),/PRIVATE|payload|cpf|phone|email|password|postgresql|secret|stack|cause|00000000|INC-42/);
  }
});
test('diagnostic sink failure never replaces the recovery error or skips rollback',async t=>{
  const dc=config({DATABASE_URL:'postgresql://test@localhost/local',OLOS_SOURCE_KEY:'synthetic',ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:'postgresql://test@localhost/madm'}).corporateDelivery!;
  const failure=new Error('original recovery failure'),calls:string[]=[];
  const local={async query(sql:string){calls.push(sql);if(sql==='ROLLBACK')return {rows:[]};throw failure;}} as unknown as PoolClient;
  const mock=t.mock.method(process.stdout,'write',()=>{throw new Error('diagnostic sink unavailable');});
  try{await assert.rejects(recoverCollision(local,dc,'synthetic','"raw"."olos_calls"',recoveryRequest(args,authorization,'synthetic')),e=>e===failure);}finally{mock.mock.restore();}
  assert.deepEqual(calls,['BEGIN','ROLLBACK']);
});
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

test('allocator adoption and preparation require their own authorization and exact source', async () => {
  const cfg = config({ DATABASE_URL: 'postgresql://test@localhost/local', OLOS_SOURCE_KEY: 'synthetic',
    ATTEMPTS_PERSISTENCE_MODE: 'corporate', OLOS_CORPORATE_DATABASE_URL: 'postgresql://test@localhost/madm' });
  const args = ['--confirm-source','synthetic','--request-id','00000000-0000-4000-8000-000000000001','--evidence','INC-ID'];
  for (const command of ['corporate-prepare-id-allocator','corporate-adopt-id-allocator']) {
    await assert.rejects(corporateControl(cfg, command, args, authorization), /ADOPTION_NOT_AUTHORIZED/);
    await assert.rejects(corporateControl(cfg, command, args.map((v, i) => i === 1 ? 'other' : v), {
      OLOS_CORPORATE_ID_ALLOCATOR_CONFIRMATION: 'AUTHORIZE_CORPORATE_ID_ALLOCATOR',
    }), /SOURCE_MISMATCH/);
  }
});

test('legacy reversion requires separate authorization, exact source and preparation/request IDs',async()=>{
  const args=['--confirm-source','synthetic','--adoption-request','00000000-0000-4000-8000-000000000001','--request-id','00000000-0000-4000-8000-000000000002','--evidence','INC-LEGACY'];
  const auth={OLOS_CORPORATE_LEGACY_REVERSION_CONFIRMATION:'AUTHORIZE_CORPORATE_LEGACY_REVERSION'};
  assert.throws(()=>legacyReversionRequest(args,authorization,'synthetic'),/NOT_AUTHORIZED/);
  assert.throws(()=>legacyReversionRequest(args,auth,'other'),/SOURCE_MISMATCH/);
  for(const invalid of [args.slice(0,6),args.map((v,i)=>i===3?'bad':v),args.map((v,i)=>i===5?'bad':v),[...args,'--max-batches','0'],[...args,'--max-batches','10001']])assert.throws(()=>legacyReversionRequest(invalid,auth,'synthetic'),/ARGUMENTS_INVALID/);
  assert.equal(legacyReversionRequest(args,auth,'synthetic').maxBatches,1000);assert.equal(legacyReversionRequest([...args,'--max-batches','1'],auth,'synthetic').maxBatches,1);
  const cfg=config({DATABASE_URL:'postgresql://test@localhost/local',OLOS_SOURCE_KEY:'synthetic',ATTEMPTS_PERSISTENCE_MODE:'corporate',OLOS_CORPORATE_DATABASE_URL:'postgresql://test@localhost/madm'});
  await assert.rejects(corporateControl(cfg,'corporate-revert-id-allocator',args,{}),/NOT_AUTHORIZED/);
});
