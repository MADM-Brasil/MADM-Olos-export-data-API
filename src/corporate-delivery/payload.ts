import { createHash } from 'node:crypto';
import { columns, digest, mapRow, type Row, type Shape } from '../corporate-sync/mapping.js';
import type { Config } from '../corporate-sync/config.js';
import { SyncError } from '../corporate-sync/errors.js';

export const operatorColumn = 'id_operador_olos';
export type DeliveryRow = Row & { id_operador_olos?: string | null };
export const hasOperator = (row: object) => Object.hasOwn(row, operatorColumn);
// AgentId is already normalized losslessly by api.rows()/mapRecord(). No lookup,
// trimming, numeric coercion or interpretation of 0/-1 as another operator.
export function operatorId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.includes('\0')) throw new SyncError('OPERATOR_ID_INVALID');
  return value;
}
export function deliveryColumns(row: DeliveryRow): readonly string[] {
  return hasOperator(row) ? [...columns, operatorColumn] : columns;
}
export function mapDeliveryRow(raw: Record<string, unknown>, shape: Shape, cfg: Config): DeliveryRow {
  const row: DeliveryRow = mapRow(raw, shape, cfg);
  if (hasOperator(raw)) {
    if (!shape.has(operatorColumn)) throw new SyncError('OPERATOR_SCHEMA_REQUIRED');
    if (raw[operatorColumn] === undefined) throw new SyncError('OPERATOR_ID_INVALID');
    row.id_operador_olos = operatorId(raw[operatorColumn]);
  }
  return row;
}
export function deliveryDigest(row: DeliveryRow): string {
  if (!hasOperator(row)) return digest(row); // v1 is byte-for-byte unchanged.
  return createHash('sha256').update(JSON.stringify(['exportdata-direct-operator-v2',
    columns.map(name => row[name]), operatorId(row.id_operador_olos)])).digest('hex');
}
export function withOperator(row: Row, agentId: unknown): DeliveryRow {
  return { ...row, id_operador_olos: operatorId(agentId) };
}
