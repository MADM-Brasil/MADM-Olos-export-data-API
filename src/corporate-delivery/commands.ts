import pg from 'pg';
import type { Config } from '../config.js';
import { log, WorkerError } from '../errors.js';
import { quote } from '../schema.js';
import { adoptAllocator, adoptionRequest } from './allocator.js';
import { CorporateDelivery } from './delivery.js';
import { logVerification, recoverCollision, recoveryRequest, verifyPending } from './recovery.js';

// Existing CLI control operations may run while the ingestion owner holds the source lock.
// They never capture OLOS, acquire its lock or admit an independent delivery loop.
export async function corporateControl(cfg: Config, command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!cfg.corporateDelivery) throw new WorkerError('CORPORATE_MODE_REQUIRED');
  if (!['corporate-status','corporate-check','corporate-pause','corporate-resume','corporate-verify-pending','corporate-recover-collision','corporate-quarantine-collisions','corporate-adopt-id-allocator','corporate-prepare-id-allocator'].includes(command)) throw new WorkerError('COMMAND_INVALID');
  const adoption = ['corporate-adopt-id-allocator','corporate-prepare-id-allocator'].includes(command) ? adoptionRequest(args, env, cfg.sourceKey) : undefined;
  const quarantine = command === 'corporate-quarantine-collisions';
  const request = command === 'corporate-recover-collision' || quarantine ? recoveryRequest(args, env, cfg.sourceKey, quarantine) : undefined;
  if (command === 'corporate-verify-pending' && args.length) throw new WorkerError('COMMAND_ARGUMENTS_INVALID');
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  pool.on('error', () => {});
  try {
    const local = await pool.connect();
    local.on('error', () => {});
    try {
      const delivery = new CorporateDelivery(cfg.corporateDelivery, cfg.sourceKey, `${quote(cfg.schema)}.${quote(cfg.table)}`, pool, () => false, () => {});
      const target = `${quote(cfg.schema)}.${quote(cfg.table)}`;
      if (adoption) { const prepare = command === 'corporate-prepare-id-allocator'; await adoptAllocator(local, cfg.corporateDelivery, cfg.sourceKey, target, adoption, {}, prepare); log(prepare ? 'corporate_id_allocator_prepared' : 'corporate_id_allocator_adopted', { request_id: adoption.requestId }); }
      if (command === 'corporate-verify-pending') {
        const report = await verifyPending(local, cfg.corporateDelivery, cfg.sourceKey, target);
        logVerification(report);
        if (report.issues.length) throw new WorkerError('CORPORATE_PENDING_DIVERGES');
      }
      if (request) {
        const result = await recoverCollision(local, cfg.corporateDelivery, cfg.sourceKey, target, request, {}, quarantine);
        log(quarantine ? 'corporate_collision_quarantine_recorded' : 'corporate_collision_recovery_recorded', { request_id: request.requestId, already_applied: result.alreadyApplied });
      }
      if (command === 'corporate-check') { await delivery.check(local); log('corporate_schema_checked'); }
      if (command === 'corporate-status') {
        const state = await delivery.status(local);
        log('corporate_delivery_status', { ready: !!state.ready, paused: !!state.paused, blocked: !!state.blocked,
          pending: state.pending, unallocated: state.unallocated, allocator: state.allocator, quarantined: state.quarantined, confirmed: Number(state.confirmed_count ?? 0), legacy: Number(state.legacy_count ?? 0), error: state.last_code ?? null });
      }
      if (command === 'corporate-pause') { await delivery.pause(local); log('corporate_delivery_paused'); }
      if (command === 'corporate-resume') { await delivery.resume(local); log('corporate_delivery_resumed'); }
    } finally { local.release(true); }
  } finally { await pool.end(); }
}
