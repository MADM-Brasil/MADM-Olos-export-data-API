import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationalEvents } from '../src/admin/events.js';
import { log, observeLogs } from '../src/errors.js';

test('terminal receives actual process events without exposing unknown or sensitive fields',()=>{
  const events=new OperationalEvents();const stop=observeLogs(entry=>events.record(entry));
  try {
    log('batch_completed',{received:12,inserted:10,duplicates:2,duration_ms:50});
    events.record({event:'batch_completed',time:'2026-10-28T18:00:00.000Z',received:1,
      response_body:'PRIVATE_PAYLOAD',password:'PRIVATE_PASSWORD',username:'PRIVATE_USERNAME',clientId:'PRIVATE_CLIENT',clientSecret:'PRIVATE_SECRET',access_token:'PRIVATE_TOKEN',error:'provider body with private details'});
    events.record({event:'unknown_private_event',response_body:'PRIVATE_PAYLOAD'});
    assert.equal(events.snapshot().length,2);
    assert.equal(events.snapshot()[0]!.received,12);
    assert.equal(events.snapshot()[0]!.duplicates,2);
    assert.doesNotMatch(JSON.stringify(events.snapshot()),/PRIVATE_|provider body/);
    stop();log('scheduler_paused');assert.equal(events.snapshot().length,2);
  }finally{stop();}
});
test('terminal memory is bounded and starts empty on restart',()=>{
  const events=new OperationalEvents();
  for(let i=0;i<250;i++)events.record({event:'batch_completed',received:i});
  const snapshot=events.snapshot();assert.equal(snapshot.length,200);assert.equal(snapshot[0]!.received,50);
  snapshot.pop();assert.equal(events.snapshot().length,200);
  assert.equal(new OperationalEvents().snapshot().length,0);
});
test('terminal observation failure cannot fail a committed cycle log',()=>{
  const stop=observeLogs(()=>{throw new Error('display failure');});
  try{assert.doesNotThrow(()=>log('batch_completed',{received:0,inserted:0,duplicates:0}));}finally{stop();}
});
