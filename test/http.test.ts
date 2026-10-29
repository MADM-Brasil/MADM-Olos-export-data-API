import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { HttpTransport, retryAfter, type Transport } from '../src/http.js';
import { OlosApi, rows } from '../src/api.js';
import { OlosAuthManager } from '../src/auth.js';
import { HttpError, WorkerError } from '../src/errors.js';
import { sequentialPolling } from '../src/worker.js';

const credentials={username:'u',password:'p',clientId:'i',clientSecret:'s'};
const token=JSON.stringify({access_token:'a',refresh_token:'r',token_type:'bearer',expires_in:3600});
const auth=()=>new OlosAuthManager(async()=>token,credentials);
async function server(handler:(req:IncomingMessage,res:ServerResponse)=>void) {
  const s=createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');
  const addr=s.address();assert(addr && typeof addr!=='string');
  return {url:`http://127.0.0.1:${addr.port}/WebApiExportData`,close:()=>new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()))};
}
test('HTTP multipart auth/current-day and 200 array empty/non-empty through real local sockets',async()=>{
  let reads=0;const sockets=new Set();
  const s=await server((req,res)=>{
    sockets.add(req.socket);assert.match(req.headers['content-type']!,/^multipart\/form-data; boundary=/);
    const chunks:Buffer[]=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{
      const body=Buffer.concat(chunks).toString();
      if(req.url!.endsWith('/api/auth')) {assert.match(body,/name="grant_type"\r\n\r\npassword/);res.end(token);}
      else {assert.equal(req.headers.authorization,'Bearer a');assert.match(body,/name="TableName"\r\n\r\nAttemptsRawData/);res.end(reads++?'[]':'[{"AttemptsRawDataID":9007199254740993}]');}
    });
  });
  const h=new HttpTransport(s.url,1000,10000,new AbortController().signal);
  try {
    const api=new OlosApi(h.request,new OlosAuthManager(h.request,credentials));
    assert.equal(rows(await api.read({kind:'current'}))[0]!.AttemptsRawDataID,'9007199254740993');
    assert.deepEqual(rows(await api.read({kind:'current'})),[]);assert.equal(sockets.size,1);
  } finally {await h.close();await s.close();}
});
test('429 Retry-After, bounded safe retries, network ambiguity never repeats consuming read',async()=>{
  let count=0;const waits:number[]=[];
  const request:Transport=async()=>{if(++count<3)throw new HttpError(429,7000);return '[]';};
  assert.equal(await new OlosApi(request,auth(),async ms=>{waits.push(ms);}).read({kind:'current'}),'[]');
  assert.deepEqual(waits,[7000,7000]);
  for(const error of [new HttpError(500),new WorkerError('NETWORK_OR_RESPONSE_FAILURE',true)]) {
    count=0;const api=new OlosApi(async()=>{count++;throw error;},auth(),async()=>{});
    await assert.rejects(api.read({kind:'current'}));assert.equal(count,1);
    count=0;await assert.rejects(api.call('/api/export-data/available-tables'));assert.equal(count,3);
  }
  assert.equal(retryAfter('2'),2000);assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT',1000),2000);
});
test('timeouts, response limits and non-arrays fail explicitly',async()=>{
  const s=await server((req,res)=>{if(req.url!.endsWith('/large'))res.end('x'.repeat(2000));});
  const h=new HttpTransport(s.url,50,1024,new AbortController().signal);
  try {
    await assert.rejects(h.request('/large'),/RESPONSE_TOO_LARGE/);
    await assert.rejects(h.request('/slow'),/NETWORK_OR_RESPONSE_FAILURE/);
    assert.throws(()=>rows('{}'),/ARRAY_RESPONSE_REQUIRED/);assert.throws(()=>rows('[null]'),/ARRAY_RESPONSE_REQUIRED/);
  } finally {await h.close();await s.close();}
});
test('421 must not transparently replay a consuming multipart POST',async()=>{
  let requests=0;
  const s=await server(async(req,res)=>{
    for await(const _ of req) { /* drain request body */ }
    requests++;res.writeHead(421);res.end('{}');
  });
  const h=new HttpTransport(s.url,1000,10000,new AbortController().signal);
  try {
    let failure:unknown;
    try {await h.request('/api/export-data/read-data-current-day',{TableName:'AttemptsRawData'},'fixture');} catch(error) {failure=error;}
    assert.equal(requests,1);
    assert(failure instanceof HttpError);assert.equal(failure.status,421);
  } finally {await h.close();await s.close();}
});
test('catalog validates table/columns and rejects guessed formats',async()=>{
  const catalog=[{TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},{TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}];
  const api=new OlosApi(async()=>JSON.stringify(catalog),auth());await api.available();
  catalog[0]!.Columns.pop();await assert.rejects(api.available(),/CATALOG_MISSING/);
  await assert.rejects(new OlosApi(async()=>'["AttemptsRawData"]',auth()).available());
});
test('poll waits 2000ms after completion, never overlaps, and backs off auth outages',async()=>{
  const stop=new AbortController();const sequence:string[]=[];let active=0,maxActive=0,count=0;
  await sequentialPolling(async()=>{
    active++;maxActive=Math.max(maxActive,active);sequence.push('start');await new Promise(r=>setImmediate(r));sequence.push('end');active--;
    if(++count===3)stop.abort();
  },2000,stop.signal,async ms=>{sequence.push(`wait:${ms}`);});
  assert.equal(maxActive,1);assert.deepEqual(sequence,['start','end','wait:2000','start','end','wait:2000','start','end']);
  const delays:number[]=[];count=0;
  await assert.rejects(sequentialPolling(async()=>{count++;throw new WorkerError('AUTH_UNAVAILABLE',true);},2000,new AbortController().signal,async ms=>{delays.push(ms);},3,()=>{}));
  assert.equal(count,3);assert.deepEqual(delays,[2000,4000]);
});
