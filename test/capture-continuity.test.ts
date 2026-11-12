import test from 'node:test';
import assert from 'node:assert/strict';
import {continuityConsent,captureContinuity,historicalRead} from '../src/capture-continuity.js';
const valid={authorizationId:'11111111-1111-4111-8111-111111111111',parentHash:'a'.repeat(64),actor:'operator-test',evidenceRef:'TICKET-1',evidenceSha256:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z',acceptedHistoricalGap:true,remoteOperationSettled:true,cursorAssessment:'NO_KNOWN_UNSAFE_CURSOR_OR_UNCONTROLLED_OVERLAP'};
test('continuity requires an explicit assessment and never treats acceptance of loss as proof',()=>{
 assert.deepEqual(continuityConsent(valid),valid);
 for(const changed of [{remoteOperationSettled:false},{acceptedHistoricalGap:false},{cursorAssessment:'UNSAFE'},{cursorAssessment:'UNKNOWN'},{evidenceSha256:''},{actor:''},{expiresAt:'invalid'}])assert.throws(()=>continuityConsent({...valid,...changed}),/CONTINUITY_CONSENT_INVALID/);
});
test('unrelated origins, another pending read and disabled spool never use the exception',async()=>{
 const noDb=()=>{throw new Error('No authorization query expected');};
 for(const [source,pending,streaming] of [
  ['other',[{id:historicalRead,state:'reading'}],true],
  ['olos-production',[{id:historicalRead,state:'reading'},{id:'new',state:'received'}],true],
  ['olos-production',[{id:historicalRead,state:'reading'}],false],
 ] as const){const entries=[...pending];assert.deepEqual((await captureContinuity(noDb,entries,source,'target','binding',streaming)).pending,entries);}
});
