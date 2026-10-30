import type { Client } from 'pg';
import type { Config } from './config.js';
import { columns, type Column, type Shape } from './mapping.js';
import { SyncError } from './errors.js';

export async function schema(db: Client, side: 'source' | 'destination', cfg: Config, write = false): Promise<Shape> {
  const meta = (await db.query(`SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS triggers,
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS rules,
    EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (indisunique OR indisexclusion) AND NOT indisprimary) AS extra_unique,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype <> 'p') AS extra_constraints,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND NOT condeferrable
      AND pg_get_constraintdef(oid)='PRIMARY KEY (internal_id_olos)') AS primary_key,
    has_table_privilege(c.oid, 'SELECT') AS can_select,
    has_table_privilege(c.oid, 'INSERT') AS can_insert
    FROM pg_class c WHERE c.oid=to_regclass('raw.olos_calls')`)).rows[0];
  if (!meta || meta.relkind !== 'r' || meta.relrowsecurity || meta.relforcerowsecurity || !meta.can_select) throw new SyncError('SCHEMA_TABLE_INCOMPATIBLE');
  if (side === 'source' && !meta.primary_key) throw new SyncError('SCHEMA_TABLE_INCOMPATIBLE');
  if (side === 'destination') {
    if (meta.rules || meta.extra_constraints)
      throw new SyncError('DESTINATION_SCHEMA_REVIEW_REQUIRED');

    const triggers = (await db.query(`
      SELECT
        t.tgname AS name,
        pg_get_triggerdef(t.oid) AS definition,
        t.tgenabled AS enabled
      FROM pg_trigger t
      WHERE t.tgrelid = 'raw.olos_calls'::regclass
        AND NOT t.tgisinternal
    `)).rows;

    const expectedTrigger =
      'CREATE TRIGGER trg_olos_calls_normalizar_telefone ' +
      'BEFORE INSERT OR UPDATE OF telefone, telefone_match_key ' +
      'ON raw.olos_calls FOR EACH ROW ' +
      'EXECUTE FUNCTION raw.fn_olos_calls_normalizar_telefone()';

    if (triggers.length !== 1 ||
        triggers[0].name !== 'trg_olos_calls_normalizar_telefone' ||
        triggers[0].definition !== expectedTrigger ||
        triggers[0].enabled !== 'O') {
      throw new SyncError('DESTINATION_TRIGGER_REVIEW_REQUIRED');
    }

    const indexes = (await db.query(`
      SELECT
        ic.relname AS name,
        i.indisprimary AS primary_key,
        i.indisunique AS unique_index,
        i.indimmediate AS immediate,
        pg_get_indexdef(i.indexrelid) AS definition,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = 'raw.olos_calls'::regclass
        AND i.indisunique
      ORDER BY ic.relname
    `)).rows;

    const primary = indexes.find(i =>
      i.name === 'pk_raw_olos_calls' &&
      i.primary_key === true &&
      i.unique_index === true &&
      i.immediate === true &&
      i.definition ===
        'CREATE UNIQUE INDEX pk_raw_olos_calls ON raw.olos_calls USING btree (raw_olos_call_id)' &&
      i.predicate === null
    );

    const internal = indexes.find(i =>
      i.name === 'ux_raw_olos_calls_internal_id' &&
      i.primary_key === false &&
      i.unique_index === true &&
      i.immediate === true &&
      i.definition ===
        'CREATE UNIQUE INDEX ux_raw_olos_calls_internal_id ON raw.olos_calls USING btree (internal_id_olos) WHERE (internal_id_olos IS NOT NULL)' &&
      i.predicate === '(internal_id_olos IS NOT NULL)'
    );

    if (!primary || !internal || indexes.length !== 2)
      throw new SyncError('DESTINATION_UNIQUE_INDEX_REVIEW_REQUIRED');
  }
  if (write && side === 'destination' && !meta.can_insert) throw new SyncError('DESTINATION_INSERT_PRIVILEGE_REQUIRED');
  const result = await db.query(`SELECT column_name AS name, udt_name AS type, is_nullable='YES' AS nullable,
    character_maximum_length AS length, datetime_precision AS precision, column_default AS default_value,
    is_identity, is_generated, domain_name
    FROM information_schema.columns WHERE table_schema='raw' AND table_name='olos_calls' ORDER BY ordinal_position`);
  const shape: Shape = new Map(result.rows.map(col => [col.name as string, col as Column]));
  for (const name of columns) {
    const col = result.rows.find(col => col.name === name);
    const accepted = name === 'internal_id_olos' ? side === 'source' ? ['int8'] : ['int4'] : name === 'tma_origem'
      ? side === 'source' ? ['numeric', 'int4', 'int8'] : ['int4']
      : name === 'data_ligacao' ? side === 'source' ? ['timestamptz'] : ['timestamp', 'timestamptz'] : ['text', 'varchar'];
    if (!col || !accepted.includes(col.type) || col.domain_name || col.is_generated !== 'NEVER') throw new SyncError('SCHEMA_COLUMN_INCOMPATIBLE');
    if (side === 'destination' && (col.is_identity !== 'NO' || col.default_value !== null)) throw new SyncError('DESTINATION_DEFAULT_REVIEW_REQUIRED');
  }
  if (side === 'destination') {
    for (const col of result.rows) {
      if ((columns as readonly string[]).includes(col.name)) continue;
      // Accept only the additional columns explicitly audited in MADM.
      const expected: Record<string, {
        type: string;
        nullable: boolean;
        defaultValue: string | null;
        identity: string;
      }> = {
        raw_olos_call_id: {
          type: 'int8', nullable: false,
          defaultValue: null, identity: 'YES'
        },
        telefone_match_key: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        arquivo_origem: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        lote_carga: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        data_carga: {
          type: 'timestamptz', nullable: false,
          defaultValue: 'now()', identity: 'NO'
        },
        created_at: {
          type: 'timestamptz', nullable: false,
          defaultValue: 'now()', identity: 'NO'
        },
        updated_at: {
          type: 'timestamptz', nullable: false,
          defaultValue: 'now()', identity: 'NO'
        },
        kommo_event_hash: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_event_hash_processado: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_status_processamento: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_lead_id_encontrado: {
          type: 'int8', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_match_origem: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_tentativas: {
          type: 'int4', nullable: false,
          defaultValue: '0', identity: 'NO'
        },
        kommo_processado_em: {
          type: 'timestamptz', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_erro: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_pipeline_id_atual: {
          type: 'int8', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_status_id_atual: {
          type: 'int8', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_batch_id: {
          type: 'text', nullable: true,
          defaultValue: null, identity: 'NO'
        },
        kommo_reservado_em: {
          type: 'timestamptz', nullable: true,
          defaultValue: null, identity: 'NO'
        }
      };

      const rule = expected[col.name];
      if (!rule ||
          col.type !== rule.type ||
          col.nullable !== rule.nullable ||
          col.default_value !== rule.defaultValue ||
          col.is_identity !== rule.identity ||
          col.is_generated !== 'NEVER' ||
          col.domain_name) {
        throw new SyncError('DESTINATION_EXTRA_COLUMN_REVIEW_REQUIRED');
      }
    }
    if (shape.get('data_ligacao')!.type === 'timestamp') {
      if (!cfg.timestampConfirmed || !cfg.timestampZone) throw new SyncError('TIMESTAMP_SEMANTICS_NOT_CONFIRMED');
      if (!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [cfg.timestampZone])).rowCount) throw new SyncError('TIMESTAMP_ZONE_INVALID');
    }
  }
  return shape;
}
