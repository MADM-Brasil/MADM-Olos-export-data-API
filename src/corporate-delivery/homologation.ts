import type { Config } from '../config.js';
import { Store } from '../store.js';
import { log, WorkerError } from '../errors.js';
import { homologationRequest } from './config.js';
import type { DeliveryHooks, DeliveryResult } from './delivery.js';

// Invoked only by the existing ExportDataV3 CLI, before constructing any OLOS transport or scheduler.
export async function corporateHomologation(cfg: Config, args: string[], env: NodeJS.ProcessEnv = process.env,
  hooks: DeliveryHooks = {}): Promise<DeliveryResult> {
  const request = homologationRequest(args, env);
  if (!cfg.corporateDelivery) throw new WorkerError('CORPORATE_MODE_REQUIRED');
  if (cfg.corporateDelivery.connection.writeEnabled) throw new WorkerError('CORPORATE_HOMOLOGATION_REQUIRES_CONTINUOUS_WRITE_DISABLED');
  const abort = new AbortController();
  const stop = () => abort.abort();
  const store = new Store(cfg, stop);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await store.open();
    const result = await store.delivery!.homologate(store.client!, request.limit, request.confirmation, abort.signal, hooks);
    log('corporate_homologation_completed', { ...result, limit: request.limit, paused: true });
    return result;
  } finally {
    try { await store.close(); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  }
}
