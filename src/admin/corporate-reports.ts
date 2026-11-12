import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { WorkerError } from '../errors.js';
import { quote } from '../schema.js';
import { columns, digest, tma, identityColumns, type Row } from '../corporate-sync/mapping.js';
import type { ReportFormat } from './report-format.js';
import { countFields, reportPlaceholder, reportWhitespace, reportValidationKey, sealReportData, validateReportData,
  type ReportData, type ReportDay } from './report-snapshot.js';

export interface CorporateReportData extends ReportData {
  corporate_source:string;
  corporate_observed_at:string;
  operational:ReportData;
  quarantined:string|null;
}
export function isCorporateReport(data:ReportData):data is CorporateReportData {return 'operational' in data;}
const zeroDay=(day:string|null):ReportDay=>({...Object.fromEntries(countFields.map(f=>[f,'0'])),day,operator_ids:null,collected_today:'0'}) as ReportDay;
// A report-only proof domain. Does not change the delivery payload/hash contract.
// Lengths are UTF-8 byte lengths, matching PostgreSQL octet_length, with explicit NULLs.
export function reportRowProof(row:Row):string {
  return createHash('sha256').update(columns.map(c=>row[c]===null?'N':`${Buffer.byteLength(row[c]!)}:${row[c]}`).join('')).digest('hex');
}
function validateV2(input:unknown,binding:string):CorporateReportData {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new WorkerError('REPORT_SNAPSHOT_INVALID');
  const {corporate_source,corporate_observed_at,operational,quarantined,...core}=input as CorporateReportData;
  const data=validateReportData(core),local=validateReportData(operational);
  if(corporate_source!==binding||typeof corporate_observed_at!=='string'||!Number.isFinite(Date.parse(corporate_observed_at))||
    Date.parse(corporate_observed_at)<Date.parse(data.observed_at)-5000||data.observed_at!==local.observed_at||data.collection_date!==local.collection_date||
    (quarantined!==null&&(typeof quarantined!=='string'||!/^(0|[1-9][0-9]*)$/.test(quarantined)))||
    data.outbox_available||data.failed_reads!=='0'||data.today_calls!=='0'||data.days.some(d=>d.collected_today!=='0'))throw new WorkerError('REPORT_SNAPSHOT_INVALID');
  return {...data,corporate_source,corporate_observed_at,operational:local,quarantined};
}
export function corporateReportFormat(pool:Pool|undefined,binding:string,wallZone?:string):ReportFormat {
  const metadata=(data:ReportData)=>({aggregate_contract:'olos-admin-reports/v2',corporate_source:binding,
    calls:data.summary.calls,day_count:data.days.length,payload_bytes:Buffer.byteLength(JSON.stringify(data)),hash_algorithm:'sha256-canonical-json-v1'});
  return {version:2,name:'olos-admin-reports/v2',validate:input=>validateV2(input,binding),metadata,
    validMetadata:(input,data)=>reportValidationKey(input)===reportValidationKey(metadata(data)),
    async collect(db,source,destination){
      if(!pool)throw new WorkerError('REPORT_CORPORATE_CONFIGURATION_REQUIRED');
      return collectCorporateReport(db,pool,source,destination,binding,wallZone);
    }};
}
async function collectOperational(db:PoolClient,source:string,target:string,wallZone:string|undefined) {
  const clock=(await db.query(`SELECT transaction_timestamp() AS observed_at,
    (transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS collection_date,
    to_regclass('olos_http.corporate_outbox') IS NOT NULL AS outbox,
    to_regclass('olos_http.corporate_collision_quarantine') IS NOT NULL AS quarantine,
    to_regclass($1) IS NOT NULL AS local_mapping`,[target])).rows[0];
  const hasOutbox=clock.outbox===true;
  // Frozen dates carry either an explicit Z or confirmed wall-clock semantics.
  // Malformed dates stay undated; they never acquire the date of collection.
  const frozenDate=hasOutbox?`CASE
    WHEN o.payload->>'data_ligacao' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$'
      AND pg_input_is_valid(o.payload->>'data_ligacao','timestamp with time zone')
      THEN ((o.payload->>'data_ligacao')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
    WHEN $3::text IS NOT NULL AND o.payload->>'data_ligacao' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}$'
      AND pg_input_is_valid(o.payload->>'data_ligacao','timestamp without time zone')
      THEN (((o.payload->>'data_ligacao')::timestamp AT TIME ZONE $3) AT TIME ZONE 'America/Sao_Paulo')::date END`:"CASE WHEN $3::text IS NULL THEN NULL::date ELSE NULL::date END";
  const fallback=clock.local_mapping?"(d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date":"NULL::date";
  const date=hasOutbox?`CASE WHEN o.source_id IS NULL THEN ${fallback} ELSE ${frozenDate} END`:`CASE WHEN $3::text IS NULL THEN ${fallback} ELSE ${fallback} END`;
  const state=hasOutbox?`CASE WHEN o.source_id IS NULL THEN 'not_queued'
    WHEN o.target_id<>r.target_id OR o.source_hash<>r.source_hash THEN 'inconsistent'
    WHEN o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN o.state='pending' AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL THEN 'pending'
    ELSE 'inconsistent' END`:"'unavailable'";
  const rows=(await db.query(`WITH local_calls AS (
    SELECT ${date} AS day,${state} AS delivery,${clock.local_mapping?'d.internal_id_olos IS NOT NULL':'false'} AS mapped,
      r.created_at>=($4::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND r.created_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS today
    FROM olos_http.records r ${hasOutbox?'LEFT JOIN olos_http.corporate_outbox o USING(source_key,source_id)':''}
      ${clock.local_mapping?`LEFT JOIN ${target} d ON d.internal_id_olos=r.target_id`:''}
    WHERE r.source_key=$1 AND r.target_table=$2
  ) SELECT day::text,count(*)::text AS calls,count(*) FILTER(WHERE today)::text AS collected_today,
    count(*) FILTER(WHERE delivery='confirmed')::text AS confirmed,count(*) FILTER(WHERE delivery='pending')::text AS pending,
    count(*) FILTER(WHERE delivery='not_queued')::text AS not_queued,count(*) FILTER(WHERE delivery='inconsistent')::text AS inconsistent,
    count(*) FILTER(WHERE NOT mapped)::text AS missing_mapping
    FROM local_calls GROUP BY day ORDER BY day`,[source,target,wallZone??null,clock.collection_date])).rows;
  const days=rows.map(r=>({...zeroDay(r.day),...r}));
  const failed=(await db.query('SELECT count(*)::text AS n FROM olos_http.reads WHERE source_key=$1 AND error_code IS NOT NULL',[source])).rows[0].n;
  const quarantined=clock.quarantine?(await db.query('SELECT count(*)::text AS n FROM olos_http.corporate_collision_quarantine WHERE source_key=$1',[source])).rows[0].n:null;
  return {data:sealReportData({days,failed_reads:failed,observed_at:clock.observed_at.toISOString(),collection_date:clock.collection_date,outbox_available:hasOutbox}),quarantined};
}
async function identityProofs(db:PoolClient,source:string,target:string,outbox:boolean,ids:string[],wall:boolean,wallZone?:string) {
  if(!ids.length)return [];
  const rows=outbox?(await db.query(`SELECT o.remote_raw_id::text AS raw_id,o.target_id::text AS target_id,r.agent_id,o.payload,o.payload_hash
    FROM olos_http.corporate_outbox o JOIN olos_http.records r USING(source_key,source_id)
    WHERE r.source_key=$1 AND r.target_table=$2 AND o.target_id=r.target_id AND o.source_hash=r.source_hash
      AND o.target_id=ANY($3::bigint[]) AND (
        (o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL) OR
        (o.state IN ('pending','skipped') AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL))`,[source,target,ids])).rows:[];
  const seen=new Set<string>();
  const proofs=rows.map(r=>{
    if(r.raw_id!==null){if(seen.has(r.raw_id))throw new WorkerError('REPORT_IDENTITY_AMBIGUOUS');seen.add(r.raw_id);}
    if(!r.payload||Object.keys(r.payload).sort().join(',')!==[...columns].sort().join(',')||
      columns.some(c=>r.payload[c]!==null&&typeof r.payload[c]!=='string')||r.payload.internal_id_olos!==r.target_id||digest(r.payload)!==r.payload_hash)
      throw new WorkerError('REPORT_LOCAL_PAYLOAD_INVALID');
    return {raw_id:r.raw_id,target_id:r.target_id,agent_id:r.agent_id,row_proof:reportRowProof(r.payload)};
  });
  // The legacy report could identify mapped local records without an outbox.
  // Preserve that possibility only after an exact canonical payload comparison.
  if((await db.query('SELECT to_regclass($1) IS NOT NULL AS present',[target])).rows[0].present){
    const time=wall?'d.data_ligacao AT TIME ZONE $4':"d.data_ligacao AT TIME ZONE 'UTC'";
    const projection=columns.map(c=>c==='data_ligacao'?`to_char(${time},'YYYY-MM-DD"T"HH24:MI:SS.US${wall?'':'"Z"'}') AS data_ligacao`:`d.${quote(c)}::text AS ${quote(c)}`).join(',');
    const legacy=(await db.query(`SELECT r.agent_id,${projection} FROM olos_http.records r JOIN ${target} d ON d.internal_id_olos=r.target_id
      ${outbox?'LEFT JOIN olos_http.corporate_outbox o USING(source_key,source_id)':''}
      WHERE r.source_key=$1 AND r.target_table=$2 AND r.target_id=ANY($3::bigint[]) ${outbox?'AND o.source_id IS NULL':''}`,
      wall?[source,target,ids,wallZone]:[source,target,ids])).rows;
    for(const row of legacy){
      const payload=Object.fromEntries(columns.map(c=>[c,row[c]])) as Row;
      if(identityColumns.some(c=>typeof payload[c]!=='string'||!payload[c]!.trim()))continue;
      try{if(payload.tma_origem!==null)payload.tma_origem=tma(payload.tma_origem,{tmaPolicy:'round-half-away',tmaConfirmed:true});}
      catch{continue;} // No safe equivalence; do not attribute AgentId.
      proofs.push({raw_id:null,target_id:payload.internal_id_olos!,agent_id:row.agent_id,row_proof:reportRowProof(payload)});
    }
  }
  return proofs;
}

async function collectCorporateReport(local:PoolClient,pool:Pool,source:string,destination:{schema:string;table:string},binding:string,wallZone?:string):Promise<CorporateReportData> {
  const operational=await collectOperational(local,source,`${quote(destination.schema)}.${quote(destination.table)}`,wallZone);
  let db:PoolClient;
  try{db=await pool.connect();}catch{throw new WorkerError('REPORT_CORPORATE_UNAVAILABLE');}
  let lost=false,released=false,timedOut=false;
  const onError=()=>{lost=true;};db.on('error',onError);
  const timer=setTimeout(()=>{timedOut=true;lost=true;released=true;db.release(true);},30_000);timer.unref();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='25s'");await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    await db.query("SET LOCAL timezone='UTC'");await db.query("SET LOCAL datestyle='ISO,YMD'");
    await db.query('SET LOCAL jit=off');await db.query("SET LOCAL work_mem='16MB'");
    await db.query('SET LOCAL max_parallel_workers_per_gather=1');
    await db.query("SET LOCAL temp_file_limit='768MB'");
    const meta=(await db.query(`SELECT c.relkind,c.relrowsecurity,c.relforcerowsecurity,
      EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indrelid=c.oid AND i.indisprimary AND i.indisvalid AND i.indisunique AND i.indimmediate AND i.indnkeyatts=1 AND a.attname='raw_olos_call_id') AS primary_key,
      EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indrelid=c.oid AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND i.indnkeyatts=1
          AND a.attname='internal_id_olos' AND (i.indpred IS NULL OR pg_get_expr(i.indpred,i.indrelid)='(internal_id_olos IS NOT NULL)')) AS unique_internal_id
      FROM pg_class c WHERE c.oid=to_regclass('raw.olos_calls')`)).rows[0];
    const shape=(await db.query(`SELECT attname,atttypid::regtype::text AS type FROM pg_attribute
      WHERE attrelid='raw.olos_calls'::regclass AND attnum>0 AND NOT attisdropped`)).rows;
    const type=(name:string)=>shape.find(c=>c.attname===name)?.type;
    if(!meta||meta.relkind!=='r'||meta.relrowsecurity||meta.relforcerowsecurity||!meta.primary_key||!meta.unique_internal_id||
      !['integer','bigint'].includes(type('internal_id_olos'))||type('raw_olos_call_id')!=='bigint'||
      !['timestamp with time zone','timestamp without time zone'].includes(type('data_ligacao'))||
      columns.some(c=>!type(c)))throw new WorkerError('REPORT_CORPORATE_SCHEMA_INVALID');
    const wall=type('data_ligacao')==='timestamp without time zone';
    if(wall&&!wallZone)throw new WorkerError('REPORT_TIMESTAMP_SEMANTICS_REQUIRED');
    if(wallZone&&!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[wallZone])).rowCount)throw new WorkerError('REPORT_TIMESTAMP_ZONE_INVALID');
    // Restrict local proof lookup to IDs actually visible in this corporate
    // snapshot. This prevents multi-million skipped local rows becoming a payload.
    const ids=(await db.query('SELECT internal_id_olos::text AS id FROM raw.olos_calls WHERE internal_id_olos IS NOT NULL')).rows.map(r=>r.id as string);
    const proofs=JSON.stringify(await identityProofs(local,source,`${quote(destination.schema)}.${quote(destination.table)}`,operational.data.outbox_available,ids,wall,wallZone));
    if(Buffer.byteLength(proofs)>32*1024*1024)throw new WorkerError('REPORT_IDENTITY_PROOFS_TOO_LARGE');
    const time=wall?'d.data_ligacao':"d.data_ligacao AT TIME ZONE 'UTC'";
    const canonical=columns.map(c=>c==='data_ligacao'?`to_char(${time},'YYYY-MM-DD"T"HH24:MI:SS.US${wall?'':'"Z"'}')`:`d.${quote(c)}::text`);
    const proof=canonical.map(c=>`CASE WHEN (${c}) IS NULL THEN 'N' ELSE octet_length(${c})::text||':'||(${c}) END`).join('||');
    const day=wall?"((d.data_ligacao AT TIME ZONE $4) AT TIME ZONE 'America/Sao_Paulo')::date":"(d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date";
    // Count physical corporate rows, including NULL internal IDs. Source proofs
    // are evidence for AgentId only; they never gate corporate totals/CPF/e-mail.
    const days=(await db.query(`WITH proofs AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(raw_id bigint,target_id integer,agent_id text,row_proof text)
    ), per_identity AS (
      SELECT ${day} AS day,p.agent_id,btrim(d.nome_agente,$2) AS agent_name,
        count(*) AS calls,count(*) FILTER(WHERE coalesce(btrim(d.cpf,$2)<>'',false)) AS with_cpf,
        count(*) FILTER(WHERE coalesce(btrim(d.email,$2)<>'',false)) AS with_email,
        count(*) FILTER(WHERE p.target_id IS NULL) AS missing_mapping
      FROM raw.olos_calls d LEFT JOIN proofs p ON (p.raw_id IS NULL OR p.raw_id=d.raw_olos_call_id) AND p.target_id=d.internal_id_olos
        AND p.row_proof=encode(sha256(convert_to(${proof},'UTF8')),'hex')
      GROUP BY day,p.agent_id,agent_name
    ), per_operator AS (
      SELECT day,CASE WHEN agent_id ~ '^[1-9][0-9]*$' AND agent_name<>'' AND agent_name !~* $3 THEN agent_id END AS operator_id,
        sum(calls) AS calls,sum(with_cpf) AS with_cpf,sum(with_email) AS with_email,sum(missing_mapping) AS missing_mapping
      FROM per_identity GROUP BY day,operator_id
    ) SELECT day::text,sum(calls)::text AS calls,
      coalesce(sum(calls) FILTER(WHERE operator_id IS NOT NULL),0)::text AS identified_calls,
      array_agg(operator_id ORDER BY operator_id) FILTER(WHERE operator_id IS NOT NULL) AS operator_ids,
      sum(with_cpf)::text AS with_cpf,sum(with_email)::text AS with_email,sum(missing_mapping)::text AS missing_mapping
    FROM per_operator GROUP BY day ORDER BY day`,wall?[proofs,reportWhitespace,reportPlaceholder,wallZone]:[proofs,reportWhitespace,reportPlaceholder])).rows.map(r=>({...zeroDay(r.day),...r}));
    const corporateObserved=(await db.query('SELECT transaction_timestamp() AS observed_at')).rows[0].observed_at.toISOString();
    if(timedOut)throw new WorkerError('REPORT_CORPORATE_TIMEOUT');
    // No corporate writes, including temp tables, sequences or migrations.
    await db.query('ROLLBACK');
    return {...sealReportData({days,failed_reads:'0',outbox_available:false,observed_at:operational.data.observed_at,collection_date:operational.data.collection_date}),
      corporate_source:binding,corporate_observed_at:corporateObserved,operational:operational.data,quarantined:operational.quarantined};
  } catch(error) {
    if(timedOut)throw new WorkerError('REPORT_CORPORATE_TIMEOUT');
    if(error instanceof WorkerError)throw error;
    const code=(error as {code?:string}).code;
    if(code==='57014')throw new WorkerError('REPORT_CORPORATE_TIMEOUT');
    if(code==='42501')throw new WorkerError('REPORT_CORPORATE_PERMISSION_REQUIRED');
    throw new WorkerError('REPORT_CORPORATE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    if(!released){await db.query('ROLLBACK').catch(()=>{lost=true;});released=true;db.release(lost);}
    db.removeListener('error',onError);
  }
}
