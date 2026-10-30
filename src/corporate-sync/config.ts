import { createHash } from 'node:crypto';
import { SyncError } from './errors.js';

export type Mode = 'check' | 'dry-run' | 'migrate' | 'once' | 'start';
export type TmaPolicy = 'reject' | 'truncate' | 'round-half-away';
export const identityContract = 'CALL_ID_TIME_PHONE_CAMPAIGN_V1';
export const writeAuthorization = 'AUTHORIZE_CORPORATE_SYNC';
export interface Config {
  mode: Mode;
  sourceUrl: string;
  destinationUrl: string;
  sourceTls: boolean;
  destinationTls: boolean;
  sourceCa: string | undefined;
  destinationCa: string | undefined;
  batchSize: number;
  intervalMs: number;
  maxRetries: number;
  backoffMs: number;
  timeoutMs: number;
  tmaPolicy: TmaPolicy;
  tmaConfirmed: boolean;
  identityConfirmed: boolean;
  timestampZone: string | undefined;
  timestampConfirmed: boolean;
  writeEnabled: boolean;
  binding: string;
}

function endpoint(value: string | undefined): { url: string; identity: string } {
  try {
    const url = new URL(value ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.search || url.hash) throw new Error();
    return { url: url.toString(), identity: JSON.stringify([url.hostname, url.port || '5432', url.pathname, url.username]) };
  } catch { throw new SyncError('DATABASE_URL_INVALID'); }
}
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[`CORPORATE_SYNC_${name}`] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new SyncError('CONFIG_INTEGER_INVALID');
  return value;
}
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') throw new SyncError('CONFIG_BOOLEAN_INVALID');
  return value === 'true';
}
export function assertWriteAuthorized(cfg: Config): void {
  if (!cfg.writeEnabled) throw new SyncError('WRITE_NOT_AUTHORIZED');
  if (!cfg.identityConfirmed) throw new SyncError('LOGICAL_IDENTITY_NOT_CONFIRMED');
  if (!cfg.tmaConfirmed) throw new SyncError('TMA_POLICY_NOT_CONFIRMED');
}

export function config(mode: string, env: NodeJS.ProcessEnv = process.env): Config {
  if (!['check', 'dry-run', 'migrate', 'once', 'start'].includes(mode)) throw new SyncError('COMMAND_INVALID');
  const source = endpoint(env.CORPORATE_SYNC_SOURCE_URL);
  const destination = mode === 'migrate' ? { url: '', identity: '' } : endpoint(env.CORPORATE_SYNC_DESTINATION_URL);
  if (source.identity === destination.identity) throw new SyncError('SOURCE_EQUALS_DESTINATION');
  const policy = env.CORPORATE_SYNC_TMA_POLICY ?? 'reject';
  if (!['reject', 'truncate', 'round-half-away'].includes(policy)) throw new SyncError('TMA_POLICY_INVALID');
  const zone = env.CORPORATE_SYNC_TIMESTAMP_ZONE || undefined;
  if (zone && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) throw new SyncError('TIMESTAMP_ZONE_INVALID');
  const cfg: Config = {
    mode: mode as Mode, sourceUrl: source.url, destinationUrl: destination.url,
    sourceTls: boolean(env.CORPORATE_SYNC_SOURCE_TLS, true),
    destinationTls: boolean(env.CORPORATE_SYNC_DESTINATION_TLS, true),
    sourceCa: env.CORPORATE_SYNC_SOURCE_CA_FILE || undefined,
    destinationCa: env.CORPORATE_SYNC_DESTINATION_CA_FILE || undefined,
    batchSize: integer(env, 'BATCH_SIZE', 250, 1, 2000),
    intervalMs: integer(env, 'INTERVAL_MS', 30000, 100, 3600000),
    maxRetries: integer(env, 'MAX_RETRIES', 3, 0, 10),
    backoffMs: integer(env, 'BACKOFF_MS', 500, 1, 60000),
    timeoutMs: integer(env, 'TIMEOUT_MS', 15000, 100, 300000),
    tmaPolicy: policy as TmaPolicy,
    tmaConfirmed: env.CORPORATE_SYNC_TMA_CONFIRMATION === `CONFIRM_TMA_${policy}`,
    identityConfirmed: env.CORPORATE_SYNC_IDENTITY_CONFIRMATION === identityContract,
    timestampZone: zone,
    timestampConfirmed: !!zone && env.CORPORATE_SYNC_TIMESTAMP_CONFIRMATION === `CONFIRM_TIMESTAMP_${zone}`,
    writeEnabled: boolean(env.CORPORATE_SYNC_ENABLED, false) && env.CORPORATE_SYNC_WRITE_CONFIRMATION === writeAuthorization,
    binding: createHash('sha256').update(JSON.stringify([source.identity, destination.identity, policy, zone ?? null, identityContract, 'mapping-v1'])).digest('hex'),
  };
  if (mode === 'once' || mode === 'start') assertWriteAuthorized(cfg);
  return cfg;
}
