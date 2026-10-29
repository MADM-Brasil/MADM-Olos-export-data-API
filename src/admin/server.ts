import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerError, errorCode } from '../errors.js';
import { AdminAuth, equal } from './security.js';
import type { CredentialService } from './credentials.js';
import type { DynamicScheduler } from '../scheduler.js';
import type { AdminRepository, Mode } from './repository.js';
import { interval } from './repository.js';

async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new WorkerError('JSON_REQUIRED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16384) throw new WorkerError('REQUEST_TOO_LARGE');
    chunks.push(part as Buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WorkerError('JSON_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkerError('JSON_INVALID');
  return value as Record<string, unknown>;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
export function adminServer(options: {
  origin: string; publicDir: string; auth: AdminAuth;
  credentials: Pick<CredentialService, 'view' | 'save' | 'test'>;
  scheduler: Pick<DynamicScheduler, 'request' | 'status'>;
  repository: Pick<AdminRepository, 'logs' | 'auditLog' | 'observation'>;
  events?: () => readonly import('../errors.js').LogEntry[];
}) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname)))) throw new WorkerError('ADMIN_ORIGIN_INVALID');
  const secure = origin.protocol === 'https:';
  const cookie = (token: string, age: number) => `olos_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const files: Record<string, [string, string]> = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = (req.url ?? '').split('?')[0]!;
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path]; res.setHeader('Content-Type', `${type}; charset=utf-8`);
        res.end(await readFile(join(options.publicDir, file))); return;
      }
      if (req.method !== 'GET' && req.headers.origin !== options.origin) throw new WorkerError('ORIGIN_FORBIDDEN');
      if (path === '/api/login' && req.method === 'POST') {
        const input = await body(req); const { token, session } = await options.auth.login(input.username, input.password);
        res.setHeader('Set-Cookie', cookie(token, 8 * 3600));
        send(res, 200, { actor: session.actor, csrf: session.csrf }); return;
      }
      const session = options.auth.session(req.headers.cookie);
      if (req.method !== 'GET' && !equal(String(req.headers['x-csrf-token'] ?? ''), session.csrf)) throw new WorkerError('CSRF_FORBIDDEN');
      if (path === '/api/session' && req.method === 'GET') { send(res, 200, { actor: session.actor, csrf: session.csrf }); return; }
      if (path === '/api/logout' && req.method === 'POST') {
        options.auth.logout(session.token); res.setHeader('Set-Cookie', cookie('', 0)); send(res, 200, { ok: true }); return;
      }
      if (path === '/api/status' && req.method === 'GET') {
        send(res, 200, { ...options.scheduler.status(), authentication: { status: 'ACCEPTED', authenticated_at: session.authenticatedAt },
          ...await options.repository.observation() }); return;
      }
      if (path === '/api/credentials' && req.method === 'GET') { send(res, 200, await options.credentials.view()); return; }
      if (path === '/api/credentials' && req.method === 'PUT') { send(res, 200, await options.credentials.save(session.actor, await body(req))); return; }
      if (path === '/api/credentials/test' && req.method === 'POST') { send(res, 200, await options.credentials.test(session.actor)); return; }
      if (path === '/api/logs' && req.method === 'GET') { send(res, 200, await options.repository.logs()); return; }
      if (path === '/api/events' && req.method === 'GET') { send(res, 200, options.events?.() ?? []); return; }
      if (path === '/api/audit' && req.method === 'GET') { send(res, 200, await options.repository.auditLog()); return; }
      if (path === '/api/schedule' && req.method === 'PATCH') {
        const input = await body(req);
        await options.scheduler.request(session.actor, { interval_ms: interval(input.interval_ms) });
        send(res, 200, options.scheduler.status()); return;
      }
      const modes: Record<string, Mode> = { '/api/worker/pause': 'PAUSED', '/api/worker/resume': 'RUNNING', '/api/worker/start': 'RUNNING', '/api/worker/stop': 'STOPPED' };
      if (req.method === 'POST' && modes[path]) {
        const input = await body(req);
        if (modes[path] === 'STOPPED' && input.confirm !== true) throw new WorkerError('STOP_CONFIRMATION_REQUIRED');
        await options.scheduler.request(session.actor, { mode: modes[path] });
        send(res, 202, options.scheduler.status()); return;
      }
      send(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = errorCode(error);
      const status = ['LOGIN_FAILED','AUTHENTICATION_REQUIRED'].includes(code) ? 401 : code.endsWith('FORBIDDEN') ? 403 : code === 'LOGIN_RATE_LIMITED' ? 429 : code.endsWith('CONFLICT') ? 409 : error instanceof WorkerError ? 400 : 503;
      if (!res.headersSent) send(res, status, { error: code }); else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  return server;
}
