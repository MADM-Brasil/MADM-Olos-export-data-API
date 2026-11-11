import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import type { Shape } from '../corporate-sync/mapping.js';
import type { DeliveryConfig } from './config.js';
import { deliveryPayload } from './contract.js';

// Exclusion is by the exact local source identity, never by CallId, operator or logical identity.
// All callers validate the pinned membership before allowing delivery/release.
export const notQuarantined = `NOT EXISTS (SELECT 1 FROM olos_http.corporate_collision_quarantine q
  WHERE q.source_key=o.source_key AND q.source_id=o.source_id)`;

export async function quarantineMembers(local: PoolClient, cfg: DeliveryConfig, source: string, target: string, shape: Shape) {
  if (!(await local.query(`SELECT to_regclass('olos_http.corporate_collision_quarantine') IS NOT NULL
    AND to_regclass('olos_http.corporate_collision_quarantine_runs') IS NOT NULL AS present`)).rows[0].present) {
    throw new SyncError('CORPORATE_QUARANTINE_MIGRATION_REQUIRED');
  }
  if ((await local.query(`SELECT 1 FROM olos_http.corporate_collision_quarantine_runs h
    WHERE h.source_key=$1 AND (h.binding<>$2 OR h.target_table<>$3 OR h.member_count<>(
      SELECT count(*) FROM olos_http.corporate_collision_quarantine q WHERE q.request_id=h.request_id)) LIMIT 1`,
  [source, cfg.binding, target])).rowCount) throw new SyncError('CORPORATE_QUARANTINE_CHANGED');
  const members = (await local.query(`SELECT q.*,q.target_id::text AS target_id,
    o.target_id::text AS outbox_id,o.source_hash AS outbox_hash,o.payload_hash AS outbox_payload_hash,o.payload,o.state,
    r.target_id::text AS record_id,r.target_table,r.source_hash AS record_hash,
    h.source_key AS run_source,h.target_table AS run_target,h.binding,h.member_count,
    (SELECT count(*)::integer FROM olos_http.corporate_collision_quarantine m WHERE m.request_id=q.request_id) AS actual_count
    FROM olos_http.corporate_collision_quarantine q
    LEFT JOIN olos_http.corporate_outbox o USING(source_key,source_id)
    LEFT JOIN olos_http.records r USING(source_key,source_id)
    LEFT JOIN olos_http.corporate_collision_quarantine_runs h USING(request_id)
    WHERE q.source_key=$1 ORDER BY q.target_id`, [source])).rows;
  for (const member of members) {
    if (member.run_source !== source || member.run_target !== target || member.binding !== cfg.binding || member.member_count !== member.actual_count
      || member.state !== 'pending' || member.target_id !== member.outbox_id || member.target_id !== member.record_id
      || member.target_table !== target || member.source_hash !== member.outbox_hash || member.source_hash !== member.record_hash
      || member.payload_hash !== member.outbox_payload_hash || member.code !== 'INTERNAL_ID_COLLISION') throw new SyncError('CORPORATE_QUARANTINE_CHANGED');
    try { deliveryPayload(member, shape, cfg); }
    catch { throw new SyncError('CORPORATE_QUARANTINE_CHANGED'); }
  }
  return members.map(member => ({ source_id: member.source_id as string, target_id: member.target_id as string,
    source_hash: member.source_hash as string, payload_hash: member.payload_hash as string, request_id: member.request_id as string }));
}
