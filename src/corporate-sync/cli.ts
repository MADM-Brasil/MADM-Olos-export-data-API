import { config } from './config.js';
import { connect, lock, migrate } from './database.js';
import { log, safeCode } from './errors.js';
import { run } from './worker.js';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  const cfg = config(process.argv[2] ?? 'check');
  if (cfg.mode === 'migrate') {
    const local = await connect(cfg, 'source');
    try { await lock(local); await migrate(local); log('migrated'); }
    finally { await local.end().catch(() => {}); }
  } else await run(cfg, controller.signal);
} catch (error) {
  const code = safeCode(error);
  if (controller.signal.aborted && code === 'STOP_REQUESTED') log('stopped');
  else { log('failed', { code }); process.exitCode = 1; }
}
