import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';

export const allocatorTrigger = 'CREATE TRIGGER trg_olos_calls_reserve_internal_id BEFORE INSERT OR UPDATE OF internal_id_olos ON raw.olos_calls FOR EACH ROW EXECUTE FUNCTION olos_delivery_ids.guard_internal_id()';
export async function allocatorContract(db: Client): Promise<string> {
  const ddl = readFileSync(new URL('../../migrations/corporate/001_id_allocator.sql', import.meta.url), 'utf8');
  const functions = [];
  for (const [signature, delimiter] of [['reserve(text,jsonb,boolean)','reserve'],['guard_internal_id()','guard']] as const) {
    const info = (await db.query(`SELECT p.prosrc,p.prosecdef,p.proconfig,l.lanname,pg_get_functiondef(p.oid) AS definition,
      p.proowner=(SELECT relowner FROM pg_class WHERE oid='olos_delivery_ids.registry'::regclass) AS same_owner
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`, [`olos_delivery_ids.${signature}`])).rows[0];
    const body = ddl.split(`AS $${delimiter}$`)[1]?.split(`$${delimiter}$;`)[0];
    if (!info || !body || info.prosrc !== body || !info.prosecdef || !info.same_owner || info.lanname !== 'plpgsql'
      || JSON.stringify(info.proconfig) !== JSON.stringify(['search_path=pg_catalog'])) throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
    functions.push(info.definition);
  }
  const trigger = (await db.query(`SELECT pg_get_triggerdef(oid) AS definition,tgenabled FROM pg_trigger
    WHERE tgrelid='raw.olos_calls'::regclass AND tgname='trg_olos_calls_reserve_internal_id' AND NOT tgisinternal`)).rows[0];
  if (trigger?.definition !== allocatorTrigger || trigger.tgenabled !== 'A') throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  const constraints = (await db.query(`SELECT n.nspname||'.'||c.relname AS relation,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE conrelid IN ('olos_delivery_ids.registry'::regclass,'olos_delivery_ids.counter'::regclass)
    ORDER BY n.nspname,c.relname,conname`)).rows;
  if (!constraints.some(c => c.relation === 'olos_delivery_ids.registry' && c.definition === 'PRIMARY KEY (internal_id)')) throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  return createHash('sha256').update(JSON.stringify([functions,trigger,constraints])).digest('hex');
}
