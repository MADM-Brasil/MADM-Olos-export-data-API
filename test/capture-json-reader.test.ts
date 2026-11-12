import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureToDisk} from '../src/capture-spool.js';
import {readCaptureObjects} from '../src/capture-json-reader.js';
import {rows} from '../src/api.js';

async function collect(raw:string|Buffer,limit=16384){
  const dir=await mkdtemp(join(tmpdir(),'olos-json-')),bytes=typeof raw==='string'?Buffer.from(raw):raw;
  try{
    async function* parts(){for(let n=0;n<bytes.length;n+=7)yield bytes.subarray(n,n+7);}
    const capture=await captureToDisk(parts(),dir,randomUUID(),Math.max(bytes.length,1)),result:Record<string,unknown>[]=[];
    for await(const row of readCaptureObjects(capture,limit))result.push(row.value);
    return result;
  }finally{await rm(dir,{recursive:true,force:true});}
}
test('incremental JSON retains lossless numeric strings, escaping, nested arrays, Unicode and empty arrays',async()=>{
  for(const raw of ['[]',' \r\n[]\t','[{"id":9007199254740993,"n":1.2300,"e":1e30,"nested":{"a":[1,true,null,"ação 🚀"]},"s":"quote\\\" slash\\\\ braces{}[] \\uD83D\\uDE80"}]','[{"__proto__":{"polluted":true}}]'])assert.deepEqual(await collect(raw),rows(raw));
  assert.equal(({} as Record<string,unknown>).polluted,undefined);
});
for(const raw of ['','[','[{"id":1}','[{"id":1},]','[{},{}] false','[{}] [{}]','[null]','[1]','[[{}]]','{}','[{"a":"bad\\x00"}]','[{"a":01}]','[{"a":1,"a":2}]','[{"a":{"x":1,"x":2}}]','\ufeff[]'])test(`invalid incremental JSON is rejected (${JSON.stringify(raw)})`,async()=>{
  await assert.rejects(collect(raw));
});
test('valid UTF-8 split across file chunks and bounded nesting retain their semantics',async()=>{
  const raw=JSON.stringify([{p:'a'.repeat(16373)+'é🚀z'}]);assert.deepEqual(await collect(raw,32768),rows(raw));
  await assert.rejects(collect('[{"nested":'+'['.repeat(70)+'0'+']'.repeat(70)+'}]'),/CAPTURE_JSON_LIMIT/);
});
test('invalid UTF-8 and oversized materialized objects fail explicitly',async()=>{
  await assert.rejects(collect(Buffer.from([91,123,34,97,34,58,34,0xc3,0x28,34,125,93])));
  await assert.rejects(collect(JSON.stringify([{s:'x'.repeat(4096)}]),1024),/CAPTURE_OBJECT_TOO_LARGE|CAPTURE_JSON_LIMIT/);
});
