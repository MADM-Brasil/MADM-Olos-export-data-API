import type { PoolClient } from 'pg';
import { log } from '../errors.js';
import { SyncError } from '../corporate-sync/errors.js';

interface Scope { relation: string; column: string; target: boolean }
function unsafe(reason: string, fields: Record<string,string|number|boolean|null> = {}): never {
  log('corporate_legacy_sequence_unsafe', { error:'ALLOCATOR_LEGACY_SEQUENCE_UNSAFE',reason,...fields });
  throw new SyncError('ALLOCATOR_LEGACY_SEQUENCE_UNSAFE');
}

// The original tables contain occupied IDs, not a complete record of their allocator provenance.
// Never infer provenance or a new cursor from MAX(target_id), source_id, row counts or outbox.origin.
export async function lockLegacyIdSpace(local: PoolClient, target: string): Promise<Scope[]> {
  // Fence before ID tables; keep capture independent of delivery's control row.
  await local.query('SELECT pg_advisory_xact_lock_shared(17320914,5)');
  const scopes: Scope[] = [
    {relation:'olos_http.records',column:'target_id',target:true},
    {relation:'olos_http.corporate_outbox',column:'target_id',target:false},
    {relation:target,column:'internal_id_olos',target:false},
  ];
  const receipts = (await local.query("SELECT to_regclass('corporate_sync.receipts') IS NOT NULL AS present")).rows[0].present;
  if (receipts) scopes.push({relation:'corporate_sync.receipts',column:'internal_id_olos',target:false});
  else if ((await local.query('SELECT 1 FROM olos_http.corporate_control WHERE singleton AND legacy_count>0')).rowCount) unsafe('LEGACY_RECEIPTS_MISSING');
  for (const scope of scopes) {
    const privilege = (await local.query(`SELECT has_table_privilege($1,'UPDATE') OR has_table_privilege($1,'DELETE')
      OR has_table_privilege($1,'TRUNCATE') AS can_lock`,[scope.relation])).rows[0];
    if (!privilege.can_lock) unsafe('LOCAL_ID_LOCK_PRIVILEGE_REQUIRED',{scope:scope.relation});
  }
  if((await local.query("SELECT to_regclass('olos_http.corporate_allocation_fence') IS NOT NULL AS present")).rows[0].present){
    const fence=await local.query('SELECT 1 FROM olos_http.corporate_allocation_fence WHERE target_table=$1 FOR SHARE',[target]);
    if(fence.rowCount!==1)throw new SyncError('READOPTION_AUTHORITY_EVIDENCE_CHANGED');
  }
  // Also exclude writers that do not take the application advisory fence. No sequence mutation.
  await local.query(`LOCK TABLE ${scopes.map(s=>s.relation).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  for (const scope of scopes) {
    const info = (await local.query('SELECT relkind,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[scope.relation])).rows[0];
    if (info?.relkind!=='r' || info.relrowsecurity || info.relforcerowsecurity) unsafe('LOCAL_ID_SPACE_NOT_VISIBLE',{scope:scope.relation});
  }
  for (const [relation,definition] of [
    ['olos_http.records','UNIQUE (target_table, target_id)'],
    ['olos_http.corporate_outbox','UNIQUE (target_id)'],
    [target,'PRIMARY KEY (internal_id_olos)'],
  ]) {
    const index = await local.query(`SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
      WHERE c.conrelid=$1::regclass AND pg_get_constraintdef(c.oid)=$2 AND NOT c.condeferrable
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate`,[relation,definition]);
    if (!index.rowCount) unsafe('LOCAL_ID_UNIQUENESS_NOT_PROVEN',{scope:relation!});
  }
  return scopes;
}
async function occupied(local: PoolClient, scopes: Scope[], target: string, first: string, last: string, increment: string) {
  return (await local.query(scopes.map(scope=>`SELECT ${scope.column}::bigint AS id,'${scope.relation.replaceAll("'","''")}'::text AS scope
    FROM ${scope.relation} WHERE ${scope.column}>=$2::bigint AND ${scope.column}<=$3::bigint
      AND (${scope.column}::numeric-$2::numeric)%$4::numeric=0${scope.target?' AND target_table=$1':''}`)
    .join(' UNION ALL ')+' ORDER BY id,scope LIMIT 1',[target,first,last,increment])).rows[0];
}
export async function assertLegacyIdFree(local: PoolClient, scopes: Scope[], target: string, id: string): Promise<void> {
  const conflict = await occupied(local,scopes,target,id,id,'1');
  if (conflict) unsafe('LOCAL_TARGET_ID_OCCUPIED',{target_id:String(conflict.id),scope:conflict.scope});
}
export async function verifyLegacySequence(local: PoolClient, target: string, sequence: string, source: string): Promise<void> {
  const scopes = await lockLegacyIdSpace(local,target);
  const meta = (await local.query(`SELECT seqincrement::text,seqcache::text,seqmin::text,seqmax::text,seqcycle
    FROM pg_sequence WHERE seqrelid=$1::regclass`,[sequence])).rows[0];
  if (!meta || meta.seqcycle || BigInt(meta.seqincrement)<=0n) unsafe('SEQUENCE_METADATA_UNSUPPORTED');
  // With cached values, last_value is not proof of the next values of every connected consumer.
  if (meta.seqcache!=='1') unsafe('SEQUENCE_CACHE_NOT_ONE',{cache:meta.seqcache});
  const value = (await local.query(`SELECT last_value::text,is_called FROM ${sequence}`)).rows[0];
  const increment = BigInt(meta.seqincrement);
  const first = BigInt(value.last_value)+(value.is_called?increment:0n);
  // Existing exact mappings consume no new IDs. Verify at least the next value even for an empty queue.
  const count = BigInt((await local.query(`SELECT count(*)::text AS n FROM olos_http.corporate_id_admissions a
    WHERE a.source_key=$1 AND NOT a.materialized AND NOT EXISTS (
      SELECT 1 FROM olos_http.records r WHERE r.source_key=a.source_key AND r.source_id=a.source_id)`,[source])).rows[0].n);
  const last = first+increment*((count>0n?count:1n)-1n);
  if (first<BigInt(meta.seqmin) || last>BigInt(meta.seqmax) || first<1n || last>2147483647n) unsafe('SEQUENCE_CAPACITY_NOT_PROVEN',{
    first_candidate:first.toString(),last_candidate:last.toString(),new_records:count.toString() });
  const conflict = await occupied(local,scopes,target,first.toString(),last.toString(),increment.toString());
  if (conflict) unsafe('LOCAL_TARGET_ID_OCCUPIED',{target_id:String(conflict.id),scope:conflict.scope,
    first_candidate:first.toString(),last_candidate:last.toString()});
  log('corporate_legacy_sequence_verified',{first_candidate:first.toString(),last_candidate:last.toString(),new_records:count.toString()});
}
// Compatibility entrypoint for older callers. Historical diagnostics above remain
// available; no code path may consume this sequence for a new corporate ID.
export async function nextLegacyId(_local: PoolClient, _sequence: string, _target: string, _scopes: Scope[]): Promise<string> {
  throw new SyncError('ALLOCATOR_LEGACY_GENERATION_FORBIDDEN');
}
