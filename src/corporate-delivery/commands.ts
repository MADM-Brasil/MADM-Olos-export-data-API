import pg from 'pg';
import { readoptionAction,readoptionArguments,executeReadoptionCommand } from './readoption-command.js';
import type { Config } from '../config.js';
import { log, WorkerError } from '../errors.js';
import { quote } from '../schema.js';
import { adoptAllocator, adoptionRequest } from './allocator.js';
import { legacyReversionRequest, revertAllocator } from './legacy-recovery.js';
import { CorporateDelivery } from './delivery.js';
import { logVerification, recoverCollision, recoveryRequest, verifyPending } from './recovery.js';

// Existing CLI control operations may run while the ingestion owner holds the source lock.
// They never capture OLOS, acquire its lock or admit an independent delivery loop.
export async function corporateControl(cfg: Config, command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!cfg.corporateDelivery) throw new WorkerError('CORPORATE_MODE_REQUIRED');
  const action=readoptionAction(command);
  const readoption=action?readoptionArguments(action,args,env,cfg.sourceKey):undefined;
  if (!action&&!['corporate-status','corporate-check','corporate-pause','corporate-resume','corporate-verify-pending','corporate-recover-collision','corporate-quarantine-collisions','corporate-adopt-id-allocator','corporate-prepare-id-allocator','corporate-revert-id-allocator'].includes(command)) throw new WorkerError('COMMAND_INVALID');
  const reversion = command === 'corporate-revert-id-allocator' ? legacyReversionRequest(args,env,cfg.sourceKey) : undefined;
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
      if(readoption){await executeReadoptionCommand(local,cfg.corporateDelivery,`${quote(cfg.schema)}.${quote(cfg.table)}`,readoption);return;}
      const delivery = new CorporateDelivery(cfg.corporateDelivery, cfg.sourceKey, `${quote(cfg.schema)}.${quote(cfg.table)}`, pool, () => false, () => {});
      const target = `${quote(cfg.schema)}.${quote(cfg.table)}`;
      if (reversion) {
        const result = await revertAllocator(local,cfg,delivery,reversion);
        log('corporate_legacy_reversion_recorded', { request_id:reversion.requestId,completed:result.completed,already_applied:result.alreadyApplied });
        if (!result.completed) throw new WorkerError('ALLOCATOR_REVERSION_INCOMPLETE');
      }
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
          pending: state.pending, unallocated: state.unallocated, allocator: state.allocator, allocator_request_id: state.allocator_request_id, reversion_request_id: state.reversion_request_id, quarantined: state.quarantined, confirmed: Number(state.confirmed_count ?? 0), legacy: Number(state.legacy_count ?? 0), error: state.last_code ?? null });
      }
      if (command === 'corporate-pause') { await delivery.pause(local); log('corporate_delivery_paused'); }
      if (command === 'corporate-resume') { await delivery.resume(local); log('corporate_delivery_resumed'); }
    } finally { local.release(true); }
  } finally { await pool.end(); }
}
