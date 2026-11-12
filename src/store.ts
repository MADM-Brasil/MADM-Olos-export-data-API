import {captureContinuity,continuityParent,authorizeContinuity,continuityConsent,historicalRead} from './capture-continuity.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { join,basename,resolve } from 'node:path';
import { access,lstat } from 'node:fs/promises';
import { type Config } from './config.js';
import { type ReadSpec, rows, readFields } from './api.js';
import { columns, type Cache, type MappedRecord, mapRecord } from './mapping.js';
import { WorkerError,log } from './errors.js';
import { assertSchema, quote } from './schema.js';
import { lockSource } from './source-lock.js';
import { CorporateDelivery } from './corporate-delivery/delivery.js';
import { assertNoDirectOwnership } from './corporate-sync/ownership.js';
import { admissionHash } from './corporate-delivery/allocator.js';
import { authorization, fingerprint, recoveryBinding, recoveryHash, recoveryManifest, type RecoveryAuthorization, type RecoveryPlan } from './read-recovery.js';
import { prepareCaptureDirectory,verifyCaptureOnDisk,publishedCapture,assertCaptureCapacity,type CaptureResult } from './capture-spool.js';
import { readCaptureObjects } from './capture-json-reader.js';

type Read = { id: string; spec: ReadSpec & { recovery_authorization?: RecoveryAuthorization; capture?:{version:1;storage:'spool';binding:string;max_bytes:number} }; state: string;
  response_spool_read_id?:string|null;
  started_at: Date; error_code: string|null; response_body: string | null; processed_count: number; received_count: number|null; request_ms: number | null };
export class Store {
  readonly pool: pg.Pool;
  client: pg.PoolClient | undefined;
  private sequence = '';
  private alive = false;
  private spoolReady=false;
  private draining=false;
  readonly target: string;
  readonly delivery: CorporateDelivery | undefined;
  constructor(readonly cfg: Config, private readonly onDisconnect: () => void = () => {},private readonly signal?:AbortSignal) {
    this.target = `${quote(cfg.schema)}.${quote(cfg.table)}`;
    this.pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: cfg.poolMax,
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000,
      application_name: 'olos-exportdata-v3-http' });
    this.pool.on('error', () => { this.alive = false; this.onDisconnect(); });
    if (cfg.corporateDelivery && cfg.poolMax < 2) throw new WorkerError('CORPORATE_LOCAL_POOL_REQUIRES_TWO_CONNECTIONS');
    this.delivery = cfg.corporateDelivery ? new CorporateDelivery(cfg.corporateDelivery, cfg.sourceKey, this.target, this.pool,
      () => this.alive, () => { this.alive = false; this.onDisconnect(); }) : undefined;
  }
  async open() {
    this.client = await this.pool.connect();
    this.client.on('error', () => { this.alive = false; this.onDisconnect(); });
    await lockSource(this.client, this.cfg.sourceKey);
    this.alive = true;
    if (this.delivery) await this.delivery.open(this.client);
    else await assertNoDirectOwnership(this.client);
    const schema = await assertSchema(this.client, this.cfg.schema, this.cfg.table);
    this.sequence = schema.sequence!;
    for (const table of ['olos_http.reads', 'olos_http.records']) {
      for (const privilege of ['SELECT','INSERT','UPDATE']) {
        if (!(await this.client.query('SELECT has_table_privilege($1,$2) AS ok',[table,privilege])).rows[0].ok) throw new WorkerError('CONTROL_PRIVILEGE_REQUIRED');
      }
    }
    await this.client.query("SET TIME ZONE 'UTC'");
    const mismatch = await this.client.query('SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND target_table<>$2 LIMIT 1', [this.cfg.sourceKey, this.target]);
    if (mismatch.rowCount) throw new WorkerError('SOURCE_DESTINATION_BINDING_CHANGED');
    const untracked = await this.client.query(`SELECT 1 FROM ${this.target} d WHERE NOT EXISTS
      (SELECT 1 FROM olos_http.records r WHERE r.target_table=$1 AND r.target_id=d.internal_id_olos) LIMIT 1`, [this.target]);
    if (untracked.rowCount) throw new WorkerError('EXISTING_DESTINATION_REQUIRES_BASELINE');
    if(this.cfg.captureSpoolDirectory){
      await prepareCaptureDirectory(this.cfg.captureSpoolDirectory,this.cfg.captureSpoolRequireMount);
      if(this.cfg.captureMaxObjectBytes>this.cfg.captureBatchBytes)throw new WorkerError('CAPTURE_OBJECT_LIMIT_EXCEEDS_BATCH');
      if(!(await this.client.query("SELECT to_regclass('olos_http.capture_spool') IS NOT NULL AS present")).rows[0].present)throw new WorkerError('CAPTURE_SPOOL_MIGRATION_REQUIRED');
      await this.client.query('SELECT response_spool_read_id FROM olos_http.reads LIMIT 0');
      await this.client.query('SELECT read_id,file_name,byte_size,sha256,state,record_count,verified_at FROM olos_http.capture_spool LIMIT 0');
      for(const privilege of ['SELECT','INSERT','UPDATE'])if(!(await this.client.query("SELECT has_table_privilege('olos_http.capture_spool',$1) AS ok",[privilege])).rows[0].ok)throw new WorkerError('CAPTURE_SPOOL_PRIVILEGE_REQUIRED');
      if(!(await this.client.query("SELECT has_database_privilege(current_database(),'TEMP') AS ok")).rows[0].ok)throw new WorkerError('CAPTURE_VALIDATION_TEMP_REQUIRED');
      this.spoolReady=true;
    }
  }
  private db() {
    if (!this.client || !this.alive) throw new WorkerError('DATABASE_SESSION_LOST');
    return this.client;
  }
  async ping() { await this.db().query('SELECT 1'); }
  async captureReady() { await this.delivery?.captureReady(this.db()); }
  async reconcileCorporate() {
    if (!this.delivery) throw new WorkerError('CORPORATE_MODE_REQUIRED');
    return this.delivery.reconcile(this.db(), this.sequence);
  }
  async unresolved() {
    return (await this.db().query<Read>(`SELECT id,spec,state,response_body,processed_count,request_ms,started_at,error_code,received_count,
      ${this.spoolReady?'response_spool_read_id::text':'NULL::text'} AS response_spool_read_id FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received') ORDER BY started_at`, [this.cfg.sourceKey])).rows;
  }
  private admitting=false;
  private async continuityDecision(){
    const decision=await captureContinuity(()=>this.db(),await this.unresolved(),this.cfg.sourceKey,this.target,this.captureBinding(),this.spoolReady&&this.cfg.sourceIdConfirmed);
    if(decision.authorizationId)await this.continuityStorage();
    return decision;
  }
  private async continuityStorage(){
    if(!this.spoolReady||!this.cfg.captureSpoolDirectory)throw new WorkerError('CAPTURE_SPOOL_CONFIG_REQUIRED');
    await prepareCaptureDirectory(this.cfg.captureSpoolDirectory,this.cfg.captureSpoolRequireMount);
    for(const suffix of ['.json','.json.complete']){
      try{await lstat(join(this.cfg.captureSpoolDirectory,historicalRead+suffix));}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      throw new WorkerError('CONTINUITY_PARENT_HAS_FILE');
    }
  }
  async capturePending(){return (await this.continuityDecision()).pending;}
  async inspectContinuity(){
    if(!this.spoolReady)throw new WorkerError('CAPTURE_SPOOL_CONFIG_REQUIRED');
    return {parent_id:historicalRead,parent_hash:await continuityParent(this.db(),this.cfg.sourceKey,this.target)};
  }
  async authorizeContinuity(input:unknown){
    if(!this.spoolReady||!this.cfg.sourceIdConfirmed)throw new WorkerError('CAPTURE_SPOOL_CONFIG_REQUIRED');
    await this.continuityStorage();
    const consent=continuityConsent(input);
    await authorizeContinuity(this.db(),consent,this.cfg.sourceKey,this.target,this.captureBinding());
    log('capture_continuity_authorized',{authorization_id:consent.authorizationId,parent_id:historicalRead,historical_gap:true});
  }
  async revokeContinuity(id:string){
    const result=await this.db().query('UPDATE olos_http.capture_continuity SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE authorization_id=$1 AND source_key=$2 RETURNING authorization_id',[id,this.cfg.sourceKey]);
    if(!result.rowCount)throw new WorkerError('CONTINUITY_AUTHORIZATION_NOT_FOUND');
    log('capture_continuity_revoked',{authorization_id:id,parent_id:historicalRead});
  }
  private captureBinding(){return fingerprint(JSON.stringify([this.cfg.sourceKey,this.target,this.cfg.ingestionBaseline??null,this.cfg.sourceTimeZone??null,this.cfg.sourceIdConfirmed,'lossless-stream-v1']));}
  private spoolIntent(read:Pick<Read,'spec'>){
    const c=read.spec.capture;
    if(!this.spoolReady||!this.cfg.captureSpoolDirectory)throw new WorkerError('CAPTURE_SPOOL_CONFIG_REQUIRED');
    if(read.spec.kind==='reread'||!c||c.version!==1||c.storage!=='spool'||c.binding!==this.captureBinding()||!Number.isSafeInteger(c.max_bytes)||c.max_bytes<1||c.max_bytes>4*1024**3)throw new WorkerError('CAPTURE_INTENT_MISMATCH');
    return c;
  }
  async beginRead(spec: ReadSpec, recovery = false) {
    if(this.admitting)throw new WorkerError('CAPTURE_ADMISSION_ACTIVE');
    this.admitting=true;try{
    await this.captureReady();
    const decision=spec.kind==='current'&&!recovery?await this.continuityDecision():{pending:await this.unresolved(),authorizationId:undefined};
    const pending=decision.pending;
    if (spec.kind==='reread' && pending.some(r=>r.state==='reading')) throw new WorkerError('RECOVERY_AUTHORIZATION_REQUIRED');
    if (pending.some(r => r.state === 'received') || (!recovery && pending.length)) throw new WorkerError('RECOVERY_REQUIRED');
    if(this.spoolReady&&spec.kind!=='reread')await assertCaptureCapacity(this.cfg.captureSpoolDirectory!,this.cfg.captureMaxBytes);
    const id = randomUUID();
    const journal=this.spoolReady&&spec.kind!=='reread'?{...spec,capture:{version:1,storage:'spool',binding:this.captureBinding(),max_bytes:this.cfg.captureMaxBytes}}:spec;
    if(decision.authorizationId)Object.assign(journal,{continuity:{authorization_id:decision.authorizationId,parent_id:historicalRead,historical_gap:true}});
    if(decision.authorizationId){
      const inserted=await this.db().query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec)
        SELECT $1,$2,$3,$4 FROM olos_http.capture_continuity a WHERE authorization_id=$5
        AND source_key=$2 AND target_table=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM olos_http.reads parent WHERE parent.id=a.parent_id
          AND encode(sha256(convert_to(to_jsonb(parent)::text,'UTF8')),'hex')=a.parent_hash)
        AND NOT EXISTS(SELECT 1 FROM olos_http.reads WHERE source_key=$2 AND state IN ('reading','received') AND id<>a.parent_id)`,
        [id,this.cfg.sourceKey,this.target,JSON.stringify(journal),decision.authorizationId]);
      if(inserted.rowCount!==1)throw new WorkerError('CONTINUITY_ADMISSION_CHANGED');
    }else await this.db().query('INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES ($1,$2,$3,$4)', [id, this.cfg.sourceKey, this.target, JSON.stringify(journal)]);
    if(decision.authorizationId)log('capture_with_historical_gap',{read_id:id,parent_id:historicalRead,authorization_id:decision.authorizationId,historical_gap:true});
    return id;
    }finally{this.admitting=false;}
  }
  private async recoveryAuthorization(parentId: string) {
    const parent=(await this.db().query<Read>('SELECT id,spec,state,started_at,error_code,response_body,processed_count FROM olos_http.reads WHERE id=$1 AND source_key=$2 AND target_table=$3',
      [parentId,this.cfg.sourceKey,this.target])).rows[0];
    if(!parent||parent.spec.kind!=='current'||!['reading','resolved'].includes(parent.state)||parent.response_body!==null||parent.processed_count!==0)throw new WorkerError('ORIGINAL_READ_NOT_FOUND');
    if(!parent.spec.recovery_authorization)throw new WorkerError('RECOVERY_AUTHORIZATION_REQUIRED');
    const approved=authorization(parent.spec.recovery_authorization,this.cfg);
    if(approved.manifest.parentId!==parentId||Date.parse(approved.manifest.parentStartedAt)!==parent.started_at.getTime())throw new WorkerError('RECOVERY_AUTHORIZATION_CHANGED');
    return {parent,approved};
  }
  async authorizeRecovery(input: RecoveryPlan) {
    if(!this.cfg.sourceIdConfirmed)throw new WorkerError('SOURCE_ID_UNIQUENESS_UNCONFIRMED');
    const manifest=recoveryManifest(input);
    if(manifest.sourceKey!==this.cfg.sourceKey||manifest.targetTable!==this.target)throw new WorkerError('RECOVERY_SOURCE_MISMATCH');
    const approved:RecoveryAuthorization={manifest,hash:fingerprint(JSON.stringify(manifest)),binding:recoveryBinding(this.cfg)};
    const db=this.db();let commitIssued=false;
    try{
      await db.query('BEGIN');
      const parent=(await db.query<Read>('SELECT id,spec,state,started_at,error_code,response_body,processed_count FROM olos_http.reads WHERE id=$1 AND source_key=$2 AND target_table=$3 FOR UPDATE',
        [manifest.parentId,this.cfg.sourceKey,this.target])).rows[0];
      if(!parent||parent.state!=='reading'||parent.spec.kind!=='current'||parent.response_body!==null||parent.processed_count!==0||
        parent.error_code!=='RESPONSE_TOO_LARGE'||parent.started_at.getTime()!==Date.parse(manifest.parentStartedAt))throw new WorkerError('ORIGINAL_READ_NOT_FOUND');
      if((await this.unresolved()).some(read=>read.id!==parent.id))throw new WorkerError('RECOVERY_REQUIRED');
      if(parent.spec.recovery_authorization){
        const existing=authorization(parent.spec.recovery_authorization,this.cfg);
        if(existing.hash!==approved.hash)throw new WorkerError('RECOVERY_AUTHORIZATION_CHANGED');
      }else await db.query("UPDATE olos_http.reads SET spec=spec||jsonb_build_object('recovery_authorization',$3::jsonb) WHERE id=$1 AND source_key=$2",
        [manifest.parentId,this.cfg.sourceKey,JSON.stringify(approved)]);
      commitIssued=true;await db.query('COMMIT');return approved.hash;
    }catch(error){await db.query('ROLLBACK').catch(()=>{});if(commitIssued)throw new WorkerError('RECOVERY_AUTHORIZATION_COMMIT_UNKNOWN');throw error;}
  }
  async validateRecoveryRead(parentId: string, spec: ReadSpec, approvalHash: string, missingOnly=false) {
    if (spec.kind !== 'reread') throw new WorkerError('RECOVERY_SPEC_REQUIRED');
    readFields(spec);
    const {parent,approved}=await this.recoveryAuthorization(parentId);
    if(parent.state!=='reading'||recoveryHash(approvalHash)!==approved.hash||spec.date!==approved.manifest.date||
      (missingOnly&&approved.manifest.version!==2)||!approved.manifest.ranges.some(range=>missingOnly
        ? BigInt(range.start)<=BigInt(spec.start)&&BigInt(range.end)>=BigInt(spec.end)
        : range.start===spec.start&&range.end===spec.end))throw new WorkerError('RECOVERY_OUTSIDE_AUTHORIZED_RANGE');
    const pending = await this.unresolved();
    if (pending.some(r => r.id !== parentId)) {
      throw new WorkerError('RECOVERY_REQUIRED');
    }

    const previous = await this.db().query(
      "SELECT id,spec,state,processed_count,received_count FROM olos_http.reads WHERE source_key=$1 AND target_table=$2 AND spec->>'kind'='reread'",
      [this.cfg.sourceKey, this.target]
    );

    let precedingObservation=false;
    for (const row of previous.rows) {
      const other = row.spec;
      if (other.date !== spec.date) continue;

      if (BigInt(spec.start) <= BigInt(other.end) &&
          BigInt(spec.end) >= BigInt(other.start)) {
        if(!missingOnly||row.state!=='done'||other.recovery?.parentId!==parentId||other.recovery.authorizationHash!==approvalHash||other.recovery.missingOnly)throw new WorkerError('RECOVERY_RANGE_OVERLAP');
        const body=(await this.db().query<{response_body:string}>('SELECT response_body FROM olos_http.reads WHERE id=$1 AND source_key=$2',[row.id,this.cfg.sourceKey])).rows[0]!.response_body;
        if(Buffer.byteLength(body)>this.cfg.recoveryMaxResponseBytes)throw new WorkerError('RESPONSE_TOO_LARGE');
        const data=rows(body);
        if(row.processed_count!==data.length||row.received_count!==data.length)throw new WorkerError('RECOVERY_CHECKPOINT_INVALID');
        const hashes=await this.validateRecoveryResponse(row,data,{users:new Map(),campaigns:new Map(),dispositions:new Map()},approved);
        if([...hashes.keys()].some(id=>BigInt(id)>=BigInt(spec.start)&&BigInt(id)<=BigInt(spec.end)))throw new WorkerError('RECOVERY_RANGE_ALREADY_OBSERVED');
        precedingObservation=true;
      }
    }
    if(missingOnly&&!precedingObservation)throw new WorkerError('RECOVERY_MISSING_ONLY_REQUIRES_OBSERVATION');
  }

  async beginRecoveryRead(parentId: string, spec: ReadSpec, approvalHash: string, missingOnly=false) {
    await this.captureReady();
    await this.validateRecoveryRead(parentId, spec, approvalHash, missingOnly);
    const id = randomUUID();
    await this.db().query(
      'INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES ($1,$2,$3,$4)',
      [id, this.cfg.sourceKey, this.target, JSON.stringify({...spec,recovery:{parentId,authorizationHash:approvalHash,...(missingOnly?{missingOnly:true}:{})}})]
    );
    return id;
  }

  async stage(id: string, body: string, requestMs: number) {
    const result = await this.db().query("UPDATE olos_http.reads SET response_body=$2,state='received',request_ms=$3 WHERE id=$1 AND source_key=$4 AND state='reading' AND NOT (spec ? 'capture')", [id, body, requestMs, this.cfg.sourceKey]);
    if (result.rowCount !== 1) throw new WorkerError('READ_STATE_CONFLICT');
  }
  async registerCaptureSpool(id:string,capture:CaptureResult,requestMs:number|null=null){
    if(!this.cfg.captureSpoolDirectory||resolve(capture.path)!==join(resolve(this.cfg.captureSpoolDirectory),`${id}.json`))throw new WorkerError('CAPTURE_SPOOL_INVALID');
    await verifyCaptureOnDisk(capture);
    const db=this.db();let committing=false;
    try{
      await db.query('BEGIN');
      const read=(await db.query<Read>('SELECT id,spec,state,response_body,response_spool_read_id FROM olos_http.reads WHERE id=$1 AND source_key=$2 AND target_table=$3 FOR UPDATE',[id,this.cfg.sourceKey,this.target])).rows[0];
      if(!read)throw new WorkerError('UNRESOLVED_READ_NOT_FOUND');
      const intent=this.spoolIntent(read);if(capture.bytes>intent.max_bytes)throw new WorkerError('RESPONSE_TOO_LARGE');
      const existing=(await db.query<{file_name:string;byte_size:string;sha256:string}>('SELECT file_name,byte_size::text,sha256 FROM olos_http.capture_spool WHERE read_id=$1',[id])).rows[0];
      if(existing){
        if(existing.file_name!==basename(capture.path)||existing.byte_size!==String(capture.bytes)||existing.sha256!==capture.sha256||read.response_spool_read_id!==id||!['received','done'].includes(read.state)||read.response_body!==null)throw new WorkerError('CAPTURE_SPOOL_METADATA_MISMATCH');
        await db.query('ROLLBACK');return;
      }
      if(read.state!=='reading'||read.response_body!==null||read.response_spool_read_id!==null)throw new WorkerError('READ_STATE_CONFLICT');
      await db.query("INSERT INTO olos_http.capture_spool(read_id,file_name,byte_size,sha256,state) VALUES($1,$2,$3,$4,'complete')",[id,basename(capture.path),capture.bytes,capture.sha256]);
      await db.query("UPDATE olos_http.reads SET state='received',response_spool_read_id=$1,request_ms=$3 WHERE id=$1 AND source_key=$2 AND state='reading'",[id,this.cfg.sourceKey,requestMs]);
      committing=true;await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});if(committing)throw new WorkerError('CAPTURE_SPOOL_COMMIT_UNKNOWN');throw error;}
  }
  async inspectCaptureSpool(id:string):Promise<CaptureResult>{
    if(!this.spoolReady||!this.cfg.captureSpoolDirectory)throw new WorkerError('CAPTURE_SPOOL_CONFIG_REQUIRED');
    const row=(await this.db().query<Read & {file_name:string;byte_size:string;sha256:string}>(`SELECT r.id,r.spec,r.state,r.response_body,s.file_name,s.byte_size::text,s.sha256
      FROM olos_http.reads r JOIN olos_http.capture_spool s ON s.read_id=r.response_spool_read_id
      WHERE r.id=$1 AND r.source_key=$2 AND r.target_table=$3 AND s.read_id=r.id`,[id,this.cfg.sourceKey,this.target])).rows[0];
    if(!row||row.file_name!==`${id}.json`||row.response_body!==null||!['received','done'].includes(row.state))throw new WorkerError('CAPTURE_SPOOL_METADATA_MISMATCH');
    const intent=this.spoolIntent(row),capture={path:join(this.cfg.captureSpoolDirectory,row.file_name),bytes:Number(row.byte_size),sha256:row.sha256};
    if(capture.bytes>intent.max_bytes)throw new WorkerError('CAPTURE_SPOOL_METADATA_MISMATCH');
    await verifyCaptureOnDisk(capture);return capture;
  }
  async recoverCaptureSpool(id:string){
    const read=(await this.db().query<Read>('SELECT id,spec,state FROM olos_http.reads WHERE id=$1 AND source_key=$2 AND target_table=$3',[id,this.cfg.sourceKey,this.target])).rows[0];
    if(!read)throw new WorkerError('UNRESOLVED_READ_NOT_FOUND');
    const intent=this.spoolIntent(read);
    const capture=await publishedCapture(this.cfg.captureSpoolDirectory!,id,intent.max_bytes);
    await this.registerCaptureSpool(id,capture);return capture;
  }
  async recoverPublishedCaptures(){
    for(const read of await this.unresolved()){
      if(read.state!=='reading'||!read.spec.capture)continue;
      this.spoolIntent(read);
      try{await access(join(this.cfg.captureSpoolDirectory!,`${read.id}.json.complete`));}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      await this.recoverCaptureSpool(read.id);
    }
  }
  async markError(id: string, code: string) {
    await this.db().query('UPDATE olos_http.reads SET error_code=$2 WHERE id=$1 AND source_key=$3', [id, code, this.cfg.sourceKey]);
  }
  async rejected(id: string, code: string) {
    await this.db().query("UPDATE olos_http.reads SET state='resolved',finished_at=clock_timestamp(),error_code=$2,resolution='Authentication failed before consuming transport invocation' WHERE id=$1 AND source_key=$3 AND state='reading'", [id, code, this.cfg.sourceKey]);
  }
  async drain(cache: Cache) {
    if(this.draining)throw new WorkerError('PERSISTENCE_ALREADY_ACTIVE');this.draining=true;
    try{
    const total: { received: number; inserted: number; updated: number; duplicates: number; queued?: number; skipped?: number } =
      { received: 0, inserted: 0, updated: 0, duplicates: 0, ...(this.delivery ? { queued: 0, skipped: 0 } : {}) };
    for (const read of await this.unresolved()) {
      if (read.state !== 'received') continue;
      if(read.spec.capture||read.response_spool_read_id){
        const counts=await this.drainCaptureSpool(read,cache);
        total.received+=counts.received;total.inserted+=counts.inserted;total.updated+=counts.updated;total.duplicates+=counts.duplicates;
        if(this.delivery){total.queued=(total.queued??0)+(counts.queued??0);total.skipped=(total.skipped??0)+(counts.skipped??0);}continue;
      }
      if(read.spec.kind==='reread'&&read.spec.recovery&&Buffer.byteLength(read.response_body!)>this.cfg.recoveryMaxResponseBytes)throw new WorkerError('RESPONSE_TOO_LARGE');
      const data = rows(read.response_body!);
      if(read.spec.kind==='reread'&&read.spec.recovery)await this.validateRecoveryResponse(read,data,cache);
      total.received += data.length;
      // Validate the whole response before writing any target rows. Raw response is already durable.
      for (const row of data) {
        const mapped = mapRecord(row, cache, this.cfg.sourceTimeZone, !!this.delivery);
        if (read.spec.kind === 'reread' && (BigInt(mapped.source_id) < BigInt(read.spec.start) || BigInt(mapped.source_id) > BigInt(read.spec.end))) throw new WorkerError('RECOVERY_RESPONSE_OUTSIDE_RANGE');
      }
      for (let offset = read.processed_count; offset < data.length; offset += this.cfg.batchSize) {
        const mapped = data.slice(offset, offset + this.cfg.batchSize)
          .map(row => mapRecord(row, cache, this.cfg.sourceTimeZone, !!this.delivery));

        const baseline = this.cfg.ingestionBaseline;

        const batch = baseline
          ? mapped.filter(row =>
              row.data_ligacao !== null &&
              Date.parse(row.data_ligacao) >= Date.parse(baseline))
          : mapped;

        const result = await this.persist(
          read.id,
          batch,
          offset + mapped.length,
          data.length
        );
        total.inserted += result.inserted; total.updated += result.updated; total.duplicates += result.duplicates;
        if ('queued' in result && result.queued !== undefined) total.queued = (total.queued ?? 0) + result.queued;
        if ('skipped' in result && result.skipped !== undefined) total.skipped = (total.skipped ?? 0) + result.skipped;
      }
      await this.db().query("UPDATE olos_http.reads SET state='done',finished_at=clock_timestamp(),received_count=$2 WHERE id=$1 AND source_key=$3 AND processed_count=$2", [read.id, data.length, this.cfg.sourceKey]);
    }
    return total;
    }finally{this.draining=false;}
  }
  private async drainCaptureSpool(read:Read,cache:Cache){
    const capture=await this.inspectCaptureSpool(read.id),db=this.db();
    const result={received:0,inserted:0,updated:0,duplicates:0,queued:0,skipped:0};
    const eligible=(row:MappedRecord)=>!this.cfg.ingestionBaseline||(row.data_ligacao!==null&&Date.parse(row.data_ligacao)>=Date.parse(this.cfg.ingestionBaseline));
    let count=0,filtered=0;
    await db.query('CREATE TEMP TABLE olos_capture_validation(source_id text PRIMARY KEY,source_hash text NOT NULL,eligible boolean NOT NULL) ON COMMIT PRESERVE ROWS');
    try{
      let validation:MappedRecord[]=[],validationBytes=0;
      const validateBatch=async()=>{
        if(!validation.length)return;
        const unique=new Map<string,MappedRecord>();
        for(const row of validation){if(unique.has(row.source_id)&&unique.get(row.source_id)!.source_hash!==row.source_hash)throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');unique.set(row.source_id,row);}
        const values=[...unique.values()].map(row=>({source_id:row.source_id,source_hash:row.source_hash,eligible:eligible(row)}));
        const registered=await db.query(`INSERT INTO pg_temp.olos_capture_validation AS c(source_id,source_hash,eligible)
          SELECT x.source_id,x.source_hash,x.eligible FROM jsonb_to_recordset($1::jsonb) AS x(source_id text,source_hash text,eligible boolean)
          ON CONFLICT(source_id) DO UPDATE SET source_hash=EXCLUDED.source_hash
          WHERE c.source_hash=EXCLUDED.source_hash AND c.eligible=EXCLUDED.eligible RETURNING source_id`,[JSON.stringify(values)]);
        if(registered.rowCount!==values.length)throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
        for(const previous of await this.recoveryRecords([...unique.keys()])){
          if(previous.source_hash!==unique.get(previous.source_id)!.source_hash||previous.target_table!==this.target)throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
          if(!previous.present)throw new WorkerError('CAPTURE_PERSISTENCE_DIVERGES');
        }
        validation=[];validationBytes=0;
      };
      // No business INSERT occurs before EOF, UTF-8/JSON validity, digest and global duplicate validation.
      for await(const item of readCaptureObjects(capture,this.cfg.captureMaxObjectBytes,this.signal)){
        const mapped=mapRecord(item.value,cache,this.cfg.sourceTimeZone,!!this.delivery),size=Buffer.byteLength(JSON.stringify(mapped));
        if(size>this.cfg.captureBatchBytes)throw new WorkerError('CAPTURE_BATCH_LIMIT');
        if(validation.length&&(validation.length>=this.cfg.batchSize||validationBytes+size>this.cfg.captureBatchBytes))await validateBatch();
        validation.push(mapped);validationBytes+=size;if(!eligible(mapped))filtered++;
        if(++count>this.cfg.captureMaxRecords)throw new WorkerError('CAPTURE_RECORD_LIMIT');
      }
      await validateBatch();
      if(read.processed_count>count)throw new WorkerError('CAPTURE_CHECKPOINT_INVALID');
      const verified=await db.query(`UPDATE olos_http.capture_spool SET state='verified',verified_at=clock_timestamp(),record_count=$4
        WHERE read_id=$1 AND sha256=$2 AND byte_size=$3 AND (record_count IS NULL OR record_count=$4)`,[read.id,capture.sha256,capture.bytes,count]);
      if(verified.rowCount!==1)throw new WorkerError('CAPTURE_SPOOL_METADATA_MISMATCH');
      log('capture_validated',{read_id:read.id,records:count,baseline_excluded:filtered,response_bytes:capture.bytes});
      let batch:MappedRecord[]=[],batchBytes=0,checkpoint=read.processed_count;
      const flush=async()=>{
        if(!batch.length)return;
        this.signal?.throwIfAborted();
        const hashes=new Map((await db.query<{source_id:string;source_hash:string}>('SELECT source_id,source_hash FROM pg_temp.olos_capture_validation WHERE source_id=ANY($1::text[])',[batch.map(row=>row.source_id)])).rows.map(row=>[row.source_id,row.source_hash]));
        if(batch.some(row=>hashes.get(row.source_id)!==row.source_hash))throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');
        const saved=await this.persist(read.id,batch.filter(eligible),checkpoint,count);
        result.inserted+=saved.inserted;result.updated+=saved.updated;result.duplicates+=saved.duplicates;
        if('queued' in saved)result.queued+=saved.queued??0;if('skipped' in saved)result.skipped+=saved.skipped??0;
        batch=[];batchBytes=0;
      };
      for await(const item of readCaptureObjects(capture,this.cfg.captureMaxObjectBytes,this.signal)){
        if(item.index<read.processed_count)continue;
        const mapped=mapRecord(item.value,cache,this.cfg.sourceTimeZone,!!this.delivery),size=Buffer.byteLength(JSON.stringify(mapped));
        if(batch.length&&(batch.length>=this.cfg.batchSize||batchBytes+size>this.cfg.captureBatchBytes))await flush();
        batch.push(mapped);batchBytes+=size;checkpoint=item.index+1;
      }
      await flush();
      // Confirm every eligible validated identity, including records before a recovered checkpoint.
      let cursor:string|null=null;
      for(;;){
        const expected:{source_id:string;source_hash:string}[]=(await db.query<{source_id:string;source_hash:string}>(`SELECT source_id,source_hash FROM pg_temp.olos_capture_validation
          WHERE eligible AND ($1::text IS NULL OR source_id>$1) ORDER BY source_id LIMIT $2`,[cursor,this.cfg.batchSize])).rows;
        if(!expected.length)break;
        const present=new Map((await this.recoveryRecords(expected.map(row=>row.source_id))).map(row=>[row.source_id,row]));
        if(expected.some(row=>!present.get(row.source_id)?.present||present.get(row.source_id)!.source_hash!==row.source_hash||present.get(row.source_id)!.target_table!==this.target))throw new WorkerError('CAPTURE_PERSISTENCE_INCOMPLETE');
        cursor=expected.at(-1)!.source_id;
      }
      this.signal?.throwIfAborted();
      const done=await db.query("UPDATE olos_http.reads SET state='done',finished_at=clock_timestamp(),received_count=$2 WHERE id=$1 AND source_key=$3 AND state='received' AND processed_count=$2 AND response_spool_read_id=$1",[read.id,count,this.cfg.sourceKey]);
      if(done.rowCount!==1)throw new WorkerError('READ_STATE_CONFLICT');
      result.received=count;return result;
    }finally{await db.query('DROP TABLE IF EXISTS pg_temp.olos_capture_validation').catch(()=>{});}
  }
  private async validateRecoveryResponse(read: Read, data: Record<string,unknown>[], cache: Cache, approvedInput?: RecoveryAuthorization, checkExisting=true) {
    if(read.spec.kind!=='reread'||!read.spec.recovery)throw new WorkerError('RECOVERY_AUTHORIZATION_REQUIRED');
    const spec=read.spec;
    const approved=approvedInput??(await this.recoveryAuthorization(spec.recovery!.parentId)).approved;
    const range=approved.manifest.ranges.find(range=>spec.recovery!.missingOnly&&approved.manifest.version===2
      ? BigInt(range.start)<=BigInt(spec.start)&&BigInt(range.end)>=BigInt(spec.end)
      : range.start===spec.start&&range.end===spec.end);
    if(approved.hash!==read.spec.recovery.authorizationHash||read.spec.date!==approved.manifest.date||!range)throw new WorkerError('RECOVERY_AUTHORIZATION_CHANGED');
    if(spec.recovery!.missingOnly&&approved.manifest.version!==2)throw new WorkerError('RECOVERY_AUTHORIZATION_CHANGED');
    const expected=approved.manifest.version===1?new Set(approved.manifest.ranges.find(r=>r.start===spec.start&&r.end===spec.end)!.expectedIds):undefined;
    const hashes=new Map<string,string>();
    for(const row of data){
      const mapped=mapRecord(row,cache,this.cfg.sourceTimeZone,!!this.delivery);
      if(expected&&!expected.has(mapped.source_id))throw new WorkerError('RECOVERY_RESPONSE_COVERAGE_MISMATCH');
      if(BigInt(mapped.source_id)<BigInt(spec.start)||BigInt(mapped.source_id)>BigInt(spec.end))throw new WorkerError('RECOVERY_RESPONSE_OUTSIDE_RANGE');
      if(hashes.has(mapped.source_id)&&hashes.get(mapped.source_id)!==mapped.source_hash)throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
      if(this.cfg.ingestionBaseline&&(mapped.data_ligacao===null||Date.parse(mapped.data_ligacao)<Date.parse(this.cfg.ingestionBaseline)))throw new WorkerError('RECOVERY_BASELINE_EXCLUDES_RECORD');
      hashes.set(mapped.source_id,mapped.source_hash);
    }
    if(expected&&hashes.size!==expected.size)throw new WorkerError('RECOVERY_RESPONSE_COVERAGE_MISMATCH');
    if(!checkExisting)return hashes;
    // Detect conflicts across the entire child before committing its first processing batch.
    const observed=[...hashes.keys()];
    for(let offset=0;offset<observed.length;offset+=this.cfg.batchSize){
      const records=await this.recoveryRecords(observed.slice(offset,offset+this.cfg.batchSize));
      if(records.some(record=>record.target_table!==this.target||record.source_hash!==hashes.get(record.source_id)))throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
      if(records.some(record=>!record.present))throw new WorkerError('RECOVERY_PERSISTENCE_DIVERGES');
    }
    return hashes;
  }
  private async recoveryRecords(ids: string[]) {
    // In corporate mode the durable destination is the frozen outbox (or an unmaterialized
    // admission), not a new local raw row and not a remote receipt. Never trigger delivery here.
    const present=this.delivery?`EXISTS(SELECT 1 FROM olos_http.corporate_outbox o WHERE o.source_key=r.source_key AND o.source_id=r.source_id
      AND o.target_id=r.target_id AND o.source_hash=r.source_hash)`:`EXISTS(SELECT 1 FROM ${this.target} d WHERE d.internal_id_olos=r.target_id)`;
    const records=(await this.db().query<{source_id:string;source_hash:string;target_table:string;present:boolean}>(
      `SELECT r.source_id,r.source_hash,r.target_table,${present} AS present FROM olos_http.records r WHERE r.source_key=$1 AND r.source_id=ANY($2::text[])`,
      [this.cfg.sourceKey,ids])).rows;
    if(this.delivery&&records.length<ids.length&&(await this.db().query("SELECT to_regclass('olos_http.corporate_id_admissions') IS NOT NULL AS present")).rows[0].present){
      const existing=new Set(records.map(record=>record.source_id));
      const admissions=(await this.db().query<{source_id:string;source_hash:string;mapped:MappedRecord;mapped_hash:string}>(
        'SELECT source_id,source_hash,mapped,mapped_hash FROM olos_http.corporate_id_admissions WHERE source_key=$1 AND source_id=ANY($2::text[]) AND NOT materialized',
        [this.cfg.sourceKey,ids.filter(id=>!existing.has(id))])).rows;
      for(const row of admissions)records.push({source_id:row.source_id,source_hash:row.source_hash,target_table:this.target,
        present:row.mapped.source_id===row.source_id&&row.mapped.source_hash===row.source_hash&&admissionHash(row.mapped)===row.mapped_hash});
    }
    return records;
  }
  async verifyRecovery(parentId: string) {
    const {parent,approved}=await this.recoveryAuthorization(parentId);
    const children=(await this.db().query<Read>("SELECT id,spec,state,processed_count,received_count FROM olos_http.reads WHERE source_key=$1 AND target_table=$2 AND spec->'recovery'->>'parentId'=$3 ORDER BY started_at,id",
      [this.cfg.sourceKey,this.target,parentId])).rows;
    if(approved.manifest.version===2)return this.verifyProgressiveRecovery(parentId,parent,approved,children);
    let covered=0,missing=0,conflicts=0,completed=0;
    const proof:string[]=[approved.hash];
    const empty:Cache={users:new Map(),campaigns:new Map(),dispositions:new Map()};
    for(const range of approved.manifest.ranges){
      const matching=children.filter(child=>child.spec.kind==='reread'&&child.spec.start===range.start&&child.spec.end===range.end);
      const child=matching[0];
      if(matching.length!==1||!child||child.state!=='done'){missing+=range.expectedIds.length;continue;}
      const body=(await this.db().query<{response_body:string}>('SELECT response_body FROM olos_http.reads WHERE id=$1 AND source_key=$2',[child.id,this.cfg.sourceKey])).rows[0]!.response_body;
      if(Buffer.byteLength(body)>this.cfg.recoveryMaxResponseBytes)throw new WorkerError('RESPONSE_TOO_LARGE');
      const data=rows(body),hashes=await this.validateRecoveryResponse(child,data,empty,approved,false);
      if(child.processed_count!==data.length||child.received_count!==data.length){missing+=range.expectedIds.length;continue;}
      proof.push(child.id,fingerprint(body));completed++;
      for(let offset=0;offset<range.expectedIds.length;offset+=this.cfg.batchSize){
        const ids=range.expectedIds.slice(offset,offset+this.cfg.batchSize);
        const records=await this.recoveryRecords(ids);
        const byId=new Map(records.map(record=>[record.source_id,record]));
        for(const id of ids){
          const record=byId.get(id);
          if(!record||!record.present)missing++;else if(record.target_table!==this.target||record.source_hash!==hashes.get(id))conflicts++;else{covered++;proof.push(id,record.source_hash);}
        }
      }
    }
    const pending=(await this.unresolved()).filter(read=>read.id!==parentId).length;
    const expected=approved.manifest.ranges.reduce((n,range)=>n+range.expectedIds.length,0);
    const complete=missing===0&&conflicts===0&&covered===expected&&completed===children.length&&completed===approved.manifest.ranges.length&&pending===0;
    return {parent_id:parentId,parent_state:parent.state,complete,expected,covered,missing,conflicts,children:children.length,completed,pending,
      verification_digest:complete?fingerprint(JSON.stringify(proof)):null,unobserved_ranges:[] as {start:string;end:string}[]};
  }
  private async verifyProgressiveRecovery(parentId:string,parent:Read,approved:RecoveryAuthorization,children:Read[]) {
    if(approved.manifest.version!==2)throw new WorkerError('RECOVERY_MANIFEST_INVALID');
    const manifest=approved.manifest,observed=new Map<string,string>(),proof=[approved.hash];
    let completed=0,conflicts=0,covered=0,missingLocal=0;
    const empty:Cache={users:new Map(),campaigns:new Map(),dispositions:new Map()};
    for(const child of children){
      if(child.state!=='done')continue;
      const body=(await this.db().query<{response_body:string}>('SELECT response_body FROM olos_http.reads WHERE id=$1 AND source_key=$2',[child.id,this.cfg.sourceKey])).rows[0]!.response_body;
      if(Buffer.byteLength(body)>this.cfg.recoveryMaxResponseBytes)throw new WorkerError('RESPONSE_TOO_LARGE');
      const data=rows(body),hashes=await this.validateRecoveryResponse(child,data,empty,approved,false);
      if(child.processed_count!==data.length||child.received_count!==data.length)continue;
      completed++;proof.push(child.id,fingerprint(body));
      for(const [id,hash] of hashes){
        if(observed.has(id)&&observed.get(id)!==hash)conflicts++;
        else observed.set(id,hash);
      }
    }
    const ids=[...observed.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    for(let offset=0;offset<ids.length;offset+=this.cfg.batchSize){
      const batch=ids.slice(offset,offset+this.cfg.batchSize),records=new Map((await this.recoveryRecords(batch)).map(record=>[record.source_id,record]));
      for(const id of batch){
        const record=records.get(id);
        if(!record)missingLocal++;
        else if(record.source_hash!==observed.get(id)||record.target_table!==this.target)conflicts++;
        else if(!record.present)missingLocal++;
        else{covered++;proof.push(id,record.source_hash);}
      }
    }
    // These are candidate positions from the official bounds, never asserted source IDs.
    const gaps:{start:string;end:string}[]=[],end=BigInt(manifest.operation.end);
    let unobserved=0;
    for(let n=BigInt(manifest.operation.start);n<=end;n++){
      if(observed.has(String(n)))continue;
      unobserved++;
      const last=gaps.at(-1);
      if(last&&BigInt(last.end)+1n===n)last.end=String(n);else gaps.push({start:String(n),end:String(n)});
    }
    const pending=(await this.unresolved()).filter(read=>read.id!==parentId).length;
    const blocks=manifest.ranges.filter(range=>children.some(child=>child.state==='done'&&child.spec.kind==='reread'&&!child.spec.recovery?.missingOnly&&child.spec.start===range.start&&child.spec.end===range.end)).length;
    const coverageComplete=unobserved===0&&conflicts===0&&missingLocal===0&&covered===Number(manifest.operation.quantity)&&completed===children.length&&blocks===manifest.ranges.length&&pending===0;
    // V2 authorizes evidence gathering, not assertions about completion or cursor safety.
    // Even exhaustive observed coverage cannot resolve the uncertain original operation.
    return {parent_id:parentId,parent_state:parent.state,complete:false,resolution_allowed:false,reconciliation_required:true,
      expected:Number(manifest.operation.quantity),covered,missing:missingLocal,conflicts,children:children.length,completed,pending,
      candidate_positions:Number(end-BigInt(manifest.operation.start)+1n),observed_unique:observed.size,unobserved_positions:unobserved,
      blocks_completed:blocks,coverage_complete:coverageComplete,coverage_digest:coverageComplete?fingerprint(JSON.stringify(proof)):null,
      verification_digest:null,unobserved_ranges:gaps};
  }
  private async persist(readId: string, input: MappedRecord[], processed: number, received: number) {
    const db = this.db();
    const unique = new Map<string, MappedRecord>();
    for (const row of input) {
      if (unique.has(row.source_id) && unique.get(row.source_id)!.source_hash !== row.source_hash) throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
      unique.set(row.source_id, row);
    }
    const batch = [...unique.values()];

    if (this.delivery) {
      await db.query('BEGIN');
      try {
        const result = await this.delivery.enqueue(db, this.sequence, batch);
        await db.query('UPDATE olos_http.reads SET processed_count=$2,received_count=$3 WHERE id=$1', [readId, processed, received]);
        await db.query('COMMIT');
        // Queued locally is not a corporate INSERT or acknowledgement.
        return { inserted: 0, updated: 0, queued: result.queued, skipped: result.skipped, duplicates: input.length - result.queued - result.skipped };
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    }

    if (batch.length === 0) {
      await db.query('BEGIN');
      try {
        await db.query(
          'UPDATE olos_http.reads SET processed_count=$2,received_count=$3 WHERE id=$1',
          [readId, processed, received]
        );
        await db.query('COMMIT');
        return { inserted: 0, updated: 0, duplicates: 0 };
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }

    await db.query('BEGIN');
    try {
      // Prevent a concurrent destination writer/sequence collision from being mistaken for our own row.
      await db.query(`LOCK TABLE ${this.target} IN SHARE ROW EXCLUSIVE MODE`);
      const previous = (await db.query('SELECT source_id,target_id,source_hash,target_table FROM olos_http.records WHERE source_key=$1 AND source_id=ANY($2::text[])', [this.cfg.sourceKey, batch.map(r => r.source_id)])).rows;
      const existing = new Map(previous.map(r => [r.source_id as string, r]));
      for (const row of batch) {
        const prev = existing.get(row.source_id);
        if (prev && (prev.source_hash !== row.source_hash || prev.target_table !== this.target)) throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
      }
      const inserted = batch.filter(r => !existing.has(r.source_id)).length;
      const markers = (await db.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,campaign_id,disposition_id)
        SELECT $1,x.source_id,$2,nextval($3::regclass),x.source_hash,x.agent_id,x.campaign_id,x.disposition_id
        FROM jsonb_to_recordset($4::jsonb) AS x(source_id text,source_hash text,agent_id text,campaign_id text,disposition_id text)
        WHERE NOT EXISTS (SELECT 1 FROM olos_http.records r WHERE r.source_key=$1 AND r.source_id=x.source_id)
        RETURNING source_id,target_id`, [this.cfg.sourceKey, this.target, this.sequence, JSON.stringify(batch)])).rows;
      for (const row of markers) existing.set(row.source_id, row);
      const payload = batch.map(row => ({ ...row, internal_id_olos: existing.get(row.source_id)!.target_id }));
      const occupied = new Set((await db.query(`SELECT internal_id_olos FROM ${this.target} WHERE internal_id_olos=ANY($1::bigint[])`, [payload.map(r => r.internal_id_olos)])).rows.map(r => r.internal_id_olos));
      if (markers.some(r => occupied.has(r.target_id)) || previous.some(r => !occupied.has(r.target_id))) throw new WorkerError('DESTINATION_ID_CONFLICT');
      const names = columns.map(quote).join(',');
      const declarations = columns.map(c => `${quote(c)} ${c === 'data_ligacao' ? 'timestamptz' : c === 'tma_origem' ? 'numeric' : c === 'raw_olos_call_id' ? 'text' : 'text'}`).join(',');
      // Pending fields are literal NULL: compatible with a nullable legacy bigint raw_olos_call_id or integer tma.
      const selections = columns.map(c => c === 'raw_olos_call_id' ? 'NULL' : quote(c)).join(',');
      const result = await db.query(`INSERT INTO ${this.target} AS d (internal_id_olos,${names}) OVERRIDING SYSTEM VALUE
        SELECT internal_id_olos,${selections} FROM jsonb_to_recordset($1::jsonb) AS x(internal_id_olos bigint,${declarations})
        ON CONFLICT (internal_id_olos) DO UPDATE SET
          nome_agente=COALESCE(EXCLUDED.nome_agente,d.nome_agente),
          nome_campanha_olos=COALESCE(EXCLUDED.nome_campanha_olos,d.nome_campanha_olos),
          nome_tabulacao_olos=COALESCE(EXCLUDED.nome_tabulacao_olos,d.nome_tabulacao_olos),
          tma_origem=COALESCE(d.tma_origem,EXCLUDED.tma_origem)
        WHERE (EXCLUDED.nome_agente IS NOT NULL AND d.nome_agente IS DISTINCT FROM EXCLUDED.nome_agente)
          OR (EXCLUDED.nome_campanha_olos IS NOT NULL AND d.nome_campanha_olos IS DISTINCT FROM EXCLUDED.nome_campanha_olos)
          OR (EXCLUDED.nome_tabulacao_olos IS NOT NULL AND d.nome_tabulacao_olos IS DISTINCT FROM EXCLUDED.nome_tabulacao_olos)
          OR (d.tma_origem IS NULL AND EXCLUDED.tma_origem IS NOT NULL)`, [JSON.stringify(payload)]);
      await db.query('UPDATE olos_http.reads SET processed_count=$2,received_count=$3 WHERE id=$1', [readId, processed, received]);
      await db.query('COMMIT');
      return { inserted, updated: (result.rowCount ?? 0) - inserted, duplicates: input.length - inserted };
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  }
  async reconcileNames(cache: Cache) {
    if (this.delivery) return 0; // Frozen corporate calls are never rewritten by reference-cache refreshes.
    let updated = 0;
    const db = this.db();
    for (const [refs, refColumn, destColumn] of [[cache.users,'agent_id','nome_agente'],[cache.campaigns,'campaign_id','nome_campanha_olos'],[cache.dispositions,'disposition_id','nome_tabulacao_olos']] as const) {
      const entries = [...refs].map(([id, name]) => ({ id, name }));
      for (let offset = 0; offset < entries.length; offset += this.cfg.batchSize) {
        const result = await db.query(`UPDATE ${this.target} d SET ${quote(destColumn)}=x.name FROM olos_http.records r,
          jsonb_to_recordset($1::jsonb) AS x(id text,name text) WHERE r.source_key=$2 AND r.target_table=$3
          AND r.${refColumn}=x.id AND d.internal_id_olos=r.target_id AND d.${quote(destColumn)} IS DISTINCT FROM x.name`, [JSON.stringify(entries.slice(offset,offset+this.cfg.batchSize)), this.cfg.sourceKey, this.target]);
        updated += result.rowCount ?? 0;
      }
    }
    return updated;
  }
  async resolve(id: string, evidence: string) {
    if (evidence.trim().length < 10) throw new WorkerError('RECONCILIATION_EVIDENCE_REQUIRED');
    const parent=(await this.db().query<Read & {resolution:string|null}>('SELECT spec,error_code,state,resolution FROM olos_http.reads WHERE id=$1 AND source_key=$2',[id,this.cfg.sourceKey])).rows[0];
    if(parent?.spec.kind==='reread'&&parent.spec.recovery)throw new WorkerError('RECOVERY_CHILD_RESOLUTION_FORBIDDEN');
    if(parent?.error_code==='RESPONSE_TOO_LARGE'||parent?.spec.recovery_authorization){
      const report=await this.verifyRecovery(id);
      if(!report.complete||evidence!==`recovery:${report.verification_digest}`)throw new WorkerError('RECOVERY_COVERAGE_NOT_PROVEN');
      if(parent.state==='resolved'&&parent.resolution===evidence)return;
    }
    const result = await this.db().query("UPDATE olos_http.reads SET state='resolved',resolution=$3,finished_at=clock_timestamp() WHERE id=$1 AND source_key=$2 AND state='reading'", [id,this.cfg.sourceKey,evidence]);
    if (result.rowCount !== 1) throw new WorkerError('UNRESOLVED_READ_NOT_FOUND');
  }
  async close() {
    try { await this.delivery?.close(); }
    finally {
      this.alive = false;
      if (this.client) { this.client.release(true); this.client = undefined; }
      await this.pool.end();
    }
  }
}
