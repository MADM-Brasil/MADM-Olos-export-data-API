import { Agent, fetch, FormData, Request } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, WorkerError, log } from './errors.js';
import { captureToDisk, type CaptureResult } from './capture-spool.js';

export type Transport = (path: string, fields?: Record<string, string>, token?: string) => Promise<string>;
export const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, signal ? { signal } : {});
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

export class HttpTransport {
  private readonly agent: Agent;
  private readonly base:URL;
  readonly request: Transport;
  constructor(baseUrl: string, private readonly timeoutMs: number, private readonly maxBytes: number, private readonly signal: AbortSignal, tlsVerify = true) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
      throw new WorkerError('HTTPS_REQUIRED');
    }
    if (base.username || base.password || base.search || base.hash) throw new WorkerError('INVALID_BASE_URL');
    this.base=base;
    this.agent = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: tlsVerify } });
    if (!tlsVerify) log('olos_tls_verification_disabled', { level: 'warn', scope: 'OLOS_HTTP_ONLY' });
    this.request = async (path, fields, token) => {
      const body = fields ? new FormData() : undefined;
      for (const [key, value] of Object.entries(fields ?? {})) body!.append(key, value);
      try {
        const url = `${base.href.replace(/\/$/, '')}${path}`;
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        let stream: ReadableStream<Uint8Array> | undefined;
        if (body) {
          const encoded = new Request(url, { method: 'POST', body });
          const bytes = new Uint8Array(await encoded.arrayBuffer());
          headers['Content-Type'] = encoded.headers.get('content-type')!;
          headers['Content-Length'] = String(bytes.byteLength);
          // A one-shot body prevents fetch's implicit 421 replay; retries belong to OlosApi.
          stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
        }
        const response = await fetch(url, {
          method: body ? 'POST' : 'GET', ...(stream ? { body: stream, duplex: 'half' as const } : {}),
          headers,
          dispatcher: this.agent, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new HttpError(response.status, retryAfter(response.headers.get('retry-after')));
        }
        if (Number(response.headers.get('content-length')) > maxBytes) {
          await response.body?.cancel(); throw new WorkerError('RESPONSE_TOO_LARGE');
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body!) {
          size += chunk.length;
          if (size > maxBytes) { await response.body?.cancel().catch(() => {}); throw new WorkerError('RESPONSE_TOO_LARGE'); }
          chunks.push(chunk);
        }
        // Preserve a BOM as part of the original response text, including captures.
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      } catch (error) {
        if (error instanceof WorkerError) throw error;
        throw new WorkerError('NETWORK_OR_RESPONSE_FAILURE', true);
      }
    };
  }
  private async response(path:string,fields:Record<string,string>|undefined,token:string|undefined,maxBytes:number,timeoutMs:number,signal:AbortSignal) {
    if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw new WorkerError('INVALID_REQUEST_PATH');
    const url=new URL(`${this.base.href.replace(/\/$/,'')}${path}`);
    if(url.origin!==this.base.origin)throw new WorkerError('INVALID_REQUEST_PATH');
    const headers:Record<string,string>={'Accept-Encoding':'identity',...(token?{Authorization:`Bearer ${token}`}:{})};
    let stream:ReadableStream<Uint8Array>|undefined;
    if(fields){
      const body=new FormData();for(const [key,value] of Object.entries(fields))body.append(key,value);
      const encoded=new Request(url,{method:'POST',body}),bytes=new Uint8Array(await encoded.arrayBuffer());
      headers['Content-Type']=encoded.headers.get('content-type')!;headers['Content-Length']=String(bytes.byteLength);
      // Prevent fetch's implicit 421 replay for all consuming requests, including spool.
      stream=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}});
    }
    const response=await fetch(url,{method:fields?'POST':'GET',...(stream?{body:stream,duplex:'half' as const}:{}),headers,dispatcher:this.agent,redirect:'error',
      signal:AbortSignal.any([this.signal,signal,AbortSignal.timeout(timeoutMs)])});
    if(response.status!==200){await response.body?.cancel().catch(()=>{});throw new HttpError(response.status,retryAfter(response.headers.get('retry-after')));}
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>maxBytes)){
      await response.body?.cancel().catch(()=>{});throw new WorkerError('RESPONSE_TOO_LARGE');
    }
    return response;
  }
  async captureToSpool(path:string,fields:Record<string,string>,token:string,directory:string,readId:string,
    maxBytes=this.maxBytes,timeoutMs=this.timeoutMs,signal=this.signal):Promise<CaptureResult> {
    try{
      const response=await this.response(path,fields,token,maxBytes,timeoutMs,signal);
      if(!response.body)throw new WorkerError('CAPTURE_RESPONSE_MISSING');
      return await captureToDisk(response.body,directory,readId,maxBytes);
    }catch(error){if(error instanceof WorkerError)throw error;throw new WorkerError('NETWORK_OR_RESPONSE_FAILURE',true);}
  }
  async close() { await this.agent.close(); }
}
