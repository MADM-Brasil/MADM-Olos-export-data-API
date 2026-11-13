import {readFileSync} from 'node:fs';
import type {PoolClient} from 'pg';
import {SyncError} from '../corporate-sync/errors.js';
import type {AllocatorStatus} from './allocator.js';

// Legacy is historical evidence, never an authority for newly assigned corporate IDs.
export function allocationPolicy(state:AllocatorStatus|undefined):'admit'|'reserve' {
  if(!state)throw new SyncError('ALLOCATOR_PREPARATION_REQUIRED');
  if(state.state==='reverting')throw new SyncError('ALLOCATOR_LEGACY_GENERATION_FORBIDDEN');
  if(state.state==='active')return 'reserve';
  if(state.state==='legacy'||state.state==='adopting')return 'admit';
  throw new SyncError('ALLOCATOR_LOCAL_STATE_INVALID');
}

export async function assertAllocationSchema(db:PoolClient):Promise<void> {
  if(!(await db.query("SELECT to_regclass('olos_http.corporate_authority_contract') IS NOT NULL AS present")).rows[0].present)
    throw new SyncError('ALLOCATOR_AUTHORITY_MIGRATION_REQUIRED');
  if((await db.query('SELECT version FROM olos_http.corporate_authority_contract WHERE singleton')).rows[0]?.version!==2)
    throw new SyncError('ALLOCATOR_LOCAL_CONTRACT_CHANGED');
  const ddl=readFileSync(new URL('../../migrations/014_corporate_authority.sql',import.meta.url),'utf8');
  const body=ddl.split('AS $authority$')[1]?.split('$authority$;')[0];
  const fn=(await db.query(`SELECT p.prosrc,p.prosecdef,p.proconfig,l.lanname FROM pg_proc p
    JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('olos_http.guard_corporate_authority()')`)).rows[0];
  if(!body||fn?.prosrc!==body||fn.prosecdef||fn.proconfig!==null||fn.lanname!=='plpgsql')throw new SyncError('ALLOCATOR_LOCAL_CONTRACT_CHANGED');
  for(const [table,type] of [['olos_http.records',7],['raw.olos_calls',23],['olos_http.corporate_id_allocator',19]] as const){
    const guard=await db.query(`SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname='corporate_authority_only'
      AND tgfoid=to_regprocedure('olos_http.guard_corporate_authority()') AND tgenabled='A' AND tgtype=$2
      AND tgqual IS NULL AND tgnargs=0 AND NOT tgdeferrable AND NOT tginitdeferred
      AND tgattr::text=CASE WHEN $1='raw.olos_calls' THEN
        (SELECT attnum::text FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname='internal_id_olos') ELSE '' END`,[table,type]);
    if(guard.rowCount!==1)throw new SyncError('ALLOCATOR_LOCAL_CONTRACT_CHANGED');
  }
}
