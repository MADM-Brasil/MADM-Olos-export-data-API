import type { PoolClient } from 'pg';
import { columns } from './mapping.js';
import { WorkerError } from './errors.js';

export const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export async function inspectSchema(client: PoolClient, schema: string, table: string) {
  const relation = `${quote(schema)}.${quote(table)}`;
  const cols = (await client.query(`SELECT column_name, udt_name, is_nullable, column_default, is_identity, is_generated
    FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, table])).rows;
  const constraints = (await client.query(`SELECT contype, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid=to_regclass($1)`, [relation])).rows;
  const indexes = (await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2`, [schema, table])).rows;
  const metadata = (await client.query(`SELECT relrowsecurity,
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS triggers,
    EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND indisunique AND NOT indisprimary) AS extra_unique,
    has_table_privilege(c.oid,'SELECT,INSERT,UPDATE') AS privileges
    FROM pg_class c WHERE c.oid=to_regclass($1)`, [relation])).rows[0];
  const sequence = cols.length ? (await client.query(`SELECT pg_get_serial_sequence($1,'internal_id_olos') AS name`, [relation])).rows[0]?.name as string | null : null;
  return { relation, columns: cols, constraints, indexes, metadata, sequence };
}
export async function assertSchema(client: PoolClient, schema: string, table: string) {
  const info = await inspectSchema(client, schema, table);
  const byName = new Map(info.columns.map(c => [c.column_name, c]));
  const id = byName.get('internal_id_olos');
  if (id?.udt_name !== 'int8' || !info.sequence) throw new WorkerError('DESTINATION_ID_GENERATOR_REQUIRED');
  if (!info.constraints.some(c => c.contype === 'p' && c.definition === 'PRIMARY KEY (internal_id_olos)')) throw new WorkerError('DESTINATION_PRIMARY_KEY_REQUIRED');
  // Additional constraints/triggers can require business semantics we do not know. Audit explicitly before adapting.
  if (info.constraints.some(c => c.contype !== 'p') || !info.metadata || info.metadata.extra_unique || info.metadata.relrowsecurity || info.metadata.triggers !== 0) throw new WorkerError('DESTINATION_CONSTRAINT_REVIEW_REQUIRED');
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
    if (!(await client.query('SELECT has_table_privilege($1,$2) AS ok', [info.relation, privilege])).rows[0].ok) throw new WorkerError('DESTINATION_PRIVILEGE_REQUIRED');
  }
  if (!(await client.query("SELECT has_sequence_privilege($1,'USAGE') AS ok", [info.sequence])).rows[0].ok) throw new WorkerError('DESTINATION_SEQUENCE_PRIVILEGE_REQUIRED');
  for (const name of columns) {
    const col = byName.get(name);
    const types = name === 'data_ligacao' ? ['timestamptz'] : name === 'tma_origem' ? ['numeric','int4','int8','text'] : name === 'raw_olos_call_id' ? ['text','varchar','int8'] : ['text','varchar'];
    if (!col || !types.includes(col.udt_name) || col.is_nullable !== 'YES' || col.is_generated !== 'NEVER') throw new WorkerError(`DESTINATION_COLUMN_REVIEW_${name}`);
  }
  for (const col of info.columns) {
    if (col.column_name === 'internal_id_olos' || (columns as readonly string[]).includes(col.column_name)) continue;
    if (col.is_nullable === 'NO' && !col.column_default && col.is_identity === 'NO' && col.is_generated === 'NEVER') throw new WorkerError('DESTINATION_REQUIRED_EXTRA_COLUMN');
  }
  return info;
}
