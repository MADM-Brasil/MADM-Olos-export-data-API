import { type Config } from '../config.js';
import { Store } from '../store.js';
import { HttpTransport } from '../http.js';
import { OlosAuthManager } from '../auth.js';
import { OlosApi } from '../api.js';
import { StaticCache } from '../cache.js';
import { Worker, type CycleReport } from '../worker.js';
import { WorkerError, log } from '../errors.js';
import type { ScheduledConsumer } from '../scheduler.js';
import type { Credentials } from './credentials.js';

export async function createScheduledConsumer(cfg: Config,
  snapshot: () => Promise<{ revision: number; credentials: Credentials }>,
  completed?: (report: CycleReport) => Promise<void>): Promise<ScheduledConsumer> {
  if (!cfg.sourceIdConfirmed) throw new WorkerError('SOURCE_ID_UNIQUENESS_UNCONFIRMED');
  if (!cfg.ingestionBaseline || !cfg.sourceTimeZone) throw new WorkerError('POLLING_CONFIGURATION_REQUIRED');
  const abort = new AbortController();
  // Only unexpected database session loss aborts HTTP, never pause/stop/credentials edits.
  const store = new Store(cfg, () => abort.abort(),abort.signal);
  let http: HttpTransport | undefined, worker: Worker | undefined, revision = -1;
  try {
    await store.open();
    await store.captureReady();
    if(cfg.captureSpoolDirectory)await store.recoverPublishedCaptures();
    await assertRecoverable(store);
    const initial = await snapshot();
    if (!Object.values(initial.credentials).every(Boolean)) throw new WorkerError('OLOS_CONFIG_REQUIRED');
  } catch (error) { await store.close(); throw error; }
  const prepare = async () => {
    await store.ping();
    await assertRecoverable(store);
    const current = await snapshot();
    if (revision !== current.revision) {
      if (!Object.values(current.credentials).every(Boolean)) throw new WorkerError('OLOS_CONFIG_REQUIRED');
      await http?.close();
      http = new HttpTransport(current.credentials.baseUrl, cfg.timeoutMs, cfg.maxResponseBytes, abort.signal, cfg.tlsVerify);
      const auth = new OlosAuthManager(http.request, current.credentials);
      const api = new OlosApi(http.request, auth,undefined,cfg.captureSpoolDirectory
        ?(path,fields,token,id)=>http!.captureToSpool(path,fields,token,cfg.captureSpoolDirectory!,id,cfg.captureMaxBytes,cfg.captureTimeoutMs,abort.signal):undefined);
      worker = new Worker(store, api, new StaticCache(api, cfg.cacheTtlMs));
      revision = current.revision;
    }
  };
  try {
    await prepare();
    if ((await store.capturePending()).length) {
      await worker!.initialize();
      log('local_recovery_completed', await store.drain(worker!.cache.value));
      if ((await store.capturePending()).length) throw new WorkerError('RECONCILIATION_REQUIRED');
    }
  } catch (error) {
    const disconnected = abort.signal.aborted;
    abort.abort();
    try { await http?.close(); } finally { await store.close(); }
    throw disconnected ? new WorkerError('DATABASE_SESSION_LOST') : error;
  }
  return {
    async cycle() {
      try {
        await prepare();
        const report = await worker!.cycle();
        // A failed audit must never replay this read; durable state gates later admission.
        if (completed) await completed(report);
      } catch (error) {
        if (abort.signal.aborted) throw new WorkerError('DATABASE_SESSION_LOST');
        throw error;
      }
    },
    suspendDelivery() { store.delivery?.suspend(); },
    resumeDelivery() { store.delivery?.allow(); },
    async settleDelivery() { await store.delivery?.settle(); },
    async close() { abort.abort(); try { await http?.close(); } finally { await store.close(); } },
  };
}

// Durable responses use the existing drain path; uncertainty is never resolved here.
async function assertRecoverable(store: Store): Promise<void> {
  const pending = await store.capturePending();
  if (pending.some(read => read.state === 'reading')) {
    throw new WorkerError('RECONCILIATION_REQUIRED');
  }
}
