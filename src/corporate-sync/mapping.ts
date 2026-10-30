import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Config } from './config.js';
import { SyncError } from './errors.js';

// Deliberately independent of AttemptsRawData and Billing mappings.
export const columns = ['internal_id_olos', 'olos_call_id', 'data_ligacao', 'telefone', 'nome_agente',
  'id_campanha_olos', 'nome_campanha_olos', 'id_tabulacao_olos', 'nome_tabulacao_olos', 'cpf',
  'lead_id_origem', 'tma_origem', 'razao_desligamento', 'email'] as const;
export const identityColumns = ['olos_call_id', 'data_ligacao', 'telefone', 'id_campanha_olos'] as const;
export type Row = Record<typeof columns[number], string | null>;
export interface Column { name: string; type: string; nullable: boolean; length: number | null; precision: number | null }
export type Shape = Map<string, Column>;
export const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

export function integerValue(raw: string, bits: 32 | 64): string {
  if (!/^-?\d+$/.test(raw)) throw new SyncError('INTEGER_INVALID');
  const value = BigInt(raw);
  const max = bits === 32 ? 2147483647n : 9223372036854775807n;
  if (value < -max - 1n || value > max) throw new SyncError('INTEGER_OUT_OF_RANGE');
  return value.toString();
}

export function tma(raw: string, cfg: Pick<Config, 'tmaPolicy' | 'tmaConfirmed'>): string {
  // Decimal arithmetic avoids Number rounding, exponent surprises and bigint precision loss.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new SyncError('TMA_INVALID');
  let magnitude = BigInt(match[2]!);
  const fraction = match[3] ?? '';
  if (/[1-9]/.test(fraction)) {
    if (cfg.tmaPolicy === 'reject') throw new SyncError('TMA_FRACTION_REJECTED');
    if (!cfg.tmaConfirmed) throw new SyncError('TMA_POLICY_NOT_CONFIRMED');
    if (cfg.tmaPolicy === 'round-half-away' && fraction[0]! >= '5') magnitude += 1n;
  }
  return integerValue((match[1] === '-' ? -magnitude : magnitude).toString(), 32);
}

export function mapRow(raw: Record<string, unknown>, shape: Shape, cfg: Config): Row {
  const row = {} as Row;
  for (const name of columns) {
    const col = shape.get(name);
    if (!col) throw new SyncError('SCHEMA_COLUMN_MISSING');
    const value = raw[name];
    if (value === null) {
      if (!col.nullable || name === 'internal_id_olos' || (identityColumns as readonly string[]).includes(name)) throw new SyncError('REQUIRED_VALUE_MISSING');
      row[name] = null;
      continue;
    }
    if (typeof value !== 'string' || value.includes('\0')) throw new SyncError('VALUE_TYPE_INVALID');
    if ((identityColumns as readonly string[]).includes(name) && !value.trim()) throw new SyncError('LOGICAL_IDENTITY_INCOMPLETE');
    if (col.length !== null && [...value].length > col.length) throw new SyncError('TEXT_TOO_LONG');
    if (name === 'internal_id_olos') row[name] = integerValue(value, col.type === 'int4' ? 32 : 64);
    else if (name === 'tma_origem') row[name] = tma(value, cfg);
    else if (name === 'data_ligacao') {
      // Canonical SQL UTC/wall-clock projection preserves all six PostgreSQL fractional digits.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}(?:Z)?$/.test(value)) throw new SyncError('TIMESTAMP_INVALID');
      const date = DateTime.fromISO(value.slice(0, 19), { zone: 'UTC' });
      if (!date.isValid || date.year < 1 || date.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value.slice(0, 19)) throw new SyncError('TIMESTAMP_INVALID');
      if ((col.type === 'timestamptz') !== value.endsWith('Z')) throw new SyncError('TIMESTAMP_TYPE_MISMATCH');
      if (col.precision !== null && /[1-9]/.test(value.slice(20, 26).slice(col.precision))) throw new SyncError('TIMESTAMP_PRECISION_LOSS');
      row[name] = value;
    } else row[name] = value;
  }
  return row;
}

export function digest(row: Row): string {
  return createHash('sha256').update(JSON.stringify(columns.map(name => row[name]))).digest('hex');
}
export function compare(existing: Row, expected: Row): void {
  if (identityColumns.some(name => existing[name] !== expected[name])) throw new SyncError('INTERNAL_ID_COLLISION');
  if (columns.some(name => existing[name] !== expected[name])) throw new SyncError('EXISTING_CALL_DIVERGES');
}

export function projection(shape: Shape, alias: string, source: boolean, cfg: Config): { sql: string; parameters: string[] } {
  const time = `${alias}.data_ligacao`;
  const wall = shape.get('data_ligacao')!.type === 'timestamp';
  const expression = source && wall ? `${time} AT TIME ZONE $1` : wall ? time : `${time} AT TIME ZONE 'UTC'`;
  return {
    sql: columns.map(name => name === 'data_ligacao'
      ? `CASE WHEN (${expression}) >= timestamp '0001-01-01' AND (${expression}) < timestamp '10000-01-01'
          THEN to_char(${expression}, 'YYYY-MM-DD"T"HH24:MI:SS.US${wall ? '' : '"Z"'}')
          ELSE NULL END AS data_ligacao`
      : `${alias}.${quote(name)}::text AS ${quote(name)}`).join(','),
    parameters: source && wall ? [cfg.timestampZone!] : [],
  };
}
