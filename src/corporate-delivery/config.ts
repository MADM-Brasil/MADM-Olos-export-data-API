import { createHash } from 'node:crypto';
import { WorkerError } from '../errors.js';
import type { Config as SyncConfig } from '../corporate-sync/config.js';

export interface DeliveryConfig {
  connection: SyncConfig;
  binding: string;
  legacyBinding: string;
  expectedLegacyCount: number;
  reconcileAuthorized: boolean;
}

export function deliveryConfig(env: NodeJS.ProcessEnv): DeliveryConfig | undefined {
  const mode = env.ATTEMPTS_PERSISTENCE_MODE ?? 'local';
  if (mode === 'local') return undefined;
  if (mode !== 'corporate') throw new WorkerError('PERSISTENCE_MODE_INVALID');
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[`OLOS_CORPORATE_${name}`] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new WorkerError('CORPORATE_CONFIG_INVALID');
    return value;
  };
  const endpoint = (raw: string | undefined, corporate: boolean) => {
    try {
      const url = new URL(raw ?? '');
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.hostname || url.hash || url.pathname.length < 2 || corporate && (url.search || url.pathname !== '/madm')) throw new Error();
      return { url: url.toString(), key: JSON.stringify([url.hostname, url.port || '5432', url.pathname, url.username, corporate ? '' : url.search]) };
    } catch { throw new WorkerError('CORPORATE_DATABASE_URL_INVALID'); }
  };
  const source = endpoint(env.DATABASE_URL, false);
  const destination = endpoint(env.OLOS_CORPORATE_DATABASE_URL, true);
  const enabled = env.OLOS_CORPORATE_WRITE_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new WorkerError('CORPORATE_CONFIG_INVALID');
  if (enabled === 'true' && env.OLOS_CORPORATE_WRITE_CONFIRMATION !== 'AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY') throw new WorkerError('CORPORATE_WRITE_NOT_AUTHORIZED');
  if (env.OLOS_CORPORATE_TLS_VERIFY && env.OLOS_CORPORATE_TLS_VERIFY !== 'true') throw new WorkerError('CORPORATE_TLS_REQUIRED');
  const zone = env.OLOS_CORPORATE_TIMESTAMP_ZONE || undefined;
  if (zone && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) throw new WorkerError('CORPORATE_TIMEZONE_INVALID');
  const binding = createHash('sha256').update(JSON.stringify([source.key, destination.key, env.OLOS_SOURCE_KEY,
    'round-half-away', zone ?? null, 'exportdata-direct-v1'])).digest('hex');
  const legacyBinding = env.OLOS_CORPORATE_LEGACY_BINDING ?? '';
  if (legacyBinding && !/^[0-9a-f]{64}$/.test(legacyBinding)) throw new WorkerError('CORPORATE_LEGACY_BINDING_INVALID');
  return {
    binding, legacyBinding,
    expectedLegacyCount: number('LEGACY_EXPECTED_COUNT', 12605, 0, 2147483647),
    reconcileAuthorized: env.OLOS_CORPORATE_RECONCILE_CONFIRMATION === 'AUTHORIZE_CORPORATE_STATE_RECONCILIATION',
    connection: {
      mode: 'once', sourceUrl: source.url, destinationUrl: destination.url,
      sourceTls: true, destinationTls: true, sourceCa: undefined,
      destinationCa: env.OLOS_CORPORATE_CA_FILE || undefined,
      batchSize: number('BATCH_SIZE', 250, 1, 2000),
      timeoutMs: number('TIMEOUT_MS', 15000, 100, 300000),
      maxRetries: number('MAX_FAILURES', 5, 1, 100),
      backoffMs: number('BACKOFF_MS', 1000, 1, 60000),
      intervalMs: 0, batchDelayMs: 0,
      tmaPolicy: 'round-half-away', tmaConfirmed: true, identityConfirmed: true,
      timestampZone: zone,
      timestampConfirmed: !!zone && env.OLOS_CORPORATE_TIMESTAMP_CONFIRMATION === `CONFIRM_TIMESTAMP_${zone}`,
      writeEnabled: enabled === 'true', binding,
    },
  };
}
