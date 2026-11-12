import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import parser, { type Token } from 'stream-json/parser.js';
import streamArray from 'stream-json/streamers/stream-array.js';
import { openCaptureFile, type CaptureResult } from './capture-spool.js';
import { WorkerError } from './errors.js';

export interface CaptureObject { index:number; value:Record<string,unknown>; bytes:number }

// JSON syntax and assembly belong to stream-json. This guard only bounds materialization.
export async function* readCaptureObjects(capture:CaptureResult,maxObjectBytes:number,signal?:AbortSignal):AsyncGenerator<CaptureObject> {
  if(!Number.isSafeInteger(maxObjectBytes)||maxObjectBytes<1)throw new WorkerError('CAPTURE_OBJECT_LIMIT_INVALID');
  const file=await openCaptureFile(capture.path),hash=createHash('sha256');let bytes=0,depth=0,budget=0;
  const keys:Set<string>[]=[];
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  const decode=new Transform({transform(chunk:Buffer,_encoding,done){
    try{bytes+=chunk.length;if(bytes>capture.bytes)throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');hash.update(chunk);done(null,decoder.decode(chunk,{stream:true}));}
    catch(error){done(error instanceof Error?error:new WorkerError('CAPTURE_JSON_INVALID'));}
  },flush(done){try{done(null,decoder.decode());}catch{done(new WorkerError('CAPTURE_UTF8_INVALID'));}}});
  const guard=new Transform({objectMode:true,transform(token:Token,_encoding,done){
    try{
      if(depth===0&&token.name!=='startArray')throw new WorkerError('ARRAY_RESPONSE_REQUIRED');
      if(depth===1&&token.name!=='startObject'&&token.name!=='endArray')throw new WorkerError('ARRAY_RESPONSE_REQUIRED');
      if(token.name==='startObject'||token.name==='startArray'){
        if(depth===1)budget=0;depth++;budget+=2;
      }
      if(token.name==='startObject')keys.push(new Set());
      if(token.name==='keyValue'){
        const current=keys.at(-1)!;
        if(current.has(token.value))throw new WorkerError('CAPTURE_JSON_DUPLICATE_KEY');current.add(token.value);
      }
      if(token.name==='endObject')keys.pop();
      if(depth>1){
        if(token.name==='startKey'||token.name==='startString')budget+=4;
        if(token.name==='stringChunk')budget+=Buffer.byteLength(JSON.stringify(token.value))-2;
        if(token.name==='numberChunk')budget+=token.value.length;
        if(['nullValue','trueValue','falseValue'].includes(token.name))budget+=5;
        if(budget>maxObjectBytes)throw new WorkerError('CAPTURE_OBJECT_TOO_LARGE');
      }
      if(token.name==='endObject'||token.name==='endArray')depth--;
      done(null,token);
    }catch(error){done(error instanceof Error?error:new WorkerError('CAPTURE_JSON_INVALID'));}
  }});
  const output=streamArray.asStream({numberAsString:true});
  const input=file.createReadStream({autoClose:false,highWaterMark:16*1024});
  const operation=pipeline(input,decode,parser.asStream({maxDepth:64,maxPackedLength:maxObjectBytes,streamValues:true,ignoreBOM:true}),guard,output,
    signal?{signal}:{});
  // Observe errors immediately, including while the downstream consumer is awaiting PostgreSQL.
  void operation.catch(()=>{});
  try{
    for await(const item of output){
      const entry=item as {key:number;value:unknown};
      if(!entry.value||typeof entry.value!=='object'||Array.isArray(entry.value))throw new WorkerError('ARRAY_RESPONSE_REQUIRED');
      const size=Buffer.byteLength(JSON.stringify(entry.value));
      if(size>maxObjectBytes)throw new WorkerError('CAPTURE_OBJECT_TOO_LARGE');
      yield {index:entry.key,value:entry.value as Record<string,unknown>,bytes:size};
    }
    await operation;
    if(bytes!==capture.bytes||hash.digest('hex')!==capture.sha256)throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');
  }catch(error){
    if(error instanceof WorkerError)throw error;
    throw new WorkerError(signal?.aborted?'CAPTURE_READ_ABORTED':error instanceof RangeError?'CAPTURE_JSON_LIMIT':'CAPTURE_JSON_INVALID');
  }finally{
    input.destroy();output.destroy();await operation.catch(()=>{});await file.close();
  }
}
