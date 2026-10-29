import { WorkerError } from './errors.js';
export function olosTlsVerify(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OLOS_TLS_VERIFY ?? 'true';
  if (value !== 'true' && value !== 'false') throw new WorkerError('CONFIG_INVALID_OLOS_TLS_VERIFY');
  return value === 'true';
}
export function config(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new WorkerError(`CONFIG_REQUIRED_${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new WorkerError(`CONFIG_INVALID_${name}`);
    return value;
  };
  const identifier = (name: string, fallback: string) => {
    const value = env[name] || fallback;
    if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new WorkerError(`CONFIG_INVALID_${name}`);
    return value;
  };
  return {
    databaseUrl: required('DATABASE_URL'),
    baseUrl: env.OLOS_BASE_URL ?? '', username: env.OLOS_USERNAME ?? '', password: env.OLOS_PASSWORD ?? '',
    clientId: env.OLOS_CLIENT_ID ?? '', clientSecret: env.OLOS_CLIENT_SECRET ?? '',
    tlsVerify: olosTlsVerify(env),
    sourceKey: required('OLOS_SOURCE_KEY'),
    schema: identifier('DESTINATION_SCHEMA', 'raw'), table: identifier('DESTINATION_TABLE', 'olos_calls'),
    sourceTimeZone: env.SOURCE_TIME_ZONE || undefined,
    ingestionBaseline: (() => {
      const value = env.INGESTION_BASELINE;
      if (!value) return undefined;

      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
          !Number.isFinite(Date.parse(value))) {
        throw new WorkerError('INGESTION_BASELINE_INVALID');
      }

      return value;
    })(),
    sourceIdConfirmed: env.SOURCE_ID_UNIQUENESS_CONFIRMED === 'true',
    pollMs: integer('POLL_INTERVAL_MS', 2000, 100, 3_600_000),
    timeoutMs: integer('HTTP_TIMEOUT_MS', 10000, 100, 300000),
    poolMax: integer('DB_POOL_MAX', 5, 1, 20),
    batchSize: integer('BATCH_SIZE', 500, 1, 2000),
    cacheTtlMs: integer('STATIC_CACHE_TTL_MS', 3600000, 1000, 86_400_000),
    maxResponseBytes: integer('MAX_RESPONSE_BYTES', 32 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    maxFailures: integer('MAX_RETRY_ATTEMPTS', 5, 1, 20),
  };
}
export type Config = ReturnType<typeof config>;
