import { resolve } from 'node:path';
import { once } from 'node:events';
import { type Config } from '../config.js';
import { WorkerError, log, observeLogs } from '../errors.js';
import { DynamicScheduler } from '../scheduler.js';
import { AdminRepository } from './repository.js';
import { CredentialService, encryptionKey, configuredOlosOrigins } from './credentials.js';
import { createScheduledConsumer } from './consumer.js';
import { AdminAuth, authorizedUsers } from './security.js';
import { adminServer } from './server.js';
import { OperationalEvents } from './events.js';

export async function runManaged(cfg: Config, web: boolean, env = process.env) {
  const repo = new AdminRepository(cfg.databaseUrl, cfg.sourceKey, { schema: cfg.schema, table: cfg.table });
  let server: ReturnType<typeof adminServer> | undefined;
  let scheduler: DynamicScheduler | undefined;
  const events = new OperationalEvents();
  const unsubscribe = web ? observeLogs(entry => events.record(entry)) : () => {};
  const stop = () => scheduler?.shutdown();
  try {
    // Validate web security configuration before acquiring resources or starting any consumer.
    const key = env.ADMIN_ENCRYPTION_KEY ? encryptionKey(env.ADMIN_ENCRYPTION_KEY) : undefined;
    const users = web ? authorizedUsers(env.ADMIN_OLOS_USERS_JSON ?? '') : undefined;
    if (web && (!key || !env.ADMIN_ORIGIN)) throw new WorkerError('ADMIN_CONFIGURATION_REQUIRED');
    // The protected operational URL is the default trust boundary; edits cannot add arbitrary origins.
    const allowedOrigins = key ? configuredOlosOrigins(cfg.baseUrl, env.ADMIN_OLOS_ALLOWED_ORIGINS) : [];
    await repo.open(cfg.pollMs, web ? 'STOPPED' : 'RUNNING');
    const service = key ? new CredentialService(repo, cfg, key, allowedOrigins) : undefined;
    scheduler = new DynamicScheduler(repo, () => createScheduledConsumer(cfg, async () => {
      if (service) return service.snapshot();
      if (await repo.credentials()) throw new WorkerError('ADMIN_ENCRYPTION_KEY_REQUIRED');
      return { revision: 0, credentials: { baseUrl: cfg.baseUrl, username: cfg.username, password: cfg.password, clientId: cfg.clientId, clientSecret: cfg.clientSecret } };
    }, report => repo.cycleCompleted(report)), cfg.maxFailures, web);
    if (web) {
      server = adminServer({ origin: env.ADMIN_ORIGIN!, publicDir: resolve('admin/public'), auth: new AdminAuth(users!,
        (username, password) => service!.authenticateUser(username, password), (actor, result) => repo.authEvent(actor, result)),
        credentials: service!, scheduler, repository: repo, events: () => events.snapshot() });
      const port = Number(env.ADMIN_PORT ?? 8080);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WorkerError('ADMIN_PORT_INVALID');
      server.listen(port, env.ADMIN_BIND ?? '127.0.0.1'); await once(server, 'listening');
      log('admin_listening', { port });
    }
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await scheduler.run();
  } finally {
    unsubscribe();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (server) { server.closeIdleConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await repo.close();
  }
}
