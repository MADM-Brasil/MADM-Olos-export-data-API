import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Store } from '../src/store.js';
import { config } from '../src/config.js';

const ID = '2523225a-a46d-407a-ad5a-d1ff771e576e';

test('flags e argv nao autorizam ignorar uma leitura historica incerta', async () => {
  const store = Object.create(Store.prototype) as Store;
  Object.defineProperty(store,'cfg',{value:config({DATABASE_URL:'postgresql://unused@localhost/local',OLOS_SOURCE_KEY:'synthetic'})});
  store.captureReady=async()=>{};
  const originalCommand = process.argv[2];
  process.argv[2] = 'once';

  const originalId = process.env.OLOS_UNRECONCILED_CURRENT_PARENT;
  const originalAck = process.env.OLOS_CAPTURE_RISK_ACK;

  const parent = {
    id: ID,
    state: 'reading',
    spec: {
      kind: 'current',
      recovery_authorization: {
        manifest: { version: 2 }
      }
    },
    error_code: 'RESPONSE_TOO_LARGE',
    response_body: null,
    processed_count: 0,request_ms:null,received_count:null,started_at:new Date('2026-11-12T15:51:31.247Z'),
  };

  const current = { kind: 'current' } as const;

  try {
    delete process.env.OLOS_UNRECONCILED_CURRENT_PARENT;
    delete process.env.OLOS_CAPTURE_RISK_ACK;

    const original=structuredClone(parent);
    store.unresolved=async()=>[parent] as Awaited<ReturnType<Store['unresolved']>>;
    await assert.rejects(store.beginRead(current),/RECOVERY_REQUIRED/);

    process.env.OLOS_UNRECONCILED_CURRENT_PARENT = ID;
    process.env.OLOS_CAPTURE_RISK_ACK =
      'AUTHORIZE_CURRENT_WITH_HISTORICAL_PENDING';

    await assert.rejects(store.beginRead(current),/RECOVERY_REQUIRED/);
    for(const pending of [[parent,{...parent,id:'outra-leitura'}],[{...parent,state:'received'}],[{...parent,error_code:'NETWORK_OR_RESPONSE_FAILURE'}]]){
      store.unresolved=async()=>pending as Awaited<ReturnType<Store['unresolved']>>;
      await assert.rejects(store.beginRead(current),/RECOVERY_REQUIRED/);
    }
    store.unresolved=async()=>[parent] as Awaited<ReturnType<Store['unresolved']>>;
    await assert.rejects(store.beginRead({kind:'previous'}),/RECOVERY_REQUIRED/);
    await assert.rejects(store.beginRead({kind:'reread',date:'2026-11-12',start:'51698102',end:'51737251'},true),/RECOVERY_AUTHORIZATION_REQUIRED/);
    assert.deepEqual(parent,original);
  } finally {
    if (originalCommand === undefined) {
      process.argv.splice(2, 1);
    } else {
      process.argv[2] = originalCommand;
    }

    if (originalId === undefined)
      delete process.env.OLOS_UNRECONCILED_CURRENT_PARENT;
    else
      process.env.OLOS_UNRECONCILED_CURRENT_PARENT = originalId;

    if (originalAck === undefined)
      delete process.env.OLOS_CAPTURE_RISK_ACK;
    else
      process.env.OLOS_CAPTURE_RISK_ACK = originalAck;
  }
});
