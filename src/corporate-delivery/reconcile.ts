import type { PoolClient } from 'pg';
import { connect, rollback } from '../corporate-sync/database.js';
import { digest, integerValue, mapRow, projection, type Row } from '../corporate-sync/mapping.js';
import { SyncError } from '../corporate-sync/errors.js';
import type { DeliveryConfig } from './config.js';
import { corporateSchema, matches, uniqueIdentities } from './contract.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';

// Called only by the existing ExportDataV3 administrative command, never by an ingestion tick.
export async function reconcileLegacy(local: PoolClient, cfg: DeliveryConfig, source: string, target: string, sequence: string) {
  if (!cfg.reconcileAuthorized) throw new SyncError('CORPORATE_RECONCILIATION_NOT_AUTHORIZED');
  if (!cfg.legacyBinding) throw new SyncError('LEGACY_BINDING_REQUIRED');
  await assertLocalConsumersCompatible(local, source);
  const remote = await connect(cfg.connection, 'destination');
  try {
    await local.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const current = (await local.query('SELECT binding,ready,legacy_count::text FROM olos_http.corporate_control WHERE singleton FOR UPDATE')).rows[0];
    if (current?.binding !== undefined && current.binding !== cfg.binding) throw new SyncError('CORPORATE_BINDING_CHANGED');
    if (current?.ready) { await remote.query('COMMIT'); await local.query('COMMIT'); return Number(current.legacy_count); }
    if ((await local.query("SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received') LIMIT 1", [source])).rowCount) throw new SyncError('LOCAL_CAPTURE_RECOVERY_REQUIRED');
    await local.query(`LOCK TABLE olos_http.records,${target},corporate_sync.control,corporate_sync.receipts IN SHARE MODE`);
    const old = (await local.query('SELECT binding,confirmed_count::text,pending FROM corporate_sync.control WHERE singleton')).rows[0];
    const count = Number((await local.query('SELECT count(*)::text AS n FROM corporate_sync.receipts')).rows[0].n);
    if (!old || old.binding !== cfg.legacyBinding || old.pending !== null || Number(old.confirmed_count) !== count || count !== cfg.expectedLegacyCount) throw new SyncError('LEGACY_STATE_NOT_RECONCILED');
    const missing = await local.query(`SELECT 1 FROM corporate_sync.receipts c LEFT JOIN olos_http.records r
      ON r.target_id=c.internal_id_olos AND r.target_table=$1 LEFT JOIN ${target} d ON d.internal_id_olos=r.target_id
      WHERE r.source_key IS DISTINCT FROM $2 OR d.internal_id_olos IS NULL LIMIT 1`, [target, source]);
    if (missing.rowCount) throw new SyncError('LEGACY_RECEIPT_MAPPING_MISSING');
    const invalid = await local.query(`SELECT 1 FROM olos_http.records r LEFT JOIN ${target} d ON d.internal_id_olos=r.target_id
      WHERE r.target_table=$1 AND (r.source_key<>$2 OR d.internal_id_olos IS NULL) LIMIT 1`, [target, source]);
    if (invalid.rowCount) throw new SyncError('LEGACY_RECORD_MAPPING_MISSING');
    // Retain the original allocator. Never create a sequence, setval, infer IDs from OLOS or remap collisions.
    const max = BigInt((await local.query('SELECT COALESCE(max(target_id),0)::text AS n FROM olos_http.records WHERE target_table=$1', [target])).rows[0].n);
    const allocator = (await local.query(`SELECT last_value::text,is_called FROM ${sequence}`)).rows[0];
    if (BigInt(allocator.last_value) < max || !allocator.is_called && BigInt(allocator.last_value) <= max) throw new SyncError('LEGACY_ALLOCATOR_BEHIND');
    integerValue(allocator.last_value, 32);
    const sequenceMeta = (await local.query('SELECT seqincrement::text,seqcycle FROM pg_sequence WHERE seqrelid=$1::regclass', [sequence])).rows[0];
    if (!sequenceMeta || BigInt(sequenceMeta.seqincrement) <= 0n || sequenceMeta.seqcycle) throw new SyncError('LEGACY_ALLOCATOR_REVIEW_REQUIRED');
    const { shape, hash } = await corporateSchema(remote, cfg, false);
    const p = projection(shape, 's', true, cfg.connection);
    let cursor: string | null = null, recognized = 0;
    for (;;) {
      const args: (string | number | null)[] = [...p.parameters, source, target, cursor, cfg.connection.batchSize];
      const n = p.parameters.length;
      const batch: Record<string, string | null>[] = (await local.query(`SELECT r.source_id,r.source_hash,c.payload_hash AS legacy_hash,${p.sql}
        FROM olos_http.records r JOIN ${target} s ON s.internal_id_olos=r.target_id
        LEFT JOIN corporate_sync.receipts c ON c.internal_id_olos=r.target_id
        WHERE r.source_key=$${n + 1} AND r.target_table=$${n + 2}
          AND ($${n + 3}::bigint IS NULL OR r.target_id>$${n + 3}) ORDER BY r.target_id LIMIT $${n + 4}`, args)).rows;
      if (!batch.length) break;
      const payloads: Row[] = batch.map(raw => mapRow(raw, shape, cfg.connection));
      uniqueIdentities(payloads);
      const found = await matches(remote, payloads, shape, cfg);
      for (let i = 0; i < batch.length; i++) {
        const record = batch[i]!, payload = payloads[i]!, payloadHash = digest(payload);
        const remoteId = found.get(payload.internal_id_olos!);
        if (record.legacy_hash && (record.legacy_hash !== payloadHash || !remoteId)) throw new SyncError('LEGACY_RECEIPT_PROOF_MISMATCH');
        if (record.legacy_hash) recognized++;
        await local.query(`INSERT INTO olos_http.corporate_outbox
          (source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9::bigint IS NOT NULL THEN now() ELSE NULL END)`,
        [source, record.source_id, payload.internal_id_olos, record.source_hash, JSON.stringify(payload), payloadHash,
          remoteId ? 'confirmed' : 'pending', record.legacy_hash ? 'legacy_receipt' : 'legacy_backlog', remoteId ?? null]);
      }
      cursor = payloads.at(-1)!.internal_id_olos;
    }
    if (recognized !== count) throw new SyncError('LEGACY_RECEIPT_COUNT_MISMATCH');
    await local.query(`INSERT INTO olos_http.corporate_control
      (singleton,source_key,target_table,binding,legacy_binding,legacy_count,ready,destination_shape,schema_hash,confirmed_count,reconciled_at)
      VALUES(true,$1,$2,$3,$4,$5,true,$6,$7,(SELECT count(*) FROM olos_http.corporate_outbox WHERE state='confirmed'),now())`,
    [source, target, cfg.binding, cfg.legacyBinding, count, JSON.stringify([...shape]), hash]);
    // READ ONLY remote transaction also has to finish successfully before durable local adoption.
    await remote.query('COMMIT');
    await local.query('COMMIT');
    return recognized;
  } catch (error) { await rollback(local); await rollback(remote); throw error; }
  finally { await remote.end().catch(() => {}); }
}
