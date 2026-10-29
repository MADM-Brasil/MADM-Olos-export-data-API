import { Agent, fetch, FormData, Request } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, WorkerError, log } from './errors.js';

export type Transport = (path: string, fields?: Record<string, string>, token?: string) => Promise<string>;
export const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, signal ? { signal } : {});
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

export class HttpTransport {
  private readonly agent: Agent;
  readonly request: Transport;
  constructor(baseUrl: string, timeoutMs: number, maxBytes: number, signal: AbortSignal, tlsVerify = true) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
      throw new WorkerError('HTTPS_REQUIRED');
    }
    if (base.username || base.password || base.search || base.hash) throw new WorkerError('INVALID_BASE_URL');
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
  async close() { await this.agent.close(); }
}
