import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import type { MappedRecord } from '../mapping.js';
import { rollback } from '../corporate-sync/database.js';
import { SyncError } from '../corporate-sync/errors.js';
import { allocatorState } from './allocator.js';
import { CorporateDelivery } from './delivery.js';

export interface LegacyReversionRequest { source: string; adoptionId: string; requestId: string; evidence: string; maxBatches: number }
interface Admission { source_id: string; source_hash: string; request_id: string; mapped_hash: string; mapped: MappedRecord }
export interface ReversionHooks {
  afterLocks?: () => Promise<void>;
  beforeBatchCommit?: () => Promise<void>;
  afterBatchCommit?: () => Promise<void>;
  beforeCompleteCommit?: () => Promise<void>;
}
export function legacyReversionRequest(args: string[], env: NodeJS.ProcessEnv, source: string): LegacyReversionRequest {
  if (env.OLOS_CORPORATE_LEGACY_REVERSION_CONFIRMATION !== 'AUTHORIZE_CORPORATE_LEGACY_REVERSION') throw new SyncError('ALLOCATOR_REVERSION_NOT_AUTHORIZED');
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (![8,10].includes(args.length) || args[0] !== '--confirm-source' || args[2] !== '--adoption-request'
    || args[4] !== '--request-id' || args[6] !== '--evidence' || !uuid.test(args[3]!) || !uuid.test(args[5]!)
    || !/^[A-Za-z0-9._:-]{1,100}$/.test(args[7]!) || args.length === 10 && (args[8] !== '--max-batches' || !/^[1-9][0-9]{0,4}$/.test(args[9]!) || Number(args[9])>10000)) throw new SyncError('ALLOCATOR_REVERSION_ARGUMENTS_INVALID');
  if (args[1] !== source) throw new SyncError('ALLOCATOR_REVERSION_SOURCE_MISMATCH');
  return { source, adoptionId: args[3]!, requestId: args[5]!, evidence: args[7]!, maxBatches: args.length === 10 ? Number(args[9]) : 1000 };
}
function manifestDigest(entries: Omit<Admission, 'mapped'>[]): string {
  return createHash('sha256').update(JSON.stringify(entries.map(e => [e.source_id,e.source_hash,e.request_id,e.mapped_hash]))).digest('hex');
}
async function locks(local: PoolClient) {
  // Same admission -> materialization -> control order as adoption/delivery; no OLOS ownership lock.
  await local.query('SELECT pg_advisory_xact_lock(17320914,5)');
  await local.query('SELECT pg_advisory_xact_lock(17320914,6)');
  if (!(await local.query('SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_HOMOLOGATION_ACTIVE');
}
export async function revertAllocator(local: PoolClient, cfg: Config, delivery: CorporateDelivery,
  request: LegacyReversionRequest, hooks: ReversionHooks = {}): Promise<{ completed: boolean; alreadyApplied: boolean }> {
  if (request.source !== cfg.sourceKey) throw new SyncError('ALLOCATOR_REVERSION_SOURCE_MISMATCH');
  const dc = cfg.corporateDelivery!;
  const target = delivery.target;
  if (!(await local.query('SELECT pg_try_advisory_lock(17320914,7) AS ok')).rows[0].ok) throw new SyncError('ALLOCATOR_REVERSION_BUSY');
  try {
    if (!(await local.query("SELECT to_regclass('olos_http.corporate_id_reversions') IS NOT NULL AS present")).rows[0].present) throw new SyncError('ALLOCATOR_REVERSION_MIGRATION_REQUIRED');
    await local.query('BEGIN'); await locks(local);
    const previous = (await local.query('SELECT * FROM olos_http.corporate_id_reversions WHERE source_key=$1 OR request_id=$2 FOR UPDATE', [cfg.sourceKey,request.requestId])).rows;
    if (previous.length>1) throw new SyncError('ALLOCATOR_REVERSION_REQUEST_REUSED');
    const run = previous[0];
    if (run && (run.request_id !== request.requestId || run.source_key !== cfg.sourceKey || run.target_table !== target
      || run.binding !== dc.binding || run.adoption_request_id !== request.adoptionId || run.evidence_ref !== request.evidence)) throw new SyncError('ALLOCATOR_REVERSION_REQUEST_REUSED');
    if (run && manifestDigest(run.initial_manifest) !== run.initial_digest) throw new SyncError('ALLOCATOR_REVERSION_EVIDENCE_CHANGED');
    if (run?.state === 'completed') {
      const allocator = await allocatorState(local,dc,cfg.sourceKey,target);
      if (allocator?.state !== 'legacy' || allocator.reversion_request_id !== request.requestId) throw new SyncError('ALLOCATOR_REVERSION_EVIDENCE_CHANGED');
      await local.query('ROLLBACK'); return { completed: true, alreadyApplied: true };
    }
    throw new SyncError('ALLOCATOR_LEGACY_GENERATION_FORBIDDEN');
  } catch (error) {
    await rollback(local);
    throw error;
  } finally { await local.query('SELECT pg_advisory_unlock(17320914,7)').catch(()=>{}); }
}
