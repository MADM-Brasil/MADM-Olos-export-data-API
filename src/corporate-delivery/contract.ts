import { createHash } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { schema } from '../corporate-sync/schema.js';
import { columns, compare, identityColumns, mapRow, projection, quote, type Row, type Shape } from '../corporate-sync/mapping.js';
import { SyncError } from '../corporate-sync/errors.js';
import type { DeliveryConfig } from './config.js';

export async function corporateSchema(db: Client, cfg: DeliveryConfig, write: boolean) {
  const identity = (await db.query("SELECT current_database() AS name, current_setting('session_replication_role') AS replication")).rows[0];
  if (identity.name !== 'madm' || identity.replication !== 'origin') throw new SyncError('CORPORATE_DATABASE_CONTRACT_INVALID');
  const shape = await schema(db, 'destination', cfg.connection, write);
  if ((await db.query(`SELECT 1 FROM pg_index WHERE indrelid='raw.olos_calls'::regclass
    AND (indisunique OR indisexclusion) AND (NOT indisvalid OR NOT indisready) LIMIT 1`)).rowCount) throw new SyncError('CORPORATE_INDEX_NOT_READY');
  for (const name of ['raw_olos_call_id', 'telefone_match_key', 'data_carga', 'created_at', 'updated_at']) {
    if (!shape.has(name)) throw new SyncError('CORPORATE_REQUIRED_COLUMN_MISSING');
  }
  const raw = (await db.query(`SELECT identity_generation FROM information_schema.columns
    WHERE table_schema='raw' AND table_name='olos_calls' AND column_name='raw_olos_call_id'`)).rows[0];
  if (raw?.identity_generation !== 'ALWAYS') throw new SyncError('CORPORATE_IDENTITY_ALWAYS_REQUIRED');
  const functions = (await db.query(`SELECT pg_get_functiondef('raw.fn_olos_calls_normalizar_telefone()'::regprocedure) AS trigger_body,
    pg_get_functiondef('core.gerar_telefone_match_key(text)'::regprocedure) AS normalizer_body`)).rows[0];
  const hash = createHash('sha256').update(JSON.stringify([[...shape], functions])).digest('hex');
  return { shape, hash };
}

export async function freeze(db: PoolClient, input: Record<string, unknown>[], shape: Shape, cfg: DeliveryConfig): Promise<Row[]> {
  if (!input.length) return [];
  const p = projection(shape, 's', true, cfg.connection);
  const declarations = columns.map(name => `${quote(name)} ${name === 'data_ligacao' ? 'timestamptz' : name === 'tma_origem' ? 'numeric' : 'text'}`).join(',');
  const result = await db.query(`SELECT ${p.sql} FROM jsonb_to_recordset($${p.parameters.length + 1}::jsonb) AS s(${declarations})`, [...p.parameters, JSON.stringify(input)]);
  return result.rows.map(row => mapRow(row, shape, cfg.connection));
}

export async function matches(db: Client, rows: Row[], shape: Shape, cfg: DeliveryConfig): Promise<Map<string, string>> {
  const p = projection(shape, 'd', false, cfg.connection);
  const declarations = columns.map(name => `${quote(name)} ${shape.get(name)!.type}`).join(',');
  // Identity fields are required/non-null in the mapped payload. Equality permits hash joins.
  const identity = identityColumns.map(name => `d.${quote(name)}=x.${quote(name)}`).join(' AND ');
  const expected = new Map(rows.map(row => [row.internal_id_olos, row]));
  const result = await db.query(`WITH expected AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${declarations}))
    SELECT d.raw_olos_call_id::text AS remote_id,${p.sql} FROM raw.olos_calls d JOIN (
      SELECT d.raw_olos_call_id FROM raw.olos_calls d JOIN expected x ON d.internal_id_olos=x.internal_id_olos
      UNION SELECT d.raw_olos_call_id FROM raw.olos_calls d JOIN expected x ON ${identity}
    ) matched USING(raw_olos_call_id)`, [JSON.stringify(rows)]);
  const found = new Map<string, string>();
  for (const raw of result.rows) {
    const wanted = expected.get(raw.internal_id_olos);
    if (!wanted) throw new SyncError('LOGICAL_CALL_AT_DIFFERENT_ID');
    compare(mapRow(raw, shape, cfg.connection), wanted);
    found.set(raw.internal_id_olos, raw.remote_id);
  }
  return found;
}

export function uniqueIdentities(rows: Row[]): void {
  const keys = rows.map(row => JSON.stringify(identityColumns.map(name => row[name])));
  if (new Set(keys).size !== rows.length) throw new SyncError('DUPLICATE_LOGICAL_IDENTITY');
}
