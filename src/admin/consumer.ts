import { type Config } from '../config.js';
import { Store } from '../store.js';
import { HttpTransport } from '../http.js';
import { OlosAuthManager } from '../auth.js';
import { OlosApi } from '../api.js';
import { StaticCache } from '../cache.js';
import { Worker, type CycleReport } from '../worker.js';
import { WorkerError } from '../errors.js';
import type { ScheduledConsumer } from '../scheduler.js';
import type { Credentials } from './credentials.js';

export async function createScheduledConsumer(cfg: Config,
  snapshot: () => Promise<{ revision: number; credentials: Credentials }>,
  completed?: (report: CycleReport) => Promise<void>): Promise<ScheduledConsumer> {
  if (!cfg.sourceIdConfirmed) throw new WorkerError('SOURCE_ID_UNIQUENESS_UNCONFIRMED');
  if (!cfg.ingestionBaseline || !cfg.sourceTimeZone) throw new WorkerError('POLLING_CONFIGURATION_REQUIRED');
  const abort = new AbortController();
  // Only unexpected database session loss aborts HTTP, never pause/stop/credentials edits.
  const store = new Store(cfg, () => abort.abort());
  let http: HttpTransport | undefined, worker: Worker | undefined, revision = -1;
  try {
    await store.open();
    await store.captureReady();
    if ((await store.unresolved()).length) throw new WorkerError('RECOVERY_REQUIRED');
    const initial = await snapshot();
    if (!Object.values(initial.credentials).every(Boolean)) throw new WorkerError('OLOS_CONFIG_REQUIRED');
  } catch (error) { await store.close(); throw error; }
  return {
    async cycle() {
      await store.ping();
      // Do not let the panel implicitly normalize a pending capture during start/resume.
      if ((await store.unresolved()).length) throw new WorkerError('RECOVERY_REQUIRED');
      const current = await snapshot();
      if (revision !== current.revision) {
        if (!Object.values(current.credentials).every(Boolean)) throw new WorkerError('OLOS_CONFIG_REQUIRED');
        await http?.close();
        http = new HttpTransport(current.credentials.baseUrl, cfg.timeoutMs, cfg.maxResponseBytes, abort.signal, cfg.tlsVerify);
        const auth = new OlosAuthManager(http.request, current.credentials);
        const api = new OlosApi(http.request, auth);
        worker = new Worker(store, api, new StaticCache(api, cfg.cacheTtlMs));
        revision = current.revision;
      }
      const report = await worker!.cycle();
      // Telemetry failure must not replay a committed remote read; caller stops on this local failure.
      if (completed) await completed(report);
    },
    suspendDelivery() { store.delivery?.suspend(); },
    resumeDelivery() { store.delivery?.allow(); },
    async settleDelivery() { await store.delivery?.settle(); },
    async close() { await http?.close(); await store.close(); },
  };
}
