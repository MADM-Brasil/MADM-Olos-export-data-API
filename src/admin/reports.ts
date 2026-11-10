import type { Pool, PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { WorkerError } from '../errors.js';
import { quote } from '../schema.js';
import { reportCacheSeconds, reportMaxAgeSeconds, reportContractVersion, reportZone, reportPayloadLimit, reportContract,
  totalReport, validateReportData, reportDataHash, validReportMetadata, reportValidationKey, type ReportData } from './report-snapshot.js';
export { reportWhitespace, reportPlaceholder, reportCacheSeconds, reportZone } from './report-snapshot.js';
export const reportStatementTimeoutMs = 5_000;
export const reportReadCacheMs = 1_000;
export const reportReadWallTimeoutMs = 5_000;
export const todayRefreshIntervalMs = 60_000;
export const todayStatementTimeoutMs = 1_000;
export const todayWallTimeoutMs = 2_000;
export interface TodayObservation {
  date:string;calls:string;observed_at:string;timezone:string;cache_seconds:number;
  time_basis:string;identity:string;observation_source:'local_records';
}
export function reportRange(from:unknown,to:unknown) {
  const parse=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?DateTime.fromISO(value,{zone:reportZone}):DateTime.invalid('date');
  const start=parse(from),end=parse(to);
  if(!start.isValid||!end.isValid||end<start||end.diff(start,'days').days>=366)throw new WorkerError('REPORT_PERIOD_INVALID');
  return {from:start.toISODate()!,to:end.toISODate()!};
}
interface Published {data:ReportData;id:string;published_at:string;checked_at:number;loaded_at:number;age:number;refresh_state:string;last_refresh_error:string|null;next_refresh_at:string|null;data_hash:string;validation_key:string}
interface StoredRow {
  id:string|null;published_id:string|null;contract_version:number|null;contract_name:string|null;timezone:string|null;data:unknown;
  observed_at:Date|null;published_at:Date|null;collection_date:string|null;data_hash:string|null;
  checked_at:Date;incompatible:boolean;payload_bytes:number;validation:unknown;refresh_status:string;last_error:string|null;next_attempt_at:Date|null;
}
// HTTP only reads a published key. It has no historical query or refresh fallback.
export class AdminReports {
  private cached:Published|undefined;
  private pending:Promise<Published>|undefined;
  private failure:{at:number;error:unknown}|undefined;
  private todayPending:Promise<TodayObservation>|undefined;
  private todayNext=Number.NEGATIVE_INFINITY;
  constructor(private readonly pool:Pool,private readonly source:string,
    private readonly destination:{schema:string;table:string},private readonly now:()=>number=()=>performance.now()) {}
  async read(from:unknown,to:unknown):Promise<unknown> {
    const range=reportRange(from,to),s=await this.snapshot();
    const daily=s.data.days.filter(d=>d.day!==null&&d.day>=range.from&&d.day<=range.to);
    return {summary:{...s.data.summary},period:totalReport(daily,s.data.outbox_available),
      daily:daily.map(d=>({day:d.day,...totalReport([d],s.data.outbox_available)})),failed_reads:s.data.failed_reads,
      observed_at:s.data.observed_at,...range,timezone:reportZone,outbox_available:s.data.outbox_available,
      confirmation_source:'local_outbox_receipts',cache_seconds:reportCacheSeconds,...this.metadata(s)};
  }
  async today() {
    const s=await this.snapshot();
    if(s.data.collection_date!==this.databaseDay(s))throw new WorkerError('REPORT_SNAPSHOT_STALE');
    return {date:s.data.collection_date,calls:s.data.today_calls,observed_at:s.data.observed_at,timezone:reportZone,
      cache_seconds:reportCacheSeconds,time_basis:'first_local_persistence',identity:'source_key/source_id',...this.metadata(s)};
  }
  refreshToday():Promise<TodayObservation> {
    if(this.todayPending)return this.todayPending;
    if(this.now()<this.todayNext)return Promise.reject(new WorkerError('REPORT_TODAY_RATE_LIMITED'));
    // All sessions of the single source-owning Admin share this admission gate,
    // including failures. The transaction lock also excludes other processes.
    this.todayNext=this.now()+todayRefreshIntervalMs;
    this.todayPending=this.countToday().finally(()=>{this.todayPending=undefined;});
    return this.todayPending;
  }
  private async countToday():Promise<TodayObservation> {
    let db:PoolClient|undefined,released=false,discard=false,timedOut=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const onError=()=>{discard=true;};
    try{
      db=await this.pool.connect();db.on('error',onError);
      timer=setTimeout(()=>{timedOut=true;discard=true;if(db&&!released){released=true;db.release(true);}},todayWallTimeoutMs);timer.unref();
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query(`SET LOCAL statement_timeout='${todayStatementTimeoutMs}ms'`);
      await db.query("SET LOCAL lock_timeout='100ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='3s'");
      await db.query('SET LOCAL max_parallel_workers_per_gather=0');
      await db.query("SET LOCAL work_mem='1MB'");
      await db.query('SET LOCAL jit=off');
      const lock=await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`olos-today-refresh:${this.source}`]);
      if(!lock.rows[0]?.acquired)throw new WorkerError('REPORT_TODAY_BUSY');
      // Match snapshot first-persistence semantics. Bind precomputed boundaries:
      // timezone conversion in the records predicate would repeat per row.
      const clock=(await db.query(`SELECT transaction_timestamp() AS observed_at,
        (transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS date,
        ((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS start_at,
        (((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS end_at`)).rows[0];
      const row=(await db.query(`SELECT count(*)::text AS calls FROM olos_http.records
        WHERE source_key=$1 AND target_table=$2 AND created_at>=$3::timestamptz AND created_at<$4::timestamptz`,
        [this.source,`${quote(this.destination.schema)}.${quote(this.destination.table)}`,clock.start_at,clock.end_at])).rows[0];
      if(timedOut)throw new WorkerError('REPORT_TODAY_TIMEOUT');
      if(typeof row?.calls!=='string'||!/^(0|[1-9][0-9]*)$/.test(row.calls))throw new WorkerError('REPORT_TODAY_UNAVAILABLE');
      return {date:clock.date,calls:row.calls,observed_at:clock.observed_at.toISOString(),timezone:reportZone,
        cache_seconds:reportCacheSeconds,time_basis:'first_local_persistence',identity:'source_key/source_id',observation_source:'local_records'};
    }catch(error){
      if(timedOut||(error as {code?:string}).code==='57014')throw new WorkerError('REPORT_TODAY_TIMEOUT');
      if(error instanceof WorkerError)throw error;
      discard=true;throw new WorkerError('REPORT_TODAY_UNAVAILABLE');
    }finally{
      if(db){if(!released)await db.query('ROLLBACK').catch(()=>{discard=true;});if(!released){released=true;db.release(discard);}db.removeListener('error',onError);}
      if(timer)clearTimeout(timer);
    }
  }
  private age(s:Published) {return s.age+Math.max(0,this.now()-s.loaded_at)/1000;}
  private databaseDay(s:Published) {return DateTime.fromMillis(s.checked_at+Math.max(0,this.now()-s.loaded_at)).setZone(reportZone).toISODate();}
  private metadata(s:Published) {
    const age=this.age(s);
    return {snapshot_id:s.id,snapshot_contract_version:reportContractVersion,published_at:s.published_at,
      snapshot_state:age>reportCacheSeconds||s.data.collection_date!==this.databaseDay(s)?'STALE':'READY',snapshot_age_seconds:Math.max(0,Math.floor(age)),refresh_state:s.refresh_state,last_refresh_error:s.last_refresh_error,next_refresh_at:s.next_refresh_at};
  }
  private fresh(s:Published) {
    if(this.age(s)>reportMaxAgeSeconds)throw new WorkerError('REPORT_SNAPSHOT_STALE');
    return s;
  }
  private async snapshot():Promise<Published> {
    if(this.cached&&this.now()-this.cached.loaded_at<reportReadCacheMs)return this.fresh(this.cached);
    if(this.failure&&this.now()-this.failure.at<reportReadCacheMs)throw this.failure.error;
    if(!this.pending)this.pending=this.query().then(value=>{this.cached=value;this.failure=undefined;return value;},error=>{
      this.failure={at:this.now(),error};throw error;
    }).finally(()=>{this.pending=undefined;});
    return this.fresh(await this.pending);
  }
  private async query():Promise<Published> {
    let db:PoolClient|undefined,discard=false,released=false,timedOut=false;const onError=()=>{discard=true;};
    let watchdog:ReturnType<typeof setTimeout>|undefined;
    try {
      db=await this.pool.connect();db.on('error',onError);
      watchdog=setTimeout(()=>{timedOut=true;discard=true;if(db&&!released){released=true;db.release(true);}},reportReadWallTimeoutMs);watchdog.unref();
      await db.query('BEGIN READ ONLY');
      await db.query(`SET LOCAL statement_timeout='${reportStatementTimeoutMs}ms'`);
      await db.query("SET LOCAL lock_timeout='250ms'");
      // Revalidate the durable pointer each second; immutable payloads need
      // decoding only on the first read or when a new generation is published.
      const known=this.cached;
      const queryStarted=this.now();
      const row=(await db.query<StoredRow>(`SELECT s.id,k.published_id,s.contract_version,s.contract_name,s.timezone,s.validation,k.status AS refresh_status,k.last_error,
        CASE WHEN isfinite(k.next_attempt_at) THEN k.next_attempt_at END AS next_attempt_at,
        CASE WHEN s.id IS DISTINCT FROM $5::uuid THEN CASE WHEN octet_length(s.data::text)<=$4 THEN s.data END END AS data,
        CASE WHEN s.id IS DISTINCT FROM $5::uuid THEN octet_length(s.data::text) ELSE 0 END AS payload_bytes,s.observed_at,s.published_at,s.collection_date::text,s.data_hash,
        clock_timestamp() AS checked_at,
        EXISTS(SELECT 1 FROM olos_http.report_snapshots other WHERE other.source_key=$1 AND other.target_table=$2 AND other.contract_version<>$3) AS incompatible
        FROM (SELECT $1::text AS source_key,$2::text AS target_table,$3::int AS contract_version) wanted
        LEFT JOIN olos_http.report_snapshot_state k USING(source_key,target_table,contract_version)
        LEFT JOIN olos_http.report_snapshots s ON s.id=k.published_id AND s.source_key=$1 AND s.target_table=$2 AND s.contract_version=$3`,
        [this.source,`${quote(this.destination.schema)}.${quote(this.destination.table)}`,reportContractVersion,reportPayloadLimit,known?.id??null])).rows[0];
      if(timedOut)throw new WorkerError('REPORT_TIMEOUT');
      if(!row)throw new WorkerError('REPORT_SNAPSHOT_INVALID');
      if(!row.published_id)throw new WorkerError(row.incompatible?'REPORT_SNAPSHOT_INCOMPATIBLE':'REPORT_INITIALIZING');
      if(!row.id||row.contract_version!==reportContractVersion||row.contract_name!==reportContract||row.timezone!==reportZone||!row.observed_at||!row.published_at||row.payload_bytes>reportPayloadLimit)throw new WorkerError('REPORT_SNAPSHOT_INVALID');
      const same=known?.id===row.id;
      if(same&&(row.data_hash!==known.data_hash||reportValidationKey(row.validation)!==known.validation_key||row.published_at.toISOString()!==known.published_at))throw new WorkerError('REPORT_SNAPSHOT_INVALID');
      const data=same?known.data:validateReportData(row.data),age=(row.checked_at.getTime()-row.observed_at.getTime())/1000;
      if((!same&&(!validReportMetadata(row.validation,data)||row.data_hash!==reportDataHash(data)))||data.observed_at!==row.observed_at.toISOString()||data.collection_date!==row.collection_date||age< -5||row.published_at<row.observed_at||row.published_at.getTime()>row.checked_at.getTime()+5000)throw new WorkerError('REPORT_SNAPSHOT_INVALID');
      return {data,id:row.id,published_at:row.published_at.toISOString(),age,checked_at:row.checked_at.getTime(),loaded_at:queryStarted,data_hash:row.data_hash!,validation_key:reportValidationKey(row.validation),refresh_state:row.refresh_status.toUpperCase(),last_refresh_error:row.last_error,next_refresh_at:row.next_attempt_at?.toISOString()??null};
    } catch(error) {
      if(timedOut)throw new WorkerError('REPORT_TIMEOUT');
      if(error instanceof WorkerError)throw error;
      const code=(error as {code?:string}).code;
      if(code==='42P01'||code==='42703')throw new WorkerError('REPORT_SNAPSHOT_MIGRATION_REQUIRED');
      if(code==='57014')throw new WorkerError('REPORT_TIMEOUT');
      discard=true;throw new WorkerError('REPORT_UNAVAILABLE');
    } finally {
      if(db){if(!released)await db.query('ROLLBACK').catch(()=>{discard=true;});if(!released){released=true;db.release(discard);}db.removeListener('error',onError);}
      if(watchdog)clearTimeout(watchdog);
    }
  }
}
