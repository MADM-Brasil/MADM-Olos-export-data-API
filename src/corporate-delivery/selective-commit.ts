import { certifiedOriginal } from '../identity/gates.js';
import { allowsLegacyHistoryEntry, assertPreservedHistory, validatePreservedHistory } from './preserved-history.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient, Client } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import { type Shape } from '../corporate-sync/mapping.js';
import { deliveryDigest as digest, mapDeliveryRow as mapRow } from './payload.js';
import { uniqueIdentities } from './contract.js';
import type { DeliveryConfig } from './config.js';

export const selectiveCommitBlock = 'SELECTIVE_COMMIT_RECONCILIATION_REQUIRED';
export interface SelectedEntry {
  source_id: string; target_id: string; payload: Record<string, unknown>; payload_hash: string;
  state: 'pending' | 'confirmed'; remote_raw_id: string | null; source_hash: string;
  origin: string; agent_id: string; record_hash: string; record_target_id: string; target_table: string;
}
export async function lockSelection(local: PoolClient, source: string, historyReadId?: string, contract?: 'v1' | 'v2'): Promise<void> {
  // Session locks survive the local COMMIT intent; release(true) destroys this session.
  if (!(await local.query('SELECT pg_try_advisory_lock(17320914,4) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_DELIVERY_BUSY');
  if (!(await local.query('SELECT pg_try_advisory_lock_shared(hashtextextended($1,0)) AS ok',
    [`olos-http:history:${source}`])).rows[0].ok) throw new SyncError('HISTORY_CAPTURE_ACTIVE');
  if (historyReadId !== undefined) await assertPreservedHistory(local, source, historyReadId, contract);
  else if ((await local.query("SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND spec->>'kind'='history' AND state IN ('reading','received') LIMIT 1",
    [source])).rowCount) throw new SyncError('HISTORY_RECOVERY_REQUIRED');
  if (!(await local.query("SELECT to_regclass('olos_http.corporate_selective_commits') IS NOT NULL AS ok")).rows[0].ok) {
    throw new SyncError('SELECTIVE_COMMIT_MIGRATION_REQUIRED');
  }
}
export async function lockRemoteSelection(remote: Client): Promise<void> {
  // A reconciliation must not infer absence while the original transaction can still commit.
  if (!(await remote.query('SELECT pg_try_advisory_xact_lock(17320914,5) AS ok')).rows[0].ok) {
    throw new SyncError('SELECTIVE_REMOTE_TRANSACTION_ACTIVE');
  }
}
export async function selectEntries(local: PoolClient, source: string, target: string, ids: string[],
  historyReadId?: string, contract?: 'v1' | 'v2'): Promise<SelectedEntry[]> {
  validatePreservedHistory(historyReadId, ids);
  const entries = (await local.query<SelectedEntry>(`SELECT o.source_id,o.target_id::text,o.payload,o.payload_hash,o.state,
      o.remote_raw_id::text,o.source_hash,o.origin,r.source_hash AS record_hash,
      r.target_id::text AS record_target_id,r.target_table,r.agent_id
    FROM olos_http.corporate_outbox o JOIN olos_http.records r USING(source_key,source_id)
    WHERE o.source_key=$1 AND o.source_id=ANY($2::text[]) ORDER BY o.target_id FOR UPDATE OF o,r NOWAIT`, [source, ids])).rows;
  const migrated=new Set<string>();
  if(historyReadId!==undefined&&contract==='v1')for(const entry of entries)if(await certifiedOriginal(local,source,entry))migrated.add(entry.source_id);
  if (entries.length !== ids.length || entries.some(entry =>
    (entry.origin !== 'capture' && !allowsLegacyHistoryEntry(entry, historyReadId, contract) && !migrated.has(entry.source_id)) ||
    !['pending','confirmed'].includes(entry.state) || entry.source_hash !== entry.record_hash ||
    entry.target_id !== entry.record_target_id || entry.target_table !== target)) throw new SyncError('SELECTIVE_RECEIPT_INVALID');
  return entries;
}
export function evidence(entries: SelectedEntry[]) {
  return entries.map(e => ({ source_id: e.source_id, target_id: e.target_id, source_hash: e.source_hash,
    payload_hash: e.payload_hash, state: e.state, remote_raw_id: e.remote_raw_id }));
}
export function assertEvidence(entries: SelectedEntry[], expected: unknown): void {
  if (!isDeepStrictEqual(evidence(entries), expected)) throw new SyncError('SELECTIVE_COMMIT_EVIDENCE_CHANGED');
}
export function selectedRows(entries: SelectedEntry[], shape: Shape, cfg: DeliveryConfig) {
  const rows = entries.map(e => {
    const row = mapRow(e.payload, shape, cfg.connection);
    if (digest(row) !== e.payload_hash || row.internal_id_olos !== e.target_id) throw new SyncError('CORPORATE_PAYLOAD_CHANGED');
    return row;
  });
  uniqueIdentities(rows); return rows;
}
export async function prepareCommit(local: PoolClient, cfg: DeliveryConfig, source: string, target: string, schemaHash: string,
  entries: SelectedEntry[]): Promise<string> {
  const id = randomUUID();
  await local.query(`INSERT INTO olos_http.corporate_selective_commits(attempt_id,source_key,target_table,binding,schema_hash,evidence)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, source, target, cfg.binding, schemaHash, JSON.stringify(evidence(entries))]);
  await local.query(`UPDATE olos_http.corporate_control SET paused=true,blocked=true,last_code=$1,
    next_attempt_at=NULL,updated_at=now() WHERE singleton`, [selectiveCommitBlock]);
  // Caller must acknowledge this local COMMIT before issuing the remote COMMIT.
  return id;
}
export async function resolveCommit(local: PoolClient, id: string, state: 'acknowledged' | 'reconciled', entries: SelectedEntry[], found: Map<string, string>) {
  const result = await local.query(`UPDATE olos_http.corporate_selective_commits SET state=$2,resolved_at=now(),outcome=$3
    WHERE attempt_id=$1 AND state='unresolved'`, [id, state, JSON.stringify(entries.map(e => ({ source_id: e.source_id,
    target_id: e.target_id, payload_hash: e.payload_hash, remote_raw_id: found.get(e.target_id) ?? null })))]);
  if (result.rowCount !== 1) throw new SyncError('SELECTIVE_COMMIT_FENCE_LOST');
}
