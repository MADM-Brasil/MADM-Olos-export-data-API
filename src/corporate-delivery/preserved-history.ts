import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';

// Incident-scoped authorization, never a general pending-read bypass.
export const preservedHistoryRead = '132eb226-f4e4-419d-b79f-21dd0e6e64c1';
export const historyHomologation = [
  { source_id: '47561569', agent_id: '1658', target_id: '725262' },
  { source_id: '47559439', agent_id: '1467', target_id: '724965' },
  { source_id: '47558756', agent_id: '1565', target_id: '724892' },
] as const;

export function validatePreservedHistory(readId: string | undefined, ids?: readonly string[]): void {
  if (readId === undefined) return;
  if (readId !== preservedHistoryRead || ids &&
    (ids.length !== historyHomologation.length || historyHomologation.some(row => !ids.includes(row.source_id)))) {
    throw new SyncError('HISTORY_HOMOLOGATION_SCOPE_INVALID');
  }
}

export function parsePreservedHistory(args: string[]): { args: string[]; historyReadId?: string } {
  const index = args.indexOf('--preserve-history-read');
  if (index === -1) return { args };
  if (index !== args.length - 2) throw new SyncError('HISTORY_HOMOLOGATION_SCOPE_INVALID');
  const historyReadId = args[index + 1]!;
  validatePreservedHistory(historyReadId);
  return { args: args.slice(0, index), historyReadId };
}

// Source/Sync locks are owned by Store. The caller also holds delivery/history
// session locks. This Admin session lock survives the selective intent COMMIT.
export async function assertPreservedHistory(local: PoolClient, source: string, readId: string, requireOperator = false): Promise<void> {
  validatePreservedHistory(readId);
  if (!(await local.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',
    [`olos-admin:${source}`])).rows[0].ok) throw new SyncError('HISTORY_ADMIN_ACTIVE');
  const settings = (await local.query(`SELECT enabled,desired_state,runtime_state FROM olos_http.worker_settings
    WHERE source_key=$1 FOR SHARE NOWAIT`, [source])).rows[0];
  if (!settings || settings.enabled || settings.desired_state !== 'STOPPED' || settings.runtime_state !== 'STOPPED') {
    throw new SyncError('HISTORY_SCHEDULER_NOT_STOPPED');
  }
  const pending = (await local.query(`SELECT * FROM olos_http.reads WHERE source_key=$1
    AND state IN ('reading','received') FOR SHARE NOWAIT`, [source])).rows;
  const read = pending[0];
  if (pending.length !== 1 || read.id !== readId || read.spec.kind !== 'history' || read.state !== 'reading' ||
    read.error_code !== 'RESPONSE_TOO_LARGE' || read.response_body !== null || read.processed_count !== 0 ||
    read.finished_at !== null || read.resolution !== null) throw new SyncError('HISTORY_HOMOLOGATION_READ_CHANGED');
  const control = (await local.query('SELECT * FROM olos_http.corporate_control WHERE singleton')).rows[0];
  if (!control?.ready || !control.paused || control.source_key !== source || control.target_table !== read.target_table) {
    throw new SyncError('HISTORY_CORPORATE_STATE_INVALID');
  }
  // SQL compares timestamps at full PostgreSQL precision. No record from the
  // failed read, or from a later capture, may be admitted by this exception.
  const entries = (await local.query(`SELECT r.source_id,r.agent_id,r.target_id::text,o.payload,
    r.target_table=$3 AND r.target_id=o.target_id AND r.source_hash=o.source_hash
      AND r.created_at<h.started_at AND o.created_at<h.started_at AND o.origin='capture' AS valid
    FROM olos_http.records r JOIN olos_http.corporate_outbox o USING(source_key,source_id)
    JOIN olos_http.reads h ON h.id=$2
    WHERE r.source_key=$1 AND r.source_id=ANY($4::text[]) FOR SHARE OF r,o NOWAIT`,
  [source, readId, read.target_table, historyHomologation.map(row => row.source_id)])).rows;
  if (entries.length !== 3 || historyHomologation.some(expected => !entries.some(entry =>
    entry.valid && entry.source_id === expected.source_id && entry.agent_id === expected.agent_id &&
    entry.target_id === expected.target_id && (!requireOperator || entry.payload.id_operador_olos === expected.agent_id)))) {
    throw new SyncError('HISTORY_HOMOLOGATION_RECORD_CHANGED');
  }
  if (requireOperator && !(await local.query(`SELECT 1 FROM olos_http.corporate_operator_contracts
    WHERE source_key=$1 AND binding=$2 AND target_table=$3 AND schema_hash=$4`,
  [source, control.binding, control.target_table, control.schema_hash])).rowCount) {
    throw new SyncError('OPERATOR_CONTRACT_ADOPTION_REQUIRED');
  }
}
