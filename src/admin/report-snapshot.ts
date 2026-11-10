import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { WorkerError } from '../errors.js';
import { quote } from '../schema.js';

export const reportZone = 'America/Sao_Paulo';
// Display-only policy. Keep parity with positive canonical AgentId + identified name;
// this module neither admits delivery nor rewrites mapped values.
export const reportWhitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export const reportPlaceholder = '^([0-9]+|-1|null|undefined|n/a|unknown|desconhecido|sem operador|sem agente|não identificado|nao identificado)$';
export const reportContractVersion = 1;
export const reportContract=`olos-admin-reports/v${reportContractVersion}`;
export const reportCacheSeconds = 300;
export const reportMaxAgeSeconds = 900;
export const reportRefreshSeconds = 240;
export const reportPayloadLimit = 16 * 1024 * 1024;
export const countFields = ['calls','identified_calls','with_cpf','with_email','confirmed','pending','not_queued','inconsistent','missing_mapping'] as const;
export type CountField = typeof countFields[number];
export type ReportDay = Record<CountField,string> & {day:string|null;operator_ids:string[]|null;collected_today:string};
export type ReportTotals = Record<Exclude<CountField,'missing_mapping'>,string|null> & {operators:string};
export type ReportSummary = ReportTotals & {undated:string;missing_mapping:string};
export interface ReportData {days:ReportDay[];failed_reads:string;observed_at:string;outbox_available:boolean;collection_date:string;summary:ReportSummary;today_calls:string}
export type ReportInput = Omit<ReportData,'summary'|'today_calls'>;
export const sumReport = (days:ReportDay[],field:CountField) => days.reduce((n,d)=>n+BigInt(d[field]),0n).toString();
export function totalReport(days:ReportDay[],outbox:boolean):ReportTotals {
  // Each validated day already contains unique IDs. Only multi-day periods
  // need a union; rebuilding one Set per day per HTTP response allocates heavily.
  let operators:string;
  if(days.length===1)operators=String(days[0]!.operator_ids?.length??0);
  else{const union=new Set<string>();for(const day of days)for(const id of day.operator_ids??[])union.add(id);operators=String(union.size);}
  const counts=Object.fromEntries(countFields.filter(f=>f!=='missing_mapping').map(f=>[f,
    !outbox&&['confirmed','pending','not_queued','inconsistent'].includes(f)?null:sumReport(days,f)]));
  return {...counts,operators} as ReportTotals;
}
export function sealReportData(input:ReportInput):ReportData {
  return {...input,summary:{...totalReport(input.days,input.outbox_available),undated:input.days.find(d=>d.day===null)?.calls??'0',missing_mapping:sumReport(input.days,'missing_mapping')},
    today_calls:input.days.reduce((n,d)=>n+BigInt(d.collected_today),0n).toString()};
}

export async function collectReportSnapshot(db:PoolClient,source:string,destination:{schema:string;table:string}):Promise<ReportData> {
      const clock = (await db.query(`SELECT to_regclass('olos_http.corporate_outbox') IS NOT NULL AS present,
        (transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS collection_date,
        ((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS start_at,
        (((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS end_at`)).rows[0];
      const hasOutbox = clock.present === true;
      const relation = `${quote(destination.schema)}.${quote(destination.table)}`;
      const delivery = hasOutbox ? `CASE WHEN o.source_id IS NULL THEN 'not_queued'
        WHEN o.target_id<>r.target_id OR o.source_hash<>r.source_hash THEN 'inconsistent'
        WHEN o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL THEN 'confirmed'
        WHEN o.state='pending' AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL THEN 'pending'
        ELSE 'inconsistent' END` : "'unavailable'::text";
      // Aggregate equivalent day/ID/name/receipt groups before running regexes.
      // Names are used only in SQL; the original identification rule is applied
      // to every distinct identity, then unidentified identities collapse together.
      // Delivery is classified once per row. No per-call CTE materialization or
      // DISTINCT sort; only aggregate rows reach the process.
      const days = (await db.query<ReportDay>(`WITH classified AS NOT MATERIALIZED (
        SELECT (d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          r.agent_id, btrim(d.nome_agente,$2) AS agent_name,
          r.created_at >= $5::timestamptz AND r.created_at < $6::timestamptz AS collected_today,
          d.internal_id_olos IS NOT NULL AS mapped,
          coalesce(btrim(d.cpf,$2)<>'',false) AS has_cpf,
          coalesce(btrim(d.email,$2)<>'',false) AS has_email, ${delivery} AS delivery
        FROM olos_http.records r LEFT JOIN ${relation} d ON d.internal_id_olos=r.target_id
        ${hasOutbox ? 'LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id' : ''}
        WHERE r.source_key=$1 AND r.target_table=$4
      ), per_identity AS (
        SELECT day, agent_id, agent_name, delivery, count(*) AS calls,
          count(*) FILTER (WHERE collected_today) AS collected_today,
          count(*) FILTER (WHERE has_cpf) AS with_cpf,
          count(*) FILTER (WHERE has_email) AS with_email,
          count(*) FILTER (WHERE NOT mapped) AS missing_mapping
        FROM classified GROUP BY day, agent_id, agent_name, delivery
      ), per_operator AS (
        SELECT day, CASE WHEN agent_id ~ '^[1-9][0-9]*$' AND agent_name<>''
          AND agent_name !~* $3 THEN agent_id END AS identified_agent, sum(calls) AS calls,
          sum(collected_today) AS collected_today,
          sum(with_cpf) AS with_cpf, sum(with_email) AS with_email,
          coalesce(sum(calls) FILTER (WHERE delivery='confirmed'),0) AS confirmed,
          coalesce(sum(calls) FILTER (WHERE delivery='pending'),0) AS pending,
          coalesce(sum(calls) FILTER (WHERE delivery='not_queued'),0) AS not_queued,
          coalesce(sum(calls) FILTER (WHERE delivery='inconsistent'),0) AS inconsistent,
          sum(missing_mapping) AS missing_mapping
        FROM per_identity GROUP BY day, identified_agent
      ) SELECT day::text,
        sum(calls)::text AS calls, sum(collected_today)::text AS collected_today,
        coalesce(sum(calls) FILTER (WHERE identified_agent IS NOT NULL),0)::text AS identified_calls,
        array_agg(identified_agent) FILTER (WHERE identified_agent IS NOT NULL) AS operator_ids,
        sum(with_cpf)::text AS with_cpf, sum(with_email)::text AS with_email,
        sum(confirmed)::text AS confirmed, sum(pending)::text AS pending,
        sum(not_queued)::text AS not_queued, sum(inconsistent)::text AS inconsistent,
        sum(missing_mapping)::text AS missing_mapping
      FROM per_operator GROUP BY day ORDER BY day`, [source, reportWhitespace, reportPlaceholder, relation, clock.start_at, clock.end_at])).rows;
      const meta = (await db.query(`SELECT count(*)::text AS failed_reads,
        transaction_timestamp() AS observed_at FROM olos_http.reads
        WHERE source_key=$1 AND error_code IS NOT NULL`, [source])).rows[0];
      return sealReportData({ days, ...meta, observed_at: meta.observed_at.toISOString(), outbox_available: hasOutbox, collection_date: clock.collection_date });
}

const operatorIdPattern=/^[1-9][0-9]*$/;
const invalid = () => new WorkerError('REPORT_SNAPSHOT_INVALID');
const integer = (value:unknown):value is string => typeof value==='string' && /^(0|[1-9][0-9]*)$/.test(value);
const calendar = (value:unknown):value is string => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value,{zone:reportZone}).isValid;
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  return value as Record<string,unknown>;
}
function exactKeys(value:Record<string,unknown>,keys:string[]) {
  if(Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw invalid();
}
// Strict allowlist: snapshots never contain names, contacts, source payloads or receipts.
export function validateReportData(input:unknown):ReportData {
  const value=object(input);
  exactKeys(value,['days','failed_reads','observed_at','outbox_available','collection_date','summary','today_calls']);
  if(!Array.isArray(value.days)||!integer(value.failed_reads)||typeof value.observed_at!=='string'||
    !Number.isFinite(Date.parse(value.observed_at))||!calendar(value.collection_date)||DateTime.fromISO(value.observed_at).setZone(reportZone).toISODate()!==value.collection_date||typeof value.outbox_available!=='boolean'||!integer(value.today_calls))throw invalid();
  const seen=new Set<string|null>();
  const days:ReportDay[]=value.days.map(raw=>{
    const d=object(raw);exactKeys(d,[...countFields,'day','operator_ids','collected_today']);
    if((d.day!==null&&!calendar(d.day))||seen.has(d.day as string|null))throw invalid();
    seen.add(d.day as string|null);
    for(const field of [...countFields,'collected_today'])if(!integer(d[field]))throw invalid();
    if(d.operator_ids!==null&&(!Array.isArray(d.operator_ids)||!d.operator_ids.every(id=>typeof id==='string'&&operatorIdPattern.test(id))||new Set(d.operator_ids).size!==d.operator_ids.length))throw invalid();
    const day=d as ReportDay, calls=BigInt(day.calls);
    for(const field of [...countFields,'collected_today'] as const)if(BigInt(day[field])>calls)throw invalid();
    if((BigInt(day.identified_calls)>0n&&!(day.operator_ids?.length))||BigInt(day.operator_ids?.length??0)>BigInt(day.identified_calls))throw invalid();
    const delivery=['confirmed','pending','not_queued','inconsistent'].reduce((n,f)=>n+BigInt(d[f] as string),0n);
    if(delivery!==(value.outbox_available?calls:0n))throw invalid();
    return day;
  });
  const sealed=sealReportData({days,failed_reads:value.failed_reads,observed_at:value.observed_at,outbox_available:value.outbox_available,collection_date:value.collection_date});
  // Rebuild in a fixed field order so JSONB object-key ordering cannot change hashes.
  if(canonical(object(sealed.summary))!==canonical(object(value.summary))||sealed.today_calls!==value.today_calls)throw invalid();
  return sealed;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function reportDataHash(data:ReportData):string {return createHash('sha256').update(canonical(data)).digest('hex');}

export function reportValidationMetadata(data:ReportData) {
  return {aggregate_contract:reportContract,day_count:data.days.length,calls:data.summary.calls,payload_bytes:Buffer.byteLength(JSON.stringify(data)),hash_algorithm:'sha256-canonical-json-v1'};
}
export function validReportMetadata(value:unknown,data:ReportData):boolean {
  return canonical(value)===canonical(reportValidationMetadata(data));
}

export const reportValidationKey=(value:unknown)=>canonical(value);
