import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { WorkerError, log } from '../errors.js';
import { quote } from '../schema.js';
import { collectReportSnapshot, validateReportData, reportDataHash, reportContractVersion, reportZone,
  reportRefreshSeconds, reportPayloadLimit, reportValidationMetadata, reportContract } from './report-snapshot.js';
export const reportBuildTimeoutMs=30_000;
export const reportBuildWallTimeoutMs=40_000;
export function reportRetryMs(attempt:number) {return attempt>=3?300_000:attempt===2?60_000:30_000;}
interface RefreshResult {state:'published'|'not_due'|'busy'|'failed'|'commit_unknown'|'stopped';retry_ms:number;code?:string;snapshot_id?:string}
interface Active {db:PoolClient;released:boolean;lost:boolean;timedOut:boolean;onError:()=>void}
// One lifecycle/connection, independent of HTTP and cursor/scheduler ownership.
export class ReportUpdater {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private flight:Promise<RefreshResult>|undefined;
  private active:Active|undefined;
  private stopped=false;
  private started=false;
  private localFailures=0;
  private readonly target:string;
  private readonly key:unknown[];
  private readonly tag:string;
  constructor(private readonly pool:Pool,private readonly source:string,private readonly destination:{schema:string;table:string}) {
    this.target=`${quote(destination.schema)}.${quote(destination.table)}`;
    this.key=[source,this.target,reportContractVersion];
    this.tag=createHash('sha256').update(source+'\0'+this.target).digest('hex').slice(0,16);
  }
  start() {
    if(this.started||this.stopped)return;
    this.started=true;this.schedule(0);
  }
  private schedule(ms:number) {
    if(this.stopped)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.refreshOnce().then(r=>this.schedule(r.retry_ms),()=>{log('report_snapshot_failed',{error:'REPORT_BUILD_FAILED'});this.schedule(300_000);});},ms);
    this.timer.unref();
  }
  async stop() {
    this.stopped=true;
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    this.discardActive();
    await this.flight;
  }
  private discardActive() {
    if(this.active&&!this.active.released){this.active.released=true;this.active.db.release(true);}
  }
  refreshOnce():Promise<RefreshResult> {
    if(this.stopped)return Promise.resolve({state:'stopped',retry_ms:300_000});
    if(!this.flight)this.flight=this.refresh().finally(()=>{this.flight=undefined;});
    return this.flight;
  }
  private async refresh():Promise<RefreshResult> {
    const started=performance.now();let active:Active|undefined,locked=false,attempt=0,attemptId:string|undefined,commitIssued=false;
    let watchdog:ReturnType<typeof setTimeout>|undefined;
    let phase:'coordination'|'resources'|'collection'|'publication'='coordination';
    try {
      const db=await this.pool.connect();active={db,released:false,lost:false,timedOut:false,onError:()=>{if(active)active.lost=true;}};db.on('error',active.onError);this.active=active;
      watchdog=setTimeout(()=>{if(active)active.timedOut=true;this.discardActive();},reportBuildWallTimeoutMs);watchdog.unref();
      if(this.stopped)throw new WorkerError('REPORT_UPDATE_STOPPED');
      // Session lock precedes the repeatable-read snapshot. Source-wide across destinations/versions.
      locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[`olos-report-refresh:${this.source}`])).rows[0].acquired===true;
      if(!locked)return {state:'busy',retry_ms:30_000};
      await db.query(`INSERT INTO olos_http.report_snapshot_state(source_key,target_table,contract_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,this.key);
      attemptId=randomUUID();
      const claim=(await db.query(`UPDATE olos_http.report_snapshot_state SET status='building',attempt_id=$4,attempted_at=clock_timestamp(),
        failure_count=CASE WHEN failure_count>=3 THEN 1 ELSE failure_count+1 END,
        next_attempt_at=clock_timestamp()+((CASE WHEN failure_count>=3 THEN 40000 WHEN failure_count=2 THEN 300000 WHEN failure_count=1 THEN 60000 ELSE 40000 END)*interval '1 millisecond'),last_error=NULL
        WHERE source_key=$1 AND target_table=$2 AND contract_version=$3 AND next_attempt_at<=clock_timestamp() RETURNING failure_count`,[...this.key,attemptId])).rows[0];
      if(!claim){
        const row=(await db.query(`SELECT greatest(1000,extract(epoch FROM next_attempt_at-clock_timestamp())*1000)::int AS delay
          FROM olos_http.report_snapshot_state WHERE source_key=$1 AND target_table=$2 AND contract_version=$3`,this.key)).rows[0];
        return {state:'not_due',retry_ms:Math.min(300_000,row?.delay??30_000)};
      }
      attempt=claim.failure_count;
      log('report_snapshot_build_started',{report_source:this.tag,attempt});
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await db.query(`SET LOCAL statement_timeout='${reportBuildTimeoutMs}ms'`);
      await db.query("SET LOCAL lock_timeout='1s'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='35s'");
      await db.query('SET LOCAL client_connection_check_interval=1000');
      await db.query('SET LOCAL jit=off');
      await db.query("SET LOCAL work_mem='16MB'");
      await db.query('SET LOCAL hash_mem_multiplier=2');
      await db.query('SET LOCAL max_parallel_workers_per_gather=1');
      phase='resources';
      await db.query("SET LOCAL temp_file_limit='768MB'");
      phase='collection';
      const data=validateReportData(await collectReportSnapshot(db,this.source,this.destination));
      if(this.stopped||active.released||active.lost)throw new WorkerError('REPORT_UPDATE_STOPPED');
      const encoded=JSON.stringify(data),bytes=Buffer.byteLength(encoded);
      if(bytes>reportPayloadLimit)throw new WorkerError('REPORT_SNAPSHOT_TOO_LARGE');
      // Canonical JSONB output includes spaces. Reserve space so the database CHECK
      // remains the final authority on the 16MiB published representation.
      phase='publication';
      const id=randomUUID(),hash=reportDataHash(data);
      await db.query(`INSERT INTO olos_http.report_snapshots(id,source_key,target_table,contract_version,timezone,status,observed_at,collection_date,data,validation,data_hash,contract_name)
        VALUES($4,$1,$2,$3,$5,'published',$6,$7,$8,$9,$10,$11)`,[...this.key,id,reportZone,data.observed_at,data.collection_date,encoded,
        JSON.stringify(reportValidationMetadata(data)),hash,reportContract]);
      const published=await db.query(`UPDATE olos_http.report_snapshot_state SET published_id=$5,status='ready',failure_count=0,last_error=NULL,
        next_attempt_at=least($6::timestamptz+($7::int*interval '1 second'),(($8::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        WHERE source_key=$1 AND target_table=$2 AND contract_version=$3 AND attempt_id=$4
        RETURNING greatest(1000,extract(epoch FROM next_attempt_at-clock_timestamp())*1000)::int AS delay`,[...this.key,attemptId,id,data.observed_at,reportRefreshSeconds,data.collection_date]);
      if(published.rowCount!==1)throw new WorkerError('REPORT_UPDATE_SUPERSEDED');
      await db.query(`DELETE FROM olos_http.report_snapshots WHERE source_key=$1 AND target_table=$2 AND contract_version=$3 AND id<>$4 AND id NOT IN (
        SELECT id FROM olos_http.report_snapshots WHERE source_key=$1 AND target_table=$2 AND contract_version=$3 AND id<>$4 ORDER BY published_at DESC,id DESC LIMIT 1)`,[...this.key,id]);
      if(this.stopped||active.released||active.lost)throw new WorkerError('REPORT_UPDATE_STOPPED');
      commitIssued=true;await db.query('COMMIT');
      this.localFailures=0;
      log('report_snapshot_published',{report_source:this.tag,snapshot_id:id,duration_ms:Math.round(performance.now()-started),days:data.days.length,bytes});
      return {state:'published',snapshot_id:id,retry_ms:published.rows[0].delay};
    } catch(error) {
      if(active&&!active.released&&!active.lost)await active.db.query('ROLLBACK').catch(()=>{});
      if(commitIssued){
        // Never rewrite control/failure state after uncertain COMMIT. The next
        // pass reads the durable pointer; an already published generation wins.
        log('report_snapshot_commit_unknown',{report_source:this.tag,error:'REPORT_COMMIT_UNKNOWN'});
        return {state:'commit_unknown',code:'REPORT_COMMIT_UNKNOWN',retry_ms:30_000};
      }
      if(this.stopped)return {state:'stopped',retry_ms:300_000};
      const pgCode=(error as {code?:string}).code;
      const code=active?.timedOut?'REPORT_BUILD_DEADLINE_EXCEEDED':error instanceof WorkerError?error.code:pgCode==='57014'?'REPORT_BUILD_TIMEOUT':pgCode==='53400'?'REPORT_TEMP_LIMIT':pgCode==='42501'&&phase==='resources'?'REPORT_RESOURCE_LIMIT_REQUIRED':pgCode==='42P01'||pgCode==='42703'?(phase==='collection'?'REPORT_SOURCE_SCHEMA_UNAVAILABLE':'REPORT_SNAPSHOT_MIGRATION_REQUIRED'):'REPORT_BUILD_FAILED';
      const delay=reportRetryMs(attempt||Math.min(3,++this.localFailures));
      if(active&&!active.released&&!active.lost&&locked&&attemptId)await active.db.query(`UPDATE olos_http.report_snapshot_state SET status='error',last_error=$5,
        next_attempt_at=clock_timestamp()+($6::int*interval '1 millisecond') WHERE source_key=$1 AND target_table=$2 AND contract_version=$3 AND attempt_id=$4`,[...this.key,attemptId,code,delay]).catch(()=>{});
      log('report_snapshot_failed',{report_source:this.tag,error:code,retry_ms:delay,duration_ms:Math.round(performance.now()-started)});
      return {state:'failed',code,retry_ms:delay};
    } finally {
      if(active&&!active.released){
        if(locked&&!active.lost)await active.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`olos-report-refresh:${this.source}`]).catch(()=>{if(!active!.released){active!.released=true;active!.db.release(true);}});
        if(!active.released){active.released=true;active.db.release(active.lost);}
      }
      if(watchdog)clearTimeout(watchdog);
      if(active)active.db.removeListener('error',active.onError);
      if(this.active===active)this.active=undefined;
    }
  }
}
