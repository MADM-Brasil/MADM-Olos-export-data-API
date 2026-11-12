import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isReadoptionState,
  type ReadoptionState
} from '../src/corporate-delivery/readoption-contract.js';

test('aceita somente estados definidos no contrato', () => {
  const valid: ReadoptionState[] = [
    'prepared',
    'validating',
    'ready',
    'activating',
    'active',
    'aborted'
  ];

  for (const state of valid) {
    assert.equal(isReadoptionState(state), true);
  }
});

test('rejeita estados desconhecidos e valores invalidos', () => {
  for (const value of [
    'legacy',
    'completed',
    '',
    null,
    undefined,
    123,
    {}
  ]) {
    assert.equal(isReadoptionState(value), false);
  }
});

import { randomUUID } from 'node:crypto';
import { readoptionArguments } from '../src/corporate-delivery/readoption-command.js';
const source='synthetic-cli',requestId=randomUUID();
const base=['--confirm-source',source,'--request-id',requestId,'--evidence','INC-42'];
const auth={OLOS_CORPORATE_READOPTION_CONFIRMATION:'AUTHORIZE_CORPORATE_ID_READOPTION'};
const activationAuth={...auth,OLOS_CORPORATE_READOPTION_ACTIVATION_CONFIRMATION:'AUTHORIZE_CORPORATE_ID_READOPTION_ACTIVATION'};
test('readoption mutation requires authorization and exact source before any database access',()=>{
 assert.throws(()=>readoptionArguments('prepare',base,{},source),/NOT_AUTHORIZED/);
 assert.throws(()=>readoptionArguments('activate',[...base,'--validation','a'.repeat(64)],auth,source),/ACTIVATION_NOT_AUTHORIZED/);
 assert.throws(()=>readoptionArguments('validate',base,auth,'other'),/SOURCE_MISMATCH/);
 assert.throws(()=>readoptionArguments('abort',[...base,'--force'],auth,source),/ARGUMENTS_INVALID/);
 assert.equal(readoptionArguments('prepare',base,auth,source).action,'prepare');
});
test('readoption readonly queries need an explicit existing UUID and no mutation authorization',()=>{
 assert.equal(readoptionArguments('status',base.slice(0,4),{},source).action,'status');
 assert.equal(readoptionArguments('evidence',base.slice(0,4),{},source).action,'evidence');
 assert.throws(()=>readoptionArguments('status',base,{},source),/ARGUMENTS_INVALID/);
 for(const id of ['new','automatic','invalid-uuid',''])assert.throws(()=>readoptionArguments('status',['--confirm-source',source,'--request-id',id],{},source),/ARGUMENTS_INVALID/);
});
test('activation and reconciliation pin the validation digest and bound each administrative run',()=>{
 const input=[...base,'--validation','a'.repeat(64)];
 const parsed=readoptionArguments('activate',input,activationAuth,source);assert.equal(parsed.action,'activate');
 if(parsed.action==='activate'){assert.equal(parsed.request.maxBatches,10);assert.equal(parsed.request.requestId,requestId);}
 for(const count of ['0','-1','10001','1.5','auto'])assert.throws(()=>readoptionArguments('reconcile',[...input,'--max-batches',count],activationAuth,source),/ARGUMENTS_INVALID/);
 assert.throws(()=>readoptionArguments('activate',base,activationAuth,source),/ARGUMENTS_INVALID/);
 assert.equal(readoptionArguments('reconcile',[...input,'--max-batches','1'],activationAuth,source).action,'reconcile');
});
