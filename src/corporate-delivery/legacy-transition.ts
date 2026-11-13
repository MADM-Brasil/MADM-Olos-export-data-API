import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';

// Installed 014 cannot be bypassed by an older binary. Only the reviewed local
// forward transition admits checked candidates, preserving the authority history.
export async function assertLegacyRecoverySchema(local: PoolClient): Promise<boolean> {
  const state=(await local.query<{authority:boolean;recovery:boolean}>(`SELECT
    to_regclass('olos_http.corporate_authority_contract') IS NOT NULL AS authority,
    to_regclass('olos_http.corporate_legacy_recovery') IS NOT NULL AS recovery`)).rows[0];
  if(!state?.authority&&!state?.recovery)return false;
  if(!state.authority||!state.recovery)throw new SyncError('LEGACY_RECOVERY_TRANSITION_REQUIRED');
  const ddl=readFileSync(new URL('../../migrations/015_corporate_legacy_recovery.sql',import.meta.url),'utf8');
  for(const [name,delimiter] of [['guard_corporate_authority','authority'],['guard_legacy_recovery_evidence','evidence'],['guard_legacy_recovery_mapping','mapping']] as const){
    const expected=ddl.split(`AS $${delimiter}$`)[1]?.split(`$${delimiter}$;`)[0];
    const actual=(await local.query<{prosrc:string;prosecdef:boolean;proconfig:string[]|null}>(
      'SELECT prosrc,prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)',[`olos_http.${name}()`])).rows[0];
    if(!expected||actual?.prosrc!==expected||actual.prosecdef||actual.proconfig!==null)throw new SyncError('LEGACY_RECOVERY_LOCAL_CONTRACT_CHANGED');
  }
  const bindings=(await local.query(`SELECT 1 FROM olos_http.corporate_legacy_recovery r
    JOIN olos_http.corporate_control c USING(source_key,binding,target_table)
    JOIN olos_http.corporate_id_allocator a USING(source_key,binding,target_table)
    WHERE r.singleton AND r.version=1 AND NOT c.id_allocator_required AND c.id_allocator_generation IS NULL
      AND a.state='legacy' AND a.contract_hash IS NULL AND a.adopted_at IS NULL`)).rowCount;
  if(bindings!==1)throw new SyncError('LEGACY_RECOVERY_BINDING_CHANGED');
  for(const [table,name,events,fn] of [
    ['olos_http.records','corporate_authority_only','INSERT','guard_corporate_authority'],
    ['raw.olos_calls','corporate_authority_only','INSERT OR UPDATE OF internal_id_olos','guard_corporate_authority'],
    ['olos_http.corporate_id_allocator','corporate_authority_only','UPDATE','guard_corporate_authority'],
    ['olos_http.corporate_control','corporate_legacy_recovery_control','DELETE OR UPDATE','guard_corporate_authority'],
    ['olos_http.corporate_legacy_recovery','corporate_legacy_recovery_immutable','DELETE OR UPDATE','guard_legacy_recovery_evidence'],
    ['olos_http.records','corporate_legacy_mapping','DELETE OR UPDATE','guard_legacy_recovery_mapping'],
    ['olos_http.corporate_outbox','corporate_legacy_mapping','DELETE OR UPDATE','guard_legacy_recovery_mapping'],
  ]){
    const trigger=(await local.query<{definition:string;tgenabled:string}>(`SELECT pg_get_triggerdef(oid) AS definition,tgenabled
      FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal`,[table,name])).rows[0];
    if(trigger?.tgenabled!=='A'||trigger.definition!==`CREATE TRIGGER ${name} BEFORE ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION olos_http.${fn}()`)
      throw new SyncError('LEGACY_RECOVERY_LOCAL_CONTRACT_CHANGED');
  }
  await local.query('SELECT delivery_uncertain_ids FROM olos_http.corporate_control LIMIT 0');
  return true;
}
