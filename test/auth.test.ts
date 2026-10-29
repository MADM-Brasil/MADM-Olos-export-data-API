import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OlosAuthManager } from '../src/auth.js';
import { OlosApi } from '../src/api.js';
import { AuthUnavailable, HttpError, WorkerError } from '../src/errors.js';
import type { Transport } from '../src/http.js';

const credentials = { username: 'user', password: 'password', clientId: 'client', clientSecret: 'secret' };
const token = (access = 'access', refresh: string | undefined = 'refresh', ttl = 3600) => JSON.stringify({ access_token: access, ...(refresh ? { refresh_token: refresh } : {}), expires_in: ttl, token_type: 'bearer' });

test('password grant, cache and single flight across concurrent callers', async () => {
  const calls: unknown[] = [];
  const auth = new OlosAuthManager(async (path, fields) => { calls.push({path,fields}); await new Promise(r => setImmediate(r)); return token(); }, credentials);
  assert.deepEqual(await Promise.all(Array.from({length:20}, () => auth.getToken())), Array(20).fill('access'));
  assert.equal(await auth.getToken(), 'access'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {path:'/api/auth', fields:{grant_type:'password',username:'user',password:'password',client_id:'client',client_secret:'secret'}});
});

test('real expires_in, early renewal and rotating refresh tokens across multiple lifetimes', async () => {
  let now = 0, n = 0;
  const grants: Record<string,string>[] = [];
  const auth = new OlosAuthManager(async (_, fields) => { grants.push(fields!); return token(`a${++n}`, `r${n}`, 120); }, credentials, () => now);
  assert.equal(await auth.getToken(), 'a1'); now = 107999; assert.equal(await auth.getToken(), 'a1');
  now = 108000; assert.equal(await auth.getToken(), 'a2'); assert.equal(grants[1]!.refresh_token, 'r1');
  now = 216001; assert.equal(await auth.getToken(), 'a3'); assert.equal(grants[2]!.refresh_token, 'r2');
});

test('60 second margin for long tokens, adjusted margin for one-second tokens', async () => {
  let now = 0, n = 0;
  const auth = new OlosAuthManager(async () => token(`a${++n}`, 'r', 7200), credentials, () => now);
  await auth.getToken(); now = 7139999; await auth.getToken(); assert.equal(n,1);
  now = 7140000; await auth.getToken(); assert.equal(n,2);
  now = 0; n = 0;
  const short = new OlosAuthManager(async () => token(`a${++n}`, 'r', 1), credentials, () => now);
  await short.getToken(); now=899; await short.getToken(); assert.equal(n,1);
  now=900; await short.getToken(); assert.equal(n,2);
});

test('omitted refresh token preserves previous token', async () => {
  let now=0, n=0;
  const fields: Record<string,string>[]=[];
  const auth=new OlosAuthManager(async (_,f)=>{ fields.push(f!); return ++n===1 ? token('a1','original',10) : token(`a${n}`,'',10); },credentials,()=>now);
  await auth.getToken(); now=9000; await auth.getToken(); now=18000; await auth.getToken();
  assert.equal(fields[2]!.refresh_token,'original');
});

for (const status of [400,401]) test(`rejected refresh ${status} falls back to password and replaces credentials`, async () => {
  let now=0; const grants: string[]=[];
  const auth=new OlosAuthManager(async (_,f)=>{grants.push(f!.grant_type!); if(f!.grant_type==='refresh_token') throw new HttpError(status); return token('a','r',10);},credentials,()=>now);
  await auth.getToken(); now=10000; await auth.getToken();
  assert.deepEqual(grants,['password','refresh_token','password']);
});

test('refresh outage does not use password fallback; inflight clears for later retry', async()=>{
  let now=0, outage=false, calls=0;
  const auth=new OlosAuthManager(async()=>{calls++;if(outage)throw new HttpError(500);return token('a','r',10);},credentials,()=>now);
  await auth.getToken();now=10000;outage=true;await assert.rejects(auth.getToken(),/HTTP_500/);
  assert.equal(calls,2);outage=false;await auth.getToken();assert.equal(calls,3);
});

test('401 refreshes and retries exactly once; stale 401 does not invalidate newer token', async()=>{
  let authCalls=0, readCalls=0;
  const request:Transport=async(path)=>{
    if(path==='/api/auth') return token(`a${++authCalls}`);
    if(++readCalls===1)throw new HttpError(401);return '[]';
  };
  const auth=new OlosAuthManager(request,credentials); const api=new OlosApi(request,auth);
  assert.equal(await api.read({kind:'current'}),'[]'); assert.equal(authCalls,2); assert.equal(readCalls,2);
  auth.invalidate('a1');assert.equal(await auth.getToken(),'a2');assert.equal(authCalls,2);
  const failing=new OlosApi(async()=>{readCalls++;throw new HttpError(401);},auth);
  const before=readCalls;await assert.rejects(failing.read({kind:'current'}),/HTTP_401/);assert.equal(readCalls-before,2);
});

test('initial auth outage and malformed expiry never dispatch data requests', async()=>{
  let dataCalls=0;
  const request:Transport=async(path)=>{if(path==='/api/auth')throw new HttpError(503);dataCalls++;return '[]';};
  await assert.rejects(new OlosApi(request,new OlosAuthManager(request,credentials)).read({kind:'current'}),AuthUnavailable);
  assert.equal(dataCalls,0);
  for(const expires_in of [0,-1,'bad',null]) {
    const auth=new OlosAuthManager(async()=>JSON.stringify({access_token:'a',token_type:'bearer',expires_in}),credentials);
    await assert.rejects(auth.getToken(),/AUTH_RESPONSE_INVALID/);
  }
  const invalid=new OlosAuthManager(async()=>'{',credentials);await assert.rejects(invalid.getToken(),WorkerError);
});
