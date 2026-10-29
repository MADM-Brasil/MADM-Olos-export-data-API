import { WorkerError } from '../../src/errors.js';

export function localDatabaseUrl(value = process.env.LOCAL_DATABASE_URL): string {
  if (!value) throw new WorkerError('LOCAL_DATABASE_URL_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new WorkerError('LOCAL_DATABASE_URL_INVALID'); }
  if (!['postgresql:','postgres:'].includes(url.protocol) || !['postgres','localhost','127.0.0.1'].includes(url.hostname) ||
    !['/olos_http_local','/olos_http_local_test'].includes(url.pathname) || url.username !== 'olos_local' || url.search || url.hash) {
    throw new WorkerError('LOCAL_DATABASE_TARGET_REJECTED');
  }
  return value;
}
export function localConfig(env: NodeJS.ProcessEnv = process.env) {
  const batchSize=Number(env.BATCH_SIZE??500);
  if (!Number.isInteger(batchSize)||batchSize<1||batchSize>2000) throw new WorkerError('BATCH_SIZE_INVALID');
  const sourceKey=env.LOCAL_SOURCE_KEY||'olos-local-fixture';
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(sourceKey)) throw new WorkerError('LOCAL_SOURCE_KEY_INVALID');
  return { databaseUrl:localDatabaseUrl(env.LOCAL_DATABASE_URL),sourceKey,batchSize,
    sourceTimeZone:env.SOURCE_TIME_ZONE||undefined };
}
export type LocalConfig=ReturnType<typeof localConfig>;
