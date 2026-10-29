import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WorkerError, errorCode } from '../errors.js';
import { type Config } from '../config.js';
import { HttpTransport } from '../http.js';
import { OlosAuthManager } from '../auth.js';
import type { AdminRepository } from './repository.js';

export type Credentials = Pick<Config, 'baseUrl' | 'username' | 'password' | 'clientId' | 'clientSecret'>;
export function configuredOlosOrigins(baseUrl: string, explicit?: string): string[] {
  try {
    const origins = explicit ? explicit.split(',').map(value => value.trim()) : [new URL(baseUrl).origin];
    if (origins.some(value => new URL(value).origin !== value)) throw new Error();
    validateBaseUrl(baseUrl, origins);
    return origins;
  } catch { throw new WorkerError('ADMIN_OLOS_ORIGIN_INVALID'); }
}
export function encryptionKey(raw: string) {
  if (!/^[a-f\d]{64}$/i.test(raw)) throw new WorkerError('ADMIN_ENCRYPTION_KEY_REQUIRED');
  return Buffer.from(raw, 'hex');
}
export function seal(value: Credentials, key: Buffer, source: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`olos-credentials:v1:${source}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}
export function unseal(value: string, key: Buffer, source: string): Credentials {
  try {
    const [version, iv, tag, body, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !body || extra) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    cipher.setAAD(Buffer.from(`olos-credentials:v1:${source}`)); cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString('utf8')) as Credentials;
  } catch { throw new WorkerError('CREDENTIAL_DECRYPTION_FAILED'); }
}
export function validateBaseUrl(value: string, allowedOrigins: readonly string[]) {
  let url: URL; try { url = new URL(value); } catch { throw new WorkerError('OLOS_URL_INVALID'); }
  if (!allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new WorkerError('OLOS_URL_NOT_ALLOWED');
  // Restrict the product endpoint too; credentials cannot be sent to an arbitrary route.
  if (url.pathname.replace(/\/$/, '') !== '/WebApiExportData') throw new WorkerError('OLOS_URL_INVALID');
  return url.href.replace(/\/$/, '');
}
export class CredentialService {
  private testing = false;
  constructor(private readonly repo: Pick<AdminRepository, 'credentials' | 'saveCredentials' | 'tested' | 'source' | 'lastEnvironmentTest'>,
    private readonly cfg: Config, private readonly key: Buffer, private readonly allowedOrigins: readonly string[],
    private readonly probe = testConnection) {}
  async snapshot() {
    const stored = await this.repo.credentials();
    const credentials: Credentials = stored ? unseal(stored.encrypted_payload, this.key, this.repo.source) : {
      baseUrl: this.cfg.baseUrl, username: this.cfg.username, password: this.cfg.password, clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret,
    };
    return { revision: stored?.revision ?? 0, credentials, stored };
  }
  async view() {
    const { credentials: c, revision, stored } = await this.snapshot();
    return { baseUrl: c.baseUrl, username: c.username, passwordConfigured: !!c.password,
      technicalCredentialsConfigured: !!c.clientId && !!c.clientSecret, complete: Object.values(c).every(Boolean), revision,
      origin: stored ? 'database' : 'environment', lastTest: stored ? (stored.last_test_at ? {
        at: stored.last_test_at, ok: stored.last_test_ok, code: stored.last_test_code, duration_ms: stored.last_test_ms,
      } : null) : await this.repo.lastEnvironmentTest() };
  }
  async save(actor: string, input: Record<string, unknown>) {
    if ('clientId' in input || 'clientSecret' in input) throw new WorkerError('TECHNICAL_CREDENTIALS_SERVER_ONLY');
    const snapshot = await this.snapshot();
    if (!Number.isInteger(input.revision) || input.revision !== snapshot.revision) throw new WorkerError('CREDENTIAL_REVISION_CONFLICT');
    const read = (field: 'baseUrl' | 'username' | 'password') => {
      const value = input[field] ?? snapshot.credentials[field];
      if (typeof value !== 'string' || value.length > 4096) throw new WorkerError('CREDENTIAL_INPUT_INVALID');
      return value;
    };
    const next = { ...snapshot.credentials, baseUrl: validateBaseUrl(read('baseUrl'), this.allowedOrigins), username: read('username'),
      password: read('password') || snapshot.credentials.password };
    if (!Object.values(next).every(Boolean)) throw new WorkerError('CREDENTIAL_CONFIGURATION_INCOMPLETE');
    await this.repo.saveCredentials(actor, snapshot.revision, seal(next, this.key, this.repo.source));
    return this.view();
  }
  async authenticateUser(username: string, password: string) {
    const { credentials } = await this.snapshot();
    validateBaseUrl(credentials.baseUrl, this.allowedOrigins);
    // Dedicated transport/AuthManager. Never mutates the ingestion manager or saves this password/token.
    await authenticateOlos(this.cfg, { ...credentials, username, password });
  }
  async test(actor: string) {
    if (this.testing) throw new WorkerError('CONNECTION_TEST_ALREADY_ACTIVE');
    this.testing = true;
    try {
      const { revision, credentials } = await this.snapshot();
      validateBaseUrl(credentials.baseUrl, this.allowedOrigins);
      if (!Object.values(credentials).every(Boolean)) throw new WorkerError('CREDENTIAL_CONFIGURATION_INCOMPLETE');
      const start = performance.now(); let ok = false, code = 'CONNECTION_OK';
      try { await this.probe(this.cfg, credentials); ok = true; } catch (error) { code = errorCode(error); }
      const result = { at: new Date().toISOString(), ok, code, duration_ms: Math.round(performance.now() - start) };
      await this.repo.tested(actor, revision, ok, code, result.duration_ms);
      return { ...result, revision };
    } finally { this.testing = false; }
  }
}
export async function testConnection(cfg: Config, credentials: Credentials) {
  await authenticateOlos(cfg, credentials);
}
async function authenticateOlos(cfg: Config, credentials: Credentials) {
  const http = new HttpTransport(credentials.baseUrl, cfg.timeoutMs, cfg.maxResponseBytes, new AbortController().signal, cfg.tlsVerify);
  try {
    const auth = new OlosAuthManager(http.request, credentials);
    await auth.getToken();
  } finally { await http.close(); }
}
