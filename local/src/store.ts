import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/client/index.js';
import { rows } from '../../src/api.js';
import { type Cache } from '../../src/mapping.js';
import { WorkerError, errorCode } from '../../src/errors.js';
import { lockSource } from '../../src/source-lock.js';
import { type LocalConfig } from './config.js';
import { baselineTime,digest,inspectContract,normalize,emptyCache,NORMALIZATION_VERSION } from './normalization.js';

export type BaselinePlan={baseline:string;baselineEvidence:string;identityEvidence:string;contractOrigin:'fixture'|'observed'};
export class LocalStore {
  readonly db:PrismaClient;
  readonly pool:pg.Pool;
  private lock:pg.PoolClient|undefined;
  private alive=false;
  private busy=false;
  constructor(readonly cfg:LocalConfig) {
    this.pool=new pg.Pool({connectionString:cfg.databaseUrl,max:4,connectionTimeoutMillis:10000,statement_timeout:30000,application_name:'olos-local-prisma'});
    this.pool.on('error',()=>{this.alive=false;});
    this.db=new PrismaClient({adapter:new PrismaPg(this.pool,{disposeExternalPool:false})});
  }
  async open() {
    this.lock=await this.pool.connect();this.lock.on('error',()=>{this.alive=false;});
    await lockSource(this.lock,this.cfg.sourceKey);this.alive=true;
    await this.db.checkpoint.count();
  }
  private assertAlive(){if(!this.alive)throw new WorkerError('DATABASE_SESSION_LOST');}
  private async exclusively<T>(fn:()=>Promise<T>):Promise<T> {
    this.assertAlive();if(this.busy)throw new WorkerError('LOCAL_OPERATION_ALREADY_ACTIVE');
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  private async checkpoint() {
    this.assertAlive();const cp=await this.db.checkpoint.findUnique({where:{sourceKey:this.cfg.sourceKey}});
    if(!cp)throw new WorkerError('LOCAL_BASELINE_REQUIRED');
    if(cp.sourceTimeZone!==(this.cfg.sourceTimeZone??null))throw new WorkerError('BASELINE_TIME_ZONE_CHANGED');
    return cp;
  }
  async baseline(plan:BaselinePlan,sample:string) {
    return this.exclusively(async()=>{
      const time=baselineTime(plan.baseline);
      if(!['fixture','observed'].includes(plan.contractOrigin)||!plan.baselineEvidence?.trim()||!plan.identityEvidence?.trim())throw new WorkerError('BASELINE_EVIDENCE_REQUIRED');
      const inspected=inspectContract(sample,this.cfg.sourceTimeZone);
      if(inspected.repeatedIds)throw new WorkerError('CONTRACT_SAMPLE_REPEATED_IDS');
      const data={sourceKey:this.cfg.sourceKey,baseline:time,baselineEvidence:plan.baselineEvidence,
        identityEvidence:plan.identityEvidence,contractOrigin:plan.contractOrigin,contractDigest:inspected.digest,sourceTimeZone:this.cfg.sourceTimeZone??null};
      const existing=await this.db.checkpoint.findUnique({where:{sourceKey:this.cfg.sourceKey}});
      if(existing){
        if(Object.entries(data).some(([k,v])=>existing[k as keyof typeof existing]!==v))throw new WorkerError('BASELINE_IMMUTABLE');
        return;
      }
      this.assertAlive();await this.db.checkpoint.create({data});
    });
  }
  async stage(body:string) {
    return this.exclusively(async()=>{
      await this.checkpoint();
      const responseHash=digest(body);
      const pending=await this.db.ingestionRun.findFirst({where:{sourceKey:this.cfg.sourceKey,state:{not:'done'}}});
      if(pending && pending.responseHash!==responseHash)throw new WorkerError('LOCAL_PENDING_RUN_REQUIRES_RECOVERY');
      // Keep the exact response text before parsing. This also makes invalid JSON recoverable/auditable.
      return this.db.ingestionRun.upsert({where:{sourceKey_responseHash:{sourceKey:this.cfg.sourceKey,responseHash}},
        update:{},create:{sourceKey:this.cfg.sourceKey,responseHash,responseBody:body}});
    });
  }
  async process(runId:string,cache:Cache=emptyCache()) {
    return this.exclusively(async()=>{
      const start=performance.now();const cp=await this.checkpoint();
      const run=await this.db.ingestionRun.findFirst({where:{id:runId,sourceKey:this.cfg.sourceKey}});
      if(!run)throw new WorkerError('LOCAL_RUN_NOT_FOUND');
      if(run.state==='done')return {received:run.receivedCount??0,inserted:0,normalized:0,excluded:0,duplicates:run.receivedCount??0,batches:0,duration_ms:0,alreadyCompleted:true};
      const totals={received:0,inserted:0,normalized:0,excluded:0,duplicates:0,batches:0,duration_ms:0,alreadyCompleted:false};
      try {
        const records=rows(run.responseBody);totals.received=records.length;
        const seen=new Map<string,string>();
        for(const record of records) {
          const n=normalize(record,cp.baseline,cache,this.cfg.sourceTimeZone);
          if(seen.has(n.sourceId)&&seen.get(n.sourceId)!==n.payloadHash)throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
          seen.set(n.sourceId,n.payloadHash);
        }
        // Even [] has one atomic completion transaction.
        for(let offset=run.processedCount;offset<records.length || (offset===records.length && totals.batches===0);offset+=this.cfg.batchSize){
          this.assertAlive();const chunk=records.slice(offset,offset+this.cfg.batchSize);
          const unique=new Map<string,{payload:Record<string,unknown>;n:ReturnType<typeof normalize>}>();
          for(const payload of chunk){const n=normalize(payload,cp.baseline,cache,this.cfg.sourceTimeZone);unique.set(n.sourceId,{payload,n});}
          const result=await this.db.$transaction(async tx=>{
            const progress=await tx.ingestionRun.findUniqueOrThrow({where:{id:run.id}});
            if(progress.processedCount!==offset||progress.state==='done')throw new WorkerError('CHECKPOINT_CONFLICT');
            const previous=await tx.rawRecord.findMany({where:{sourceKey:this.cfg.sourceKey,sourceId:{in:[...unique.keys()]}},select:{sourceId:true,payloadHash:true}});
            const known=new Map(previous.map(r=>[r.sourceId,r.payloadHash]));
            for(const {n} of unique.values())if(known.has(n.sourceId)&&known.get(n.sourceId)!==n.payloadHash)throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
            const fresh=[...unique.values()].filter(({n})=>!known.has(n.sourceId)).map(entry=>({...entry,id:randomUUID()}));
            await tx.rawRecord.createMany({data:fresh.map(({id,n,payload})=>({id,sourceKey:this.cfg.sourceKey,sourceId:n.sourceId,payloadHash:n.payloadHash,payload:payload as Prisma.InputJsonObject,firstRunId:run.id}))});
            await tx.normalizedRecord.createMany({data:fresh.map(({id,n})=>({rawId:id,version:NORMALIZATION_VERSION,disposition:n.disposition,document:n.document}))});
            const excluded=fresh.filter(({n})=>n.disposition==='before_baseline').length;
            const next=offset+chunk.length,done=next===records.length;
            const changed=await tx.ingestionRun.updateMany({where:{id:run.id,processedCount:offset,state:{not:'done'}},data:{
              processedCount:next,receivedCount:records.length,normalizedCount:{increment:fresh.length-excluded},excludedCount:{increment:excluded},
              duplicateCount:{increment:chunk.length-fresh.length},state:done?'done':'received',completedAt:done?new Date():null,errorCode:null}});
            if(changed.count!==1)throw new WorkerError('CHECKPOINT_CONFLICT');
            await tx.checkpoint.update({where:{sourceKey:this.cfg.sourceKey},data:{committedRecords:{increment:fresh.length},
              ...(done?{completedRuns:{increment:1},lastCompletedRunId:run.id}:{})}});
            this.assertAlive();
            return {inserted:fresh.length,normalized:fresh.length-excluded,excluded,duplicates:chunk.length-fresh.length};
          },{timeout:30000});
          totals.inserted+=result.inserted;totals.normalized+=result.normalized;totals.excluded+=result.excluded;totals.duplicates+=result.duplicates;totals.batches++;
          if(offset+chunk.length===records.length)break;
        }
        totals.duration_ms=Math.round(performance.now()-start);return totals;
      } catch(error) {
        if(this.alive)await this.db.ingestionRun.updateMany({where:{id:run.id,state:{not:'done'}},data:{errorCode:errorCode(error)}}).catch(()=>{});
        throw error;
      }
    });
  }
  async resume(cache:Cache=emptyCache()) {
    this.assertAlive();const pending=await this.db.ingestionRun.findMany({where:{sourceKey:this.cfg.sourceKey,state:{not:'done'}},orderBy:{startedAt:'asc'},select:{id:true}});
    const result=[];for(const run of pending)result.push(await this.process(run.id,cache));return result;
  }
  async reprocess(cache:Cache=emptyCache()) {
    return this.exclusively(async()=>{
      const cp=await this.checkpoint();let cursor:string|undefined;let processed=0;const start=performance.now();
      for(;;){
        this.assertAlive();const raw=await this.db.rawRecord.findMany({where:{sourceKey:this.cfg.sourceKey},orderBy:{id:'asc'},take:this.cfg.batchSize,...(cursor?{cursor:{id:cursor},skip:1}:{})});
        if(!raw.length)break;
        const docs=raw.map(row=>{const n=normalize(row.payload as Record<string,unknown>,cp.baseline,cache,this.cfg.sourceTimeZone);return {raw_id:row.id,version:NORMALIZATION_VERSION,disposition:n.disposition,document:n.document};});
        await this.db.$transaction(async tx=>{
          // Prisma has no batched upsert API; parameterized SQL keeps one statement per batch.
          await tx.$executeRaw`INSERT INTO local_olos.normalized_records(raw_id,version,disposition,document,normalized_at)
            SELECT raw_id,version,disposition,document,clock_timestamp() FROM jsonb_to_recordset(${JSON.stringify(docs)}::jsonb)
              AS x(raw_id uuid,version integer,disposition text,document jsonb)
            ON CONFLICT(raw_id,version) DO UPDATE SET disposition=EXCLUDED.disposition,document=EXCLUDED.document,normalized_at=EXCLUDED.normalized_at`;
          this.assertAlive();
        });
        processed+=raw.length;cursor=raw.at(-1)!.id;
      }
      return {processed,version:NORMALIZATION_VERSION,duration_ms:Math.round(performance.now()-start)};
    });
  }
  async status() {
    this.assertAlive();const cp=await this.db.checkpoint.findUnique({where:{sourceKey:this.cfg.sourceKey}});
    return {baseline:cp?.baseline??null,contractOrigin:cp?.contractOrigin??null,committedRecords:cp?.committedRecords??0,
      completedRuns:cp?.completedRuns??0,pendingRuns:await this.db.ingestionRun.count({where:{sourceKey:this.cfg.sourceKey,state:{not:'done'}}}),
      rawRecords:await this.db.rawRecord.count({where:{sourceKey:this.cfg.sourceKey}}),remoteIngestionEnabled:false};
  }
  async close(){await this.db.$disconnect();this.alive=false;if(this.lock){this.lock.release(true);this.lock=undefined;}await this.pool.end();}
}
