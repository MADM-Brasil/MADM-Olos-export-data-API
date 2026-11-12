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
  const expectedConstraints=[
    ['counter',"CHECK (((next_candidate >= 1) AND (next_candidate <= '2147483648'::bigint)))"],['counter','PRIMARY KEY (singleton)'],['counter','CHECK (singleton)'],
    ['registry',"CHECK (((state = 'used'::text) OR ((owner_role IS NOT NULL) AND (binding IS NOT NULL) AND (source_id IS NOT NULL) AND (source_hash IS NOT NULL) AND (token IS NOT NULL))))"],
    ['registry','UNIQUE (owner_role, binding, source_id)'],['registry','PRIMARY KEY (internal_id)'],['registry','UNIQUE (request_id)'],
    ['registry',"CHECK ((state = ANY (ARRAY['reserved'::text, 'used'::text])))"],['registry','UNIQUE (token)']
  ].map(([table,definition])=>'olos_delivery_ids.'+table+':'+definition).sort();
  if(JSON.stringify(constraints.map(c=>c.relation+':'+c.definition).sort())!==JSON.stringify(expectedConstraints))throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  const layout=(await db.query<{relation:string;column:string;type:string;not_null:boolean;default_value:string|null;identity:string;generated:string}>(`SELECT c.relname AS relation,a.attname AS column,a.atttypid::regtype::text AS type,
    a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attidentity AS identity,a.attgenerated AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid IN ('olos_delivery_ids.registry'::regclass,'olos_delivery_ids.counter'::regclass) AND a.attnum>0 AND NOT a.attisdropped`)).rows;
  const expectedLayout=[['counter','singleton','boolean',true,'true'],['counter','next_candidate','bigint',true,null],
    ['registry','internal_id','integer',true,null],['registry','state','text',true,null],['registry','owner_role','name',false,null],
    ['registry','binding','text',false,null],['registry','source_id','text',false,null],['registry','source_hash','text',false,null],
    ['registry','request_id','uuid',false,null],['registry','token','uuid',false,null],['registry','used_raw_id','bigint',false,null]];
  if(layout.some(c=>c.identity!==''||c.generated!=='')||JSON.stringify(layout.map(c=>JSON.stringify([c.relation,c.column,c.type,c.not_null,c.default_value])).sort())!==JSON.stringify(expectedLayout.map(c=>JSON.stringify(c)).sort()))throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  const tables=(await db.query<{relname:string;relkind:string;relrowsecurity:boolean;relforcerowsecurity:boolean;rules:boolean;triggers:boolean}>(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) rules,EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) triggers
    FROM pg_class c WHERE c.oid IN ('olos_delivery_ids.registry'::regclass,'olos_delivery_ids.counter'::regclass)`)).rows;
  if(tables.length!==2||tables.some(t=>t.relkind!=='r'||t.relrowsecurity||t.relforcerowsecurity||t.rules||t.triggers))throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  const indexes=(await db.query<{relation:string;valid:boolean;keys:string[]}>(`SELECT c.relname AS relation,
    i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL AS valid,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS keys
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE i.indisunique
    AND i.indrelid IN ('olos_delivery_ids.registry'::regclass,'olos_delivery_ids.counter'::regclass)`)).rows;
  const expected=['counter:singleton','registry:internal_id','registry:request_id','registry:token','registry:owner_role,binding,source_id'].sort();
  if(indexes.some(i=>!i.valid)||JSON.stringify(indexes.map(i=>i.relation+':'+i.keys.join(',')).sort())!==JSON.stringify(expected))throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  if(constraints.filter(c=>c.relation==='olos_delivery_ids.registry').length!==6||constraints.filter(c=>c.relation==='olos_delivery_ids.counter').length!==3)throw new SyncError('ALLOCATOR_CONTRACT_CHANGED');
  return createHash('sha256').update(JSON.stringify([functions,trigger,constraints])).digest('hex');
}
