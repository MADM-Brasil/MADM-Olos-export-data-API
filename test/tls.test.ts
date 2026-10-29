import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { HttpTransport } from '../src/http.js';
import { olosTlsVerify } from '../src/config.js';

test('OLOS TLS verification defaults true and requires an explicit boolean string',()=>{
  assert.equal(olosTlsVerify({}),true);
  assert.equal(olosTlsVerify({OLOS_TLS_VERIFY:'true'}),true);
  assert.equal(olosTlsVerify({OLOS_TLS_VERIFY:'false'}),false);
  for(const value of ['','0','no','FALSE'])assert.throws(()=>olosTlsVerify({OLOS_TLS_VERIFY:value}),/CONFIG_INVALID_OLOS_TLS_VERIFY/);
});

test('TLS exception is limited to the OLOS agent, warns, and leaves other clients validating',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'olos-tls-test-'));
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=fixture.invalid','-addext','subjectAltName=DNS:fixture.invalid'],{stdio:'ignore'});
  const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(_req,res)=>res.end('[]'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address&&typeof address!=='string');
  const url=`https://127.0.0.1:${address.port}`;
  const initialGlobal=process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const normal=new HttpTransport(url,1000,1024,new AbortController().signal);
  let exception:HttpTransport;
  const output:string[]=[];const original=process.stdout.write;
  try {
    process.stdout.write=((chunk:unknown)=>{output.push(String(chunk));return true;}) as typeof process.stdout.write;
    exception=new HttpTransport(url,1000,1024,new AbortController().signal,false);
  } finally {process.stdout.write=original;}
  try {
    assert.match(output.join(''),/olos_tls_verification_disabled/);
    assert.match(output.join(''),/OLOS_HTTP_ONLY/);
    await assert.rejects(normal.request('/'),/NETWORK_OR_RESPONSE_FAILURE/);
    assert.equal(await exception!.request('/'),'[]');
    await assert.rejects(new Promise((resolve,reject)=>{get(url,resolve).on('error',reject);}),/self-signed certificate/);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,initialGlobal);
    await assert.rejects(normal.request('/'),/NETWORK_OR_RESPONSE_FAILURE/);
  } finally {
    await normal.close();await exception!.close();
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    rmSync(dir,{recursive:true,force:true});
  }
});
