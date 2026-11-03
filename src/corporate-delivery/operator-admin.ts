import type { PoolClient } from 'pg';
import { connect, rollback } from '../corporate-sync/database.js';
import { SyncError } from '../corporate-sync/errors.js';
import type { Shape } from '../corporate-sync/mapping.js';
import type { DeliveryConfig } from './config.js';
import { corporateSchema } from './contract.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';
import { lockSelection } from './selective-commit.js';
import { deliveryDigest, hasOperator, mapDeliveryRow, operatorColumn, operatorId, withOperator } from './payload.js';

export type OperatorRequest = { kind: 'plan' } |
  { kind: 'adopt'; previousHash: string; schemaHash: string; confirmation: string } |
  { kind: 'prepare'; ids: string[]; confirmation: string };
export function validateOperatorRequest(cfg: DeliveryConfig | undefined, request: OperatorRequest): void {
  if (!cfg || cfg.connection.writeEnabled) throw new SyncError('OPERATOR_REQUIRES_GENERAL_WRITE_DISABLED');
  if (request.kind === 'plan') return;
  if (request.kind === 'adopt') {
    if (![request.previousHash, request.schemaHash].every(h => /^[a-f0-9]{64}$/.test(h)) || request.previousHash === request.schemaHash) throw new SyncError('OPERATOR_SCHEMA_HASH_INVALID');
    if (request.confirmation !== `AUTHORIZE_EXPORTDATA_OPERATOR_CONTRACT:${request.previousHash}:${request.schemaHash}`) throw new SyncError('OPERATOR_CHANGE_NOT_AUTHORIZED');
  } else {
    if (!request.ids.length || request.ids.length > 3 || new Set(request.ids).size !== request.ids.length ||
      request.ids.some(id => !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) throw new SyncError('OPERATOR_SOURCE_IDS_INVALID');
    if (request.confirmation !== `AUTHORIZE_EXPORTDATA_OPERATOR_PAYLOADS:${request.ids.join(',')}`) throw new SyncError('OPERATOR_CHANGE_NOT_AUTHORIZED');
  }
}
export function parseOperatorRequest(cfg: DeliveryConfig | undefined, command: string, args: string[]): OperatorRequest {
  let request: OperatorRequest;
  if (command === 'corporate-operator-plan' && !args.length) request = { kind: 'plan' };
  else if (command === 'corporate-adopt-operator' && args.length === 6 && args[0] === '--expected-schema-hash' && args[2] === '--schema-hash' && args[4] === '--confirm') {
    request = { kind: 'adopt', previousHash: args[1]!, schemaHash: args[3]!, confirmation: args[5]! };
  } else if (command === 'corporate-prepare-operator' && args.length === 4 && args[0] === '--source-ids' && args[2] === '--confirm') {
    request = { kind: 'prepare', ids: args[1]!.split(','), confirmation: args[3]! };
  } else throw new SyncError('OPERATOR_PARAMETERS_INVALID');
  validateOperatorRequest(cfg, request); return request;
}

// Caller is the existing Store, which owns the source and Corporate Sync locks.
// No capture, remote DDL, delivery, resume or scheduler is reachable from here.
export async function operatorAdmin(local: PoolClient, cfg: DeliveryConfig, source: string, target: string, request: OperatorRequest) {
  validateOperatorRequest(cfg, request);
  await local.query('BEGIN');
  try {
    await lockSelection(local, source);
    await assertLocalConsumersCompatible(local, source);
    if (!(await local.query("SELECT to_regclass('olos_http.corporate_operator_contracts') IS NOT NULL AND to_regclass('olos_http.corporate_operator_payloads') IS NOT NULL AS ok")).rows[0].ok) throw new SyncError('OPERATOR_LOCAL_MIGRATION_REQUIRED');
    const state = (await local.query('SELECT * FROM olos_http.corporate_control WHERE singleton FOR UPDATE NOWAIT')).rows[0];
    if (!state?.ready || !state.paused || state.blocked || state.last_code) throw new SyncError('OPERATOR_CONTROL_NOT_READY');
    if (state.binding !== cfg.binding || state.source_key !== source || state.target_table !== target) throw new SyncError('CORPORATE_BINDING_CHANGED');
    if ((await local.query("SELECT 1 FROM olos_http.corporate_selective_commits WHERE state='unresolved'")).rowCount) throw new SyncError('SELECTIVE_COMMIT_RECONCILIATION_REQUIRED');
    if ((await local.query("SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received')", [source])).rowCount) throw new SyncError('LOCAL_CAPTURE_RECOVERY_REQUIRED');
    const adoption = (await local.query('SELECT * FROM olos_http.corporate_operator_contracts WHERE source_key=$1 FOR UPDATE', [source])).rows[0];
    if (request.kind !== 'prepare') {
      const remote = await connect(cfg.connection, 'destination');
      try {
        await remote.query('BEGIN READ ONLY');
        await remote.query('LOCK TABLE raw.olos_calls IN ACCESS SHARE MODE');
        const contract = await corporateSchema(remote, cfg, false);
        if (!contract.shape.has(operatorColumn)) throw new SyncError('OPERATOR_SCHEMA_REQUIRED');
        const previousHash = adoption?.previous_schema_hash ?? state.schema_hash;
        if (contract.priorHash !== previousHash || adoption &&
          (adoption.schema_hash !== state.schema_hash || adoption.schema_hash !== contract.hash || adoption.binding !== cfg.binding || adoption.target_table !== target)) throw new SyncError('OPERATOR_SCHEMA_CHANGE_NOT_ADDITIVE');
        if (request.kind === 'adopt') {
          if (request.previousHash !== previousHash || request.schemaHash !== contract.hash) throw new SyncError('OPERATOR_SCHEMA_HASH_MISMATCH');
          if (!adoption) {
            await local.query(`INSERT INTO olos_http.corporate_operator_contracts(source_key,binding,target_table,previous_schema_hash,schema_hash)
              VALUES($1,$2,$3,$4,$5)`, [source,cfg.binding,target,previousHash,contract.hash]);
            await local.query(`UPDATE olos_http.corporate_control SET destination_shape=$1,schema_hash=$2,updated_at=now()
              WHERE singleton`, [JSON.stringify([...contract.shape]),contract.hash]);
          }
        }
        await remote.query('COMMIT');
        if (request.kind === 'plan') await local.query('ROLLBACK'); else await local.query('COMMIT');
        return { previous_schema_hash: previousHash as string, schema_hash: contract.hash, prepared: 0 };
      } finally { await rollback(remote); await remote.end().catch(() => {}); }
    }
    if (!adoption || adoption.schema_hash !== state.schema_hash || adoption.binding !== cfg.binding || adoption.target_table !== target) throw new SyncError('OPERATOR_CONTRACT_ADOPTION_REQUIRED');
    const shape = new Map(state.destination_shape) as Shape;
    if (!shape.has(operatorColumn)) throw new SyncError('OPERATOR_SCHEMA_REQUIRED');
    const entries = (await local.query(`SELECT o.*,o.target_id::text AS target_id,r.source_hash AS record_hash,
      r.target_id::text AS record_target,r.target_table,r.agent_id FROM olos_http.corporate_outbox o
      JOIN olos_http.records r USING(source_key,source_id) WHERE o.source_key=$1 AND o.source_id=ANY($2::text[])
      ORDER BY o.target_id FOR UPDATE OF o,r NOWAIT`, [source,request.ids])).rows;
    if (entries.length !== request.ids.length) throw new SyncError('OPERATOR_SELECTION_INCOMPLETE');
    let prepared = 0;
    for (const entry of entries) {
      if (entry.state !== 'pending' || entry.remote_raw_id !== null || entry.confirmed_at !== null ||
        entry.source_hash !== entry.record_hash || entry.target_id !== entry.record_target || entry.target_table !== target) throw new SyncError('OPERATOR_RECEIPT_INVALID');
      const row = mapDeliveryRow(entry.payload, shape, cfg.connection);
      if (deliveryDigest(row) !== entry.payload_hash) throw new SyncError('CORPORATE_PAYLOAD_CHANGED');
      const agentId = operatorId(entry.agent_id);
      const audit = (await local.query('SELECT * FROM olos_http.corporate_operator_payloads WHERE source_key=$1 AND source_id=$2', [source,entry.source_id])).rows[0];
      if (hasOperator(row)) {
        if (row.id_operador_olos !== agentId || audit && (audit.payload_hash !== entry.payload_hash ||
          audit.source_hash !== entry.source_hash || audit.agent_id !== agentId || String(audit.target_id) !== entry.target_id ||
          deliveryDigest(mapDeliveryRow(audit.previous_payload, shape, cfg.connection)) !== audit.previous_hash ||
          deliveryDigest(mapDeliveryRow(audit.payload, shape, cfg.connection)) !== entry.payload_hash)) throw new SyncError('OPERATOR_REVISION_DIVERGES');
        continue;
      }
      if (audit) throw new SyncError('OPERATOR_REVISION_DIVERGES');
      const payload = withOperator(row, agentId), hash = deliveryDigest(payload);
      await local.query(`INSERT INTO olos_http.corporate_operator_payloads
        (source_key,source_id,target_id,source_hash,agent_id,previous_payload,previous_hash,payload,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [source,entry.source_id,entry.target_id,entry.source_hash,agentId,
        JSON.stringify(entry.payload),entry.payload_hash,JSON.stringify(payload),hash]);
      const updated = await local.query(`UPDATE olos_http.corporate_outbox SET payload=$3,payload_hash=$4
        WHERE source_key=$1 AND source_id=$2 AND state='pending' AND payload_hash=$5`,
      [source,entry.source_id,JSON.stringify(payload),hash,entry.payload_hash]);
      if (updated.rowCount !== 1) throw new SyncError('CORPORATE_RECEIPT_FENCE_LOST');
      prepared++;
    }
    await local.query('COMMIT');
    return { previous_schema_hash: adoption.previous_schema_hash as string, schema_hash: state.schema_hash as string, prepared };
  } catch (error) { await rollback(local); throw error; }
}
