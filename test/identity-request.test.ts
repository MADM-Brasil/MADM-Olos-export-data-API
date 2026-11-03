import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRequest,consent,validateRequest} from '../src/identity/request.js';
const review='b'.repeat(64),id='12345678-1234-4234-8234-123456789012',hash='a'.repeat(64);
test('identity CLI binds separate local and corporate authorizations to exact immutable manifest',()=>{
 assert.notEqual(consent('execute',id,hash,'pending'),consent('execute',id,hash,'confirmed'));
 assert.notEqual(consent('execute',id,hash,'confirmed'),consent('reconcile',id,hash,'confirmed'));
 assert.deepEqual(parseRequest(['plan','--kind','pending','--source-ids','47558756,47559439,47561569','--dependency-review',review]),
  {action:'plan',kind:'pending',ids:['47558756','47559439','47561569'],review});
});
test('identity CLI rejects duplicate flags, unbounded scopes, invalid IDs and overflow before connecting',()=>{
 for(const ids of [[],['1','1'],['0'],['01'],['2147483648'],['9007199254740993'],Array.from({length:1001},(_,i)=>String(i+1))])
  assert.throws(()=>validateRequest({action:'plan',kind:'pending',ids,review}));
 for(const args of [['plan'],['execute','--id',id],['status','--id',id,'--id',id],['status','--id',id,'--extra','x'],['all']])assert.throws(()=>parseRequest(args));
});
