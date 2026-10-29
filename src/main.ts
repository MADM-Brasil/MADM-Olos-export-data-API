import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';
import { HttpTransport, sleep } from './http.js';
import { OlosAuthManager } from './auth.js';
import { OlosApi, readFields, type ReadSpec } from './api.js';
import { StaticCache } from './cache.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { runManaged } from './admin/main.js';
import { WorkerError, errorCode, log } from './errors.js';
import { inspectSchema } from './schema.js';

async function main() {
  const cfg = config();
  const [command = 'check', ...args] = process.argv.slice(2);
  const allowed = ['inspect-schema','check','start','admin','once','capture-once','capture-reread','previous','reread','log-read','recover-local','resolve','status','reconcile-names'];
  if (!allowed.includes(command)) throw new WorkerError('COMMAND_INVALID');
  if (command === 'start' || command === 'admin') { await runManaged(cfg, command === 'admin'); return; }
  if (command === 'inspect-schema') {
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const info = await inspectSchema(client, cfg.schema, cfg.table);
        // Metadata can contain business-specific defaults; write only to a private, explicitly chosen file.
        if (!args[0]) throw new WorkerError('PRIVATE_OUTPUT_PATH_REQUIRED');
        await writeFile(args[0], JSON.stringify(info, null, 2), { mode: 0o600, flag: 'wx' });
        await client.query('ROLLBACK');
        log('schema_report_written');
      } finally { client.release(true); }
    } finally { await pool.end(); }
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let databaseDisconnected = false;
  const store = new Store(cfg, () => { databaseDisconnected = true; stop(); });
  let http: HttpTransport | undefined;
  try {
    await store.open();
    if (command === 'check') { log('database_preflight_passed'); return; }
    if (command === 'status') {
      for (const row of await store.unresolved()) log('pending_read', { read_id: row.id, state: row.state, processed: row.processed_count });
      return;
    }
    if (command === 'resolve') {
      if (!args[0] || !args[1]) throw new WorkerError('RESOLVE_REQUIRES_ID_AND_EVIDENCE');
      await store.resolve(args[0], args[1]); log('read_manually_resolved', { read_id: args[0] }); return;
    }
    if (command === 'recover-local') {
      if (!cfg.ingestionBaseline || !cfg.sourceTimeZone) {
        throw new WorkerError('RECOVERY_CONFIGURATION_REQUIRED');
      }
    }
    if (![cfg.baseUrl,cfg.username,cfg.password,cfg.clientId,cfg.clientSecret].every(Boolean)) throw new WorkerError('OLOS_CONFIG_REQUIRED');
    http = new HttpTransport(cfg.baseUrl, cfg.timeoutMs, cfg.maxResponseBytes, abort.signal, cfg.tlsVerify);
    const auth = new OlosAuthManager(http.request, cfg);
    const api = new OlosApi(http.request, auth, ms => sleep(ms, abort.signal));
    const cache = new StaticCache(api, cfg.cacheTtlMs);
    const worker = new Worker(store, api, cache);

    if (command === 'recover-local') {
      await cache.refresh();

      log('local_recovery_started', {
        baseline: cfg.ingestionBaseline!,
        source_timezone: cfg.sourceTimeZone!
      });

      const counts = await store.drain(cache.value);
      log('local_recovery_completed', counts);
      return;
    }
    if (command === 'log-read') {
      if (!args[0] || !/^\d{4}-\d{2}-\d{2}$/.test(args[0]) || !args[1]) throw new WorkerError('LOG_READ_REQUIRES_DATE_AND_PRIVATE_OUTPUT');
      const body = await api.call('/api/export-data/log-read-data', { TableName: 'AttemptsRawData', DateExport: args[0] });
      await writeFile(args[1], body, { mode: 0o600, flag: 'wx' }); log('log_read_report_written'); return;
    }
    if (command === 'reconcile-names') {
      await cache.refresh(); log('reference_names_reconciled', { updated: await store.reconcileNames(cache.value) }); return;
    }
    if (command === 'capture-reread') {
      const [parentId, date, start, end] = args;
      if (!parentId || !date || !start || !end || args.length !== 4) {
        throw new WorkerError('RECOVERY_PARAMETERS_REQUIRED');
      }
      await worker.captureReread(parentId, date, start, end);
    }
    else if (command === 'capture-once') await worker.captureOnce();
    else {
      let spec: ReadSpec;
      if (command === 'reread') {
        if (!args[0] || !args[1] || !args[2]) throw new WorkerError('RECOVERY_PARAMETERS_REQUIRED');
        spec = { kind: 'reread', date: args[0], start: args[1], end: args[2] }; readFields(spec);
      } else spec = { kind: command === 'previous' ? 'previous' : 'current' };
      await worker.cycle(spec, command === 'reread');
    }
    if (databaseDisconnected) throw new WorkerError('DATABASE_SESSION_LOST');
  } finally {
    abort.abort();
    await http?.close(); await store.close();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
main().catch(error => {
  if (error instanceof Error && error.name === 'AbortError') { log('worker_stopped'); return; }
  log('worker_stopped', { error: errorCode(error) }); process.exitCode = 1;
});
