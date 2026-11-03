import type { Client, PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import { quote } from '../schema.js';
export type DB=Client|PoolClient;
export interface Reference {table:string;column:string;catalog:unknown}
export async function dependencies(db:DB,local:boolean){
 const table='raw.olos_calls';
 const id=(await db.query(`SELECT attnum,attidentity FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2`,[table,local?'internal_id_olos':'raw_olos_call_id'])).rows[0];
 if(!id||!(local?['a','d']:['a']).includes(id.attidentity))throw new SyncError('IDENTITY_STRATEGY_INVALID');
 const meta=(await db.query(`SELECT c.oid::text,c.relkind,c.relrowsecurity,c.relowner::text,c.relacl::text,
 EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) AS inherited,
 EXISTS(SELECT 1 FROM pg_publication_tables WHERE schemaname='raw' AND tablename='olos_calls') AS published
 FROM pg_class c WHERE c.oid=$1::regclass`,[table])).rows[0];
 if(meta.relkind!=='r'||meta.relrowsecurity||meta.inherited||meta.published)throw new SyncError('IDENTITY_DEPENDENCY_REVIEW_REQUIRED');
 const rules=(await db.query(`SELECT DISTINCT r.ev_class::regclass::text AS relation FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid
 WHERE d.refobjid=$1::regclass AND d.classid='pg_rewrite'::regclass`,[table])).rows;
 if(rules.length)throw new SyncError('IDENTITY_DEPENDENCY_REVIEW_REQUIRED');
 const triggers=(await db.query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname`,[table])).rows;
 // Corporate schema validator separately checks the exact approved phone trigger/functions.
 if(local&&triggers.length)throw new SyncError('IDENTITY_DEPENDENCY_REVIEW_REQUIRED');
 const constraints=(await db.query(`SELECT oid::text,contype,conrelid::regclass::text AS relation,confrelid::text,
 convalidated,conkey,confkey,confupdtype,pg_get_constraintdef(oid) AS definition FROM pg_constraint
 WHERE conrelid=$1::regclass OR confrelid=$1::regclass ORDER BY oid`,[table])).rows;
 const refs:Reference[]=[];
 for(const c of constraints){
  if(c.contype!=='f')continue;
  // Outgoing FKs of the call row and references to any changing corporate field are not approved.
  if(c.relation===table||!c.convalidated||c.confkey?.length!==1||c.confkey[0]!==id.attnum||c.conkey?.length!==1||local&&c.confupdtype!=='c')throw new SyncError('IDENTITY_REFERENCE_INCOMPATIBLE');
  const child=(await db.query(`SELECT n.nspname,c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.oid=$1::regclass AND a.attnum=$2`,[c.relation,c.conkey[0]])).rows[0];
  const qualified=`${quote(child.nspname)}.${quote(child.relname)}`;
  if(local){
   const unsafe=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal) OR
    EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=$1::regclass) OR
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f' AND oid<>$2::oid) OR
    EXISTS(SELECT 1 FROM pg_class WHERE oid=$1::regclass AND (relrowsecurity OR relkind<>'r')) OR
    EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=$1::regclass OR inhparent=$1::regclass) OR
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c') OR
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND NOT attisdropped AND (attgenerated<>'' OR (attnum=$3 AND (attidentity='a' OR atttypid NOT IN ('int4'::regtype,'int8'::regtype))))) OR
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=$1::regclass) OR
    EXISTS(SELECT 1 FROM pg_publication_rel WHERE prrelid=$1::regclass) AS unsafe`,[qualified,c.oid,c.conkey[0]])).rows[0].unsafe;
   if(unsafe)throw new SyncError('IDENTITY_REFERENCE_INCOMPATIBLE');
   await db.query(`LOCK TABLE ${qualified} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
   const catalog={
    columns:(await db.query(`SELECT attname,atttypid::text,atttypmod,attidentity,attgenerated,attnotnull,attacl::text FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[qualified])).rows,
    indexes:(await db.query('SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid=$1::regclass ORDER BY indexrelid',[qualified])).rows,
    constraints:(await db.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY oid',[qualified])).rows,
   };
   refs.push({table:qualified,column:child.attname,catalog});
  }
 }
 const indexes=(await db.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='raw' AND tablename='olos_calls' ORDER BY indexname`)).rows;
 const attrs=(await db.query(`SELECT attname,atttypid::text,atttypmod,attnotnull,attacl::text FROM pg_attribute
 WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[table])).rows;
 let sequence:unknown=null;
 if(local){
  const name=(await db.query("SELECT pg_get_serial_sequence('raw.olos_calls','internal_id_olos') AS name")).rows[0].name;
  if(!name)throw new SyncError('IDENTITY_SEQUENCE_MISSING');
  // Name is obtained from the catalog, then resolved to individually quoted identifiers.
  const s=(await db.query(`SELECT n.nspname,c.relname,c.oid::text,c.relacl::text,c.relowner::text,s.seqtypid::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcycle
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.oid=$1::regclass`,[name])).rows[0];
  sequence={...s,...(await db.query(`SELECT last_value::text,is_called FROM ${quote(s.nspname)}.${quote(s.relname)}`)).rows[0]};
 }
 return {meta,attrs,constraints,triggers,indexes,sequence,refs,controls:local?await controlDependencies(db):null};
}
export async function referenceRows(db:DB,refs:Reference[],ids:string[]){
 const result=[];
 for(const ref of refs)result.push({ref,rows:(await db.query(`SELECT to_jsonb(r)::text AS row FROM ${ref.table} r
   WHERE ${quote(ref.column)}=ANY($1::bigint[]) ORDER BY to_jsonb(r)::text`,[ids])).rows.map(r=>r.row as string)});
 return result;
}

async function controlDependencies(db:DB){
 const allowed:Record<string,{changed:string[];definitions:string[]}>={
  'olos_http.records':{changed:['target_id'],definitions:['PRIMARY KEY (source_key, source_id)','UNIQUE (target_table, target_id)']},
  'olos_http.corporate_outbox':{changed:['target_id','payload','payload_hash'],definitions:[
   'PRIMARY KEY (source_key, source_id)','UNIQUE (target_id)',
   'FOREIGN KEY (source_key, source_id) REFERENCES olos_http.records(source_key, source_id)',
   "CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text))",
   "CHECK ((state = ANY (ARRAY['pending'::text, 'confirmed'::text])))",
   "CHECK ((origin = ANY (ARRAY['capture'::text, 'legacy_receipt'::text, 'legacy_backlog'::text])))",
   "CHECK (((state = 'confirmed'::text) = ((confirmed_at IS NOT NULL) AND (remote_raw_id IS NOT NULL))))",
  ]},
  'corporate_sync.receipts':{changed:['internal_id_olos','payload_hash'],definitions:['PRIMARY KEY (internal_id_olos)',"CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text))"]},
 };
 const result=[];
 for(const [table,spec] of Object.entries(allowed)){
  const constraints=(await db.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY oid',[table])).rows;
  if(constraints.length!==spec.definitions.length||constraints.some(c=>!spec.definitions.includes(c.definition)))throw new SyncError('IDENTITY_CONTROL_DEPENDENCY');
  const unsafe=(await db.query(`SELECT
   EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal) OR
   EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=$1::regclass) OR
   EXISTS(SELECT 1 FROM pg_class WHERE oid=$1::regclass AND (relrowsecurity OR relkind<>'r')) OR
   EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND NOT attisdropped AND attgenerated<>'') OR
   EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=$1::regclass OR inhparent=$1::regclass) OR
   EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=ANY(c.confkey)
     WHERE c.confrelid=$1::regclass AND a.attname=ANY($2::text[])) OR
   EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=$1::regclass AND (i.indexprs IS NOT NULL OR (i.indpred IS NOT NULL AND NOT (i.indrelid='olos_http.corporate_outbox'::regclass AND pg_get_expr(i.indpred,i.indrelid)=$3)) OR
     (i.indisunique AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)))) AS unsafe`,[table,spec.changed,"(state = 'pending'::text)"])).rows[0].unsafe;
  if(unsafe)throw new SyncError('IDENTITY_CONTROL_DEPENDENCY');
  result.push({table,constraints,
   columns:(await db.query(`SELECT attname,atttypid::text,atttypmod,attidentity,attnotnull,attacl::text FROM pg_attribute
    WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[table])).rows,
   indexes:(await db.query('SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid=$1::regclass ORDER BY indexrelid',[table])).rows,
  });
 }
 return result;
}
