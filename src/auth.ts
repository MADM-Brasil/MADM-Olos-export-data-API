import { HttpError, WorkerError } from './errors.js';
import type { Transport } from './http.js';

export class OlosAuthManager {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private expiresAt = 0;
  private renewAt = 0;
  private inflight: Promise<string> | undefined;
  constructor(private readonly request: Transport,
    private readonly credentials: { username: string; password: string; clientId: string; clientSecret: string },
    private readonly now = Date.now) {}

  async getToken(): Promise<string> {
    if (this.accessToken && this.now() < this.renewAt) return this.accessToken;
    if (!this.inflight) this.inflight = this.authenticate().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  invalidate(rejectedToken: string): void {
    // A delayed 401 must not invalidate a more recent token.
    if (this.accessToken === rejectedToken) { this.accessToken = undefined; this.expiresAt = 0; this.renewAt = 0; }
  }
  private async authenticate(): Promise<string> {
    const common = { client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret };
    let raw: string;
    let started = this.now();
    if (this.refreshToken) {
      try {
        raw = await this.request('/api/auth', { ...common, grant_type: 'refresh_token', refresh_token: this.refreshToken });
      } catch (error) {
        if (!(error instanceof HttpError) || ![400, 401].includes(error.status)) throw error;
        this.refreshToken = undefined;
        started = this.now();
        raw = await this.passwordGrant(common);
      }
    } else raw = await this.passwordGrant(common);
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw) as Record<string, unknown>; } catch { throw new WorkerError('AUTH_RESPONSE_INVALID'); }
    if (!data || typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      !['number', 'string'].includes(typeof data.expires_in) || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0 ||
      (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token))) {
      throw new WorkerError('AUTH_RESPONSE_INVALID');
    }
    const ttl = Number(data.expires_in) * 1000;
    if (!Number.isFinite(ttl)) throw new WorkerError('AUTH_RESPONSE_INVALID');
    this.expiresAt = started + ttl;
    if (this.now() >= this.expiresAt) throw new WorkerError('AUTH_TOKEN_ALREADY_EXPIRED', true);
    this.renewAt = this.expiresAt - Math.min(60000, ttl * 0.1);
    this.accessToken = data.access_token;
    if (typeof data.refresh_token === 'string') this.refreshToken = data.refresh_token;
    return this.accessToken;
  }
  private passwordGrant(common: Record<string, string>) {
    return this.request('/api/auth', { ...common, grant_type: 'password', username: this.credentials.username, password: this.credentials.password });
  }
}
