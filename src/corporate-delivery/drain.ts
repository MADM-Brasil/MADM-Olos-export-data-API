import { identityAdopted, identityDeliveryGate } from '../identity/gates.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg, { type Client, type PoolClient } from 'pg';
import type { Config } from '../config.js';
import { Store } from '../store.js';
import { log } from '../errors.js';
import { connect, rollback } from '../corporate-sync/database.js';
import { safeCode, SyncError } from '../corporate-sync/errors.js';
import { columns, quote, type Shape } from '../corporate-sync/mapping.js';
import { corporateSchema, matches } from './contract.js';
import { assertLocalConsumersCompatible } from './local-consumers.js';
import { operatorColumn } from './payload.js';
import { preservedHistoryRead } from './preserved-history.js';
import { lockRemoteSelection, selectedRows, type SelectedEntry } from './selective-commit.js';
import { drainConsent, drainHash, validateDrainLimits, validateDrainRequest, type DrainLimits, type DrainRequest } from './drain-request.js';

export const drainBlock = 'DRAIN_RECONCILIATION_REQUIRED';
interface Entry extends SelectedEntry { eligible: boolean; record_created: string; outbox_created: string }
interface Run {
  run_id: string; source_key: string; target_table: string; binding: string; schema_hash: string;
  history_snapshot: Record<string, unknown>; limits: DrainLimits; plan_hash: string; selected_count: number;
  state: string; last_code: string | null;
}
interface Batch {
  run_id: string; batch_no: number; evidence: ReturnType<typeof frozen>; state: string;
  confirmed_count: number; existing_count: number | null; duration_ms: number | null; outcome: unknown;
}
export interface DrainHooks {
  beforeRemoteCommit?: () => Promise<void>;
  afterIntent?: () => Promise<void>;
  afterRemoteCommit?: () => Promise<void>;
  beforeLocalCommit?: () => Promise<void>;
  afterBatch?: (batchNo: number) => Promise<void>;
}

// No payload/PII in the authorization manifest. Timestamps retain PostgreSQL precision.
function frozen(entries: Entry[]) {
  return entries.map(e => ({source_id:e.source_id,target_id:e.target_id,source_hash:e.source_hash,
    payload_hash:e.payload_hash,origin:e.origin,agent_id:e.agent_id,
    record_created:e.record_created,outbox_created:e.outbox_created}));
}
function manifest(run: Run, batches: Batch[]) {
  return {runId:run.run_id,source:run.source_key,target:run.target_table,binding:run.binding,schema:run.schema_hash,
    history:run.history_snapshot,limits:run.limits,selected:run.selected_count,
    batches:batches.map(b => ({number:b.batch_no,evidence:b.evidence}))};
}
function assertManifest(run: Run, batches: Batch[]) {
  validateDrainLimits(run.limits);
  if (!batches.length || batches.length > run.limits.maxBatches ||
    batches.some((b,i) => b.batch_no !== i+1 || !b.evidence.length || b.evidence.length > run.limits.batchSize) ||
    batches.reduce((n,b) => n+b.evidence.length,0) !== run.selected_count || drainHash(manifest(run,batches)) !== run.plan_hash) {
    throw new SyncError('DRAIN_MANIFEST_CHANGED');
  }
}
async function migration(local: PoolClient) {
  if (!(await local.query(`SELECT to_regclass('olos_http.corporate_drain_runs') IS NOT NULL
    AND to_regclass('olos_http.corporate_drain_batches') IS NOT NULL
    AND to_regclass('olos_http.corporate_selective_commits') IS NOT NULL AS ok`)).rows[0].ok) {
    throw new SyncError('DRAIN_LOCAL_MIGRATION_REQUIRED');
  }
}
async function sessionLocks(local: PoolClient, source: string) {
  if (!(await local.query('SELECT pg_try_advisory_lock(17320914,4) AS ok')).rows[0].ok) throw new SyncError('CORPORATE_DELIVERY_BUSY');
  for (const [key,code] of [[`olos-http:history:${source}`,'HISTORY_CAPTURE_ACTIVE'],[`olos-admin:${source}`,'HISTORY_ADMIN_ACTIVE']]) {
    if (!(await local.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0].ok) throw new SyncError(code!);
  }
}

// Separate, bounded history exception. Does not call or broaden assertPreservedHistory.
async function guard(local: PoolClient, cfg: Config, target: string, run?: Run, ownsBlock = false) {
  await assertLocalConsumersCompatible(local,cfg.sourceKey);
  const settings=(await local.query(`SELECT enabled,desired_state,runtime_state FROM olos_http.worker_settings
    WHERE source_key=$1 FOR SHARE NOWAIT`,[cfg.sourceKey])).rows[0];
  if (!settings || settings.enabled || settings.desired_state !== 'STOPPED' || settings.runtime_state !== 'STOPPED') {
    throw new SyncError('HISTORY_SCHEDULER_NOT_STOPPED');
  }
  const pending=(await local.query(`SELECT to_jsonb(h) AS snapshot FROM olos_http.reads h
    WHERE source_key=$1 AND state IN ('reading','received') FOR SHARE NOWAIT`,[cfg.sourceKey])).rows;
  const h=pending[0]?.snapshot;
  if (pending.length !== 1 || h.id !== preservedHistoryRead || h.spec.kind !== 'history' || h.state !== 'reading' ||
    h.error_code !== 'RESPONSE_TOO_LARGE' || h.response_body !== null || h.processed_count !== 0 || h.finished_at !== null ||
    h.resolution !== null || h.target_table !== target || run && drainHash(h) !== drainHash(run.history_snapshot)) {
    throw new SyncError('DRAIN_HISTORY_CHANGED');
  }
  if (!run && (await local.query(`SELECT 1 FROM olos_http.corporate_drain_runs
    WHERE source_key=$1 AND history_snapshot<>$2::jsonb LIMIT 1`,[cfg.sourceKey,JSON.stringify(h)])).rowCount) {
    throw new SyncError('DRAIN_HISTORY_CHANGED');
  }
  const control=(await local.query('SELECT * FROM olos_http.corporate_control WHERE singleton FOR UPDATE NOWAIT')).rows[0];
  if (!control?.ready || !control.paused || control.source_key !== cfg.sourceKey || control.target_table !== target ||
    control.binding !== cfg.corporateDelivery!.binding) throw new SyncError('DRAIN_CONTROL_INVALID');
  if (new Map(control.destination_shape).has(operatorColumn)) throw new SyncError('HISTORY_V1_SCHEMA_REQUIRED');
  if (run && (run.binding !== control.binding || run.source_key !== cfg.sourceKey || run.target_table !== target ||
    run.schema_hash !== control.schema_hash)) throw new SyncError('DRAIN_BINDING_CHANGED');
  if (ownsBlock ? !control.blocked || control.last_code !== drainBlock : control.blocked || control.last_code === 'CORPORATE_COMMIT_UNKNOWN') {
    throw new SyncError('CORPORATE_DELIVERY_BLOCKED');
  }
  if ((await local.query("SELECT 1 FROM olos_http.corporate_selective_commits WHERE state='unresolved'")).rowCount) {
    throw new SyncError('SELECTIVE_COMMIT_RECONCILIATION_REQUIRED');
  }
  return {history:h as Record<string,unknown>,control};
}

async function entries(local: PoolClient, source: string, target: string, ids: string[]): Promise<Entry[]> {
  const result=(await local.query<Entry>(`SELECT o.source_id,o.target_id::text,o.payload,o.payload_hash,o.state,
    o.remote_raw_id::text,o.source_hash,o.origin,r.source_hash AS record_hash,r.target_id::text AS record_target_id,
    r.target_table,r.agent_id,r.created_at::text AS record_created,o.created_at::text AS outbox_created,
    r.created_at<h.started_at AND o.created_at<h.started_at AS eligible
    FROM olos_http.corporate_outbox o JOIN olos_http.records r USING(source_key,source_id)
    JOIN olos_http.reads h ON h.id=$3
    WHERE o.source_key=$1 AND o.source_id=ANY($2::text[]) ORDER BY o.target_id FOR UPDATE OF o,r NOWAIT`,
  [source,ids,preservedHistoryRead])).rows;
  if (result.length !== ids.length || result.some(e => !/^[1-9][0-9]{0,18}$/.test(e.source_id) || BigInt(e.source_id)>9223372036854775807n ||
    !e.eligible || !['capture','legacy_backlog'].includes(e.origin) ||
    !['pending','confirmed'].includes(e.state) || e.source_hash !== e.record_hash || e.target_id !== e.record_target_id ||
    e.target_table !== target || Object.keys(e.payload).length !== columns.length || columns.some(c => !Object.hasOwn(e.payload,c)))) {
    throw new SyncError('DRAIN_RECEIPT_INVALID');
  }
  await identityDeliveryGate(local,result);
  return result;
}
async function batchEntries(local: PoolClient, run: Run, batch: Batch, shape: Shape, cfg: Config) {
  const found=await entries(local,run.source_key,run.target_table,batch.evidence.map(e => e.source_id));
  if (drainHash(frozen(found)) !== drainHash(batch.evidence)) throw new SyncError('DRAIN_EVIDENCE_CHANGED');
  selectedRows(found,shape,cfg.corporateDelivery!);
  return found;
}
async function load(local: PoolClient, runId: string) {
  const run=(await local.query<Run>('SELECT * FROM olos_http.corporate_drain_runs WHERE run_id=$1 FOR UPDATE NOWAIT',[runId])).rows[0];
  if (!run) throw new SyncError('DRAIN_RUN_NOT_FOUND');
  const batches=(await local.query<Batch>('SELECT * FROM olos_http.corporate_drain_batches WHERE run_id=$1 ORDER BY batch_no FOR UPDATE NOWAIT',[runId])).rows;
  assertManifest(run,batches); return {run,batches};
}
async function assertStage(local: PoolClient, cfg: Config, limits: DrainLimits, schemaHash: string) {
  // Only full, measured, acknowledged runs qualify. Reconciliation is not a latency measurement.
  const result=(await local.query(`SELECT r.limits->>'batchSize' AS size FROM olos_http.corporate_drain_runs r
    WHERE r.source_key=$1 AND r.binding=$2 AND r.schema_hash=$3 AND r.state='completed'
    AND EXISTS(SELECT 1 FROM olos_http.corporate_drain_batches b WHERE b.run_id=r.run_id
      AND b.confirmed_count=(r.limits->>'batchSize')::int)
    AND NOT EXISTS(SELECT 1 FROM olos_http.corporate_drain_batches b WHERE b.run_id=r.run_id
      AND (b.state<>'acknowledged' OR b.duration_ms IS NULL OR b.duration_ms>(r.limits->>'maxBatchMs')::int))`,
  [cfg.sourceKey,cfg.corporateDelivery!.binding,schemaHash])).rows;
  const sizes=result.map(r => Number(r.size));
  if (!sizes.length && (limits.batchSize !== 100 || limits.maxBatches !== 1)) throw new SyncError('DRAIN_FIRST_RUN_REQUIRES_100');
  const ceiling=sizes.includes(500) ? 1000 : sizes.includes(250) ? 500 : sizes.includes(100) ? 250 : 100;
  if (limits.batchSize > ceiling) throw new SyncError('DRAIN_STAGE_NOT_PROVEN');
  return sizes.length === 0;
}
function remoteConfig(cfg: Config, limits: DrainLimits) {
  return {...cfg.corporateDelivery!.connection,timeoutMs:Math.min(cfg.corporateDelivery!.connection.timeoutMs,limits.statementTimeoutMs)};
}
async function checkRemote(remote: Client, cfg: Config, schemaHash: string, write: boolean) {
  const result=await corporateSchema(remote,cfg.corporateDelivery!,write);
  if (result.hash !== schemaHash || result.shape.has(operatorColumn)) throw new SyncError('CORPORATE_SCHEMA_CHANGED');
  return result.shape;
}

async function plan(store: Store, cfg: Config, limits: DrainLimits) {
  const local=store.client!;
  await local.query('BEGIN');
  const {history,control}=await guard(local,cfg,store.target);
  if ((await local.query("SELECT 1 FROM olos_http.corporate_drain_runs WHERE state IN ('planned','running','failed')")).rowCount) {
    throw new SyncError('DRAIN_OPEN_RUN_EXISTS');
  }
  const first=await assertStage(local,cfg,limits,control.schema_hash);
  // LIMIT is only used to make a durable manifest; execution never selects new IDs.
  const originalOnly=await identityAdopted(local);
  const ids=(await local.query(`SELECT o.source_id FROM olos_http.corporate_outbox o JOIN olos_http.reads h ON h.id=$2
    WHERE o.source_key=$1 AND o.state='pending' AND o.created_at<h.started_at
    AND (NOT $4::boolean OR o.target_id::text=o.source_id)
    ORDER BY o.target_id LIMIT $3 FOR UPDATE OF o NOWAIT`,[cfg.sourceKey,preservedHistoryRead,limits.batchSize*limits.maxBatches,originalOnly])).rows.map(r => r.source_id as string);
  if (!ids.length || first && ids.length !== 100) throw new SyncError('DRAIN_INSUFFICIENT_BACKLOG');
  const selected=await entries(local,cfg.sourceKey,store.target,ids);
  const remote=await connect(remoteConfig(cfg,limits),'destination');
  try {
    await remote.query('BEGIN READ ONLY');
    const shape=await checkRemote(remote,cfg,control.schema_hash,false);
    selectedRows(selected,shape,cfg.corporateDelivery!);
  } finally { await rollback(remote); await remote.end().catch(() => {}); }
  const run: Run={run_id:randomUUID(),source_key:cfg.sourceKey,target_table:store.target,binding:control.binding,
    schema_hash:control.schema_hash,history_snapshot:history,limits,plan_hash:'',selected_count:selected.length,state:'planned',last_code:null};
  const batches: Batch[]=[];
  for (let offset=0; offset<selected.length; offset+=limits.batchSize) batches.push({run_id:run.run_id,batch_no:batches.length+1,
    evidence:frozen(selected.slice(offset,offset+limits.batchSize)),state:'planned',confirmed_count:0,existing_count:null,duration_ms:null,outcome:null});
  run.plan_hash=drainHash(manifest(run,batches));
  await local.query(`INSERT INTO olos_http.corporate_drain_runs
    (run_id,source_key,target_table,binding,schema_hash,history_snapshot,limits,plan_hash,selected_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[run.run_id,run.source_key,run.target_table,run.binding,run.schema_hash,
    JSON.stringify(history),JSON.stringify(limits),run.plan_hash,run.selected_count]);
  for (const b of batches) await local.query('INSERT INTO olos_http.corporate_drain_batches(run_id,batch_no,evidence) VALUES($1,$2,$3)',
    [run.run_id,b.batch_no,JSON.stringify(b.evidence)]);
  await store.ping(); await local.query('COMMIT');
  const result={run_id:run.run_id,plan_hash:run.plan_hash,selected:run.selected_count,batches:batches.length,
    confirmation:drainConsent('execute',run.run_id,run.plan_hash)};
  log('corporate_drain_planned',{...result,source:cfg.sourceKey,history_read:preservedHistoryRead,contract:'v1',
    batch_size:limits.batchSize,max_batches:limits.maxBatches,delay_ms:limits.delayMs,max_batch_ms:limits.maxBatchMs,
    statement_timeout_ms:limits.statementTimeoutMs}); return result;
}

async function confirm(local: PoolClient, run: Run, selected: Entry[], found: Map<string,string>) {
  let confirmed=0;
  for (const entry of selected) {
    if (entry.state === 'confirmed') {
      if (found.get(entry.target_id) !== entry.remote_raw_id) throw new SyncError('SELECTIVE_CONFIRMED_RECEIPT_DIVERGES');
      continue;
    }
    if (!found.has(entry.target_id)) continue;
    if ((await local.query(`UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=$3,confirmed_at=now()
      WHERE source_key=$1 AND source_id=$2 AND state='pending' AND payload_hash=$4 AND source_hash=$5 AND target_id=$6`,
    [run.source_key,entry.source_id,found.get(entry.target_id),entry.payload_hash,entry.source_hash,entry.target_id])).rowCount !== 1) {
      throw new SyncError('CORPORATE_RECEIPT_FENCE_LOST');
    }
    confirmed++;
  }
  await local.query(`UPDATE olos_http.corporate_control SET confirmed_count=confirmed_count+$1,generation=generation+1,updated_at=now()
    WHERE singleton`,[confirmed]);
  return confirmed;
}
function outcomes(selected: Entry[], found: Map<string,string>) {
  return selected.map(e => ({source_id:e.source_id,target_id:e.target_id,payload_hash:e.payload_hash,remote_raw_id:found.get(e.target_id) ?? null}));
}
async function finish(local: PoolClient, run: Run, state: 'completed' | 'stopped' | 'reconciled', code: string | null = null) {
  if ((await local.query(`UPDATE olos_http.corporate_control SET paused=true,blocked=false,last_code=NULL,
    failure_count=0,next_attempt_at=NULL,updated_at=now() WHERE singleton AND blocked AND last_code=$1`,[drainBlock])).rowCount !== 1) {
    throw new SyncError('DRAIN_FENCE_LOST');
  }
  await local.query('UPDATE olos_http.corporate_drain_runs SET state=$2,last_code=$3,finished_at=clock_timestamp() WHERE run_id=$1',
    [run.run_id,state,code]);
}
async function fail(local: PoolClient, run: Run, error: unknown) {
  await rollback(local);
  // If the local connection is lost, the earlier running state/block/intent remains durable.
  try {
    await local.query('BEGIN');
    await local.query(`UPDATE olos_http.corporate_drain_runs SET state='failed',last_code=$2 WHERE run_id=$1 AND state IN ('running','failed')`,
      [run.run_id,safeCode(error)]);
    await local.query('COMMIT');
  } catch { await rollback(local); }
  log('corporate_drain_stopped',{run_id:run.run_id,error:safeCode(error),reconciliation_required:true});
}

async function deliverBatch(store: Store, cfg: Config, run: Run, batch: Batch, signal: AbortSignal, hooks: DrainHooks) {
  const local=store.client!, start=performance.now();
  let remote: Client | undefined, durable=false;
  const deadline=() => {
    if (signal.aborted) throw new SyncError('DRAIN_CANCELLED');
    if (performance.now()-start>run.limits.maxBatchMs) throw new SyncError('DRAIN_LATENCY_LIMIT');
  };
  try {
    await local.query('BEGIN');
    const {control}=await guard(local,cfg,store.target,run,true);
    let selected=await batchEntries(local,run,batch,new Map(control.destination_shape),cfg);
    if (selected.some(e => e.state !== 'pending')) throw new SyncError('DRAIN_EVIDENCE_CHANGED');
    deadline(); await store.ping();
    remote=await connect(remoteConfig(cfg,run.limits),'destination');
    await remote.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await remote.query("SELECT set_config('idle_in_transaction_session_timeout','30000',true)");
    await lockRemoteSelection(remote);
    await remote.query('LOCK TABLE raw.olos_calls IN ROW EXCLUSIVE MODE');
    const shape=await checkRemote(remote,cfg,run.schema_hash,true);
    const rows=selectedRows(selected,shape,cfg.corporateDelivery!);
    let found=await matches(remote,rows,shape,cfg.corporateDelivery!);
    const existing=found.size;
    for (const row of rows) {
      deadline(); await store.ping();
      if (found.has(row.internal_id_olos!)) continue;
      await remote.query(`INSERT INTO raw.olos_calls (${columns.map(quote).join(',')})
        VALUES (${columns.map((_,i) => `$${i+1}`).join(',')})
        ON CONFLICT (internal_id_olos) WHERE internal_id_olos IS NOT NULL DO NOTHING`,columns.map(c => row[c]));
    }
    found=await matches(remote,rows,shape,cfg.corporateDelivery!);
    if (found.size !== rows.length) throw new SyncError('CORPORATE_VERIFICATION_FAILED');
    await hooks.beforeRemoteCommit?.(); deadline(); await store.ping();
    if ((await local.query(`UPDATE olos_http.corporate_drain_batches SET state='intent',intent_at=clock_timestamp(),existing_count=$3
      WHERE run_id=$1 AND batch_no=$2 AND state='planned'`,[run.run_id,batch.batch_no,existing])).rowCount !== 1) throw new SyncError('DRAIN_FENCE_LOST');
    // No remote COMMIT until the independent local intent COMMIT is acknowledged.
    await local.query('COMMIT'); durable=true;
    log('corporate_drain_intent',{run_id:run.run_id,batch:batch.batch_no,selected:rows.length});
    await hooks.afterIntent?.();
    await local.query('BEGIN');
    await guard(local,cfg,store.target,run,true);
    const refreshed=await load(local,run.run_id);
    if (refreshed.run.state !== 'running' || refreshed.batches[batch.batch_no-1]?.state !== 'intent') throw new SyncError('DRAIN_FENCE_LOST');
    selected=await batchEntries(local,run,batch,shape,cfg);
    if (selected.some(e => e.state !== 'pending')) throw new SyncError('DRAIN_EVIDENCE_CHANGED');
    deadline(); await store.ping();
    await remote.query('COMMIT');
    await hooks.afterRemoteCommit?.(); await store.ping();
    const confirmed=await confirm(local,run,selected,found);
    const duration=Math.ceil(performance.now()-start);
    await local.query(`UPDATE olos_http.corporate_drain_batches SET state='acknowledged',outcome=$3,confirmed_count=$4,
      duration_ms=$5,finished_at=clock_timestamp() WHERE run_id=$1 AND batch_no=$2 AND state='intent'`,
    [run.run_id,batch.batch_no,JSON.stringify(outcomes(selected,found)),confirmed,duration]);
    await hooks.beforeLocalCommit?.(); await local.query('COMMIT');
    log('corporate_drain_batch_confirmed',{run_id:run.run_id,batch:batch.batch_no,selected:rows.length,confirmed,
      already_existing:existing,duration_ms:duration,receipts:found.size});
    // Latency during the final COMMIT cannot undo that COMMIT. Stop before admitting another batch.
    if (performance.now()-start>run.limits.maxBatchMs) throw new SyncError('DRAIN_LATENCY_LIMIT');
  } catch (error) {
    await rollback(local);
    if (remote) await rollback(remote);
    try {
      await local.query(`UPDATE olos_http.corporate_drain_batches SET duration_ms=$3
        WHERE run_id=$1 AND batch_no=$2 AND state IN ('planned','intent')`,
      [run.run_id,batch.batch_no,Math.ceil(performance.now()-start)]);
    } catch { /* A lost local connection leaves metrics unknown; never infer health. */ }
    if (durable && !(error instanceof SyncError && error.code === 'DRAIN_LATENCY_LIMIT')) throw new SyncError('CORPORATE_COMMIT_UNKNOWN');
    throw error;
  } finally { if (remote) await remote.end().catch(() => {}); }
}

async function execute(store: Store, cfg: Config, request: Extract<DrainRequest,{kind:'execute'}>, signal: AbortSignal, hooks: DrainHooks) {
  const local=store.client!;
  await local.query('BEGIN');
  const {run,batches}=await load(local,request.runId);
  if (run.plan_hash !== request.planHash || drainHash(run.limits) !== drainHash(request.limits)) throw new SyncError('DRAIN_AUTHORIZATION_CHANGED');
  // Repeating a completed/stopped authorization never consumes another LIMIT of pending rows.
  if (['completed','stopped','reconciled'].includes(run.state)) {
    await local.query('ROLLBACK'); log('corporate_drain_replay',{run_id:run.run_id,state:run.state}); return;
  }
  if (run.state !== 'planned') throw new SyncError(drainBlock);
  await guard(local,cfg,store.target,run);
  await assertStage(local,cfg,run.limits,run.schema_hash);
  await local.query("UPDATE olos_http.corporate_drain_runs SET state='running' WHERE run_id=$1",[run.run_id]);
  await local.query(`UPDATE olos_http.corporate_control SET paused=true,blocked=true,last_code=$1,next_attempt_at=NULL,updated_at=now()
    WHERE singleton`,[drainBlock]);
  await local.query('COMMIT');
  try {
    for (const batch of batches) {
      if (signal.aborted) break;
      await deliverBatch(store,cfg,run,batch,signal,hooks);
      await hooks.afterBatch?.(batch.batch_no);
      if (batch.batch_no<batches.length && !signal.aborted) {
        try { await delay(run.limits.delayMs,undefined,{signal}); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
    await local.query('BEGIN'); await guard(local,cfg,store.target,run,true);
    const current=await load(local,run.run_id);
    const complete=current.batches.every(b => b.state === 'acknowledged');
    await finish(local,run,complete?'completed':'stopped',complete?null:'DRAIN_CANCELLED');
    await local.query('COMMIT');
    log('corporate_drain_finished',{run_id:run.run_id,state:complete?'completed':'stopped',
      confirmed:current.batches.reduce((sum,b) => sum+b.confirmed_count,0)});
  } catch (error) { await fail(local,run,error); throw new SyncError(safeCode(error)); }
}

async function reconcile(store: Store, cfg: Config, request: Extract<DrainRequest,{kind:'reconcile'}>, signal: AbortSignal, hooks: DrainHooks) {
  const local=store.client!;
  await local.query('BEGIN');
  const {run,batches}=await load(local,request.runId);
  if (run.plan_hash !== request.planHash) throw new SyncError('DRAIN_AUTHORIZATION_CHANGED');
  if (run.state === 'reconciled') { await local.query('ROLLBACK'); return; }
  if (!['running','failed'].includes(run.state)) throw new SyncError('DRAIN_RECONCILIATION_NOT_PENDING');
  await guard(local,cfg,store.target,run,true);
  await local.query('COMMIT');
  // Bounded reconciliation, one read-only corporate transaction per frozen batch.
  // The durable global block is retained until every batch has been reconciled.
  for (const batch of batches) {
    if (signal.aborted) throw new SyncError('DRAIN_CANCELLED');
    const start=performance.now();
    let remote: Client | undefined;
    try {
      await local.query('BEGIN'); await guard(local,cfg,store.target,run,true);
      const selected=await entries(local,run.source_key,run.target_table,batch.evidence.map(e => e.source_id));
      if (drainHash(frozen(selected)) !== drainHash(batch.evidence)) throw new SyncError('DRAIN_EVIDENCE_CHANGED');
      remote=await connect(remoteConfig(cfg,run.limits),'destination');
      await remote.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await lockRemoteSelection(remote); // Snapshot queries occur after the uncertain writer releases this lock.
      await remote.query('LOCK TABLE raw.olos_calls IN ACCESS SHARE MODE');
      const shape=await checkRemote(remote,cfg,run.schema_hash,false);
      const found=await matches(remote,selectedRows(selected,shape,cfg.corporateDelivery!),shape,cfg.corporateDelivery!);
      for (const e of selected) if (e.state === 'confirmed' && found.get(e.target_id) !== e.remote_raw_id) {
        throw new SyncError('SELECTIVE_CONFIRMED_RECEIPT_DIVERGES');
      }
      await hooks.beforeRemoteCommit?.(); await store.ping(); await remote.query('COMMIT');
      await hooks.afterRemoteCommit?.(); await store.ping();
      await confirm(local,run,selected,found);
      await local.query(`UPDATE olos_http.corporate_drain_batches SET state='reconciled',outcome=$3,
        confirmed_count=$4,finished_at=clock_timestamp() WHERE run_id=$1 AND batch_no=$2`,
      [run.run_id,batch.batch_no,JSON.stringify(outcomes(selected,found)),found.size]);
      await hooks.beforeLocalCommit?.(); await local.query('COMMIT');
      log('corporate_drain_batch_reconciled',{run_id:run.run_id,batch:batch.batch_no,present:found.size,absent:selected.length-found.size});
    } catch (error) { await fail(local,run,error); throw new SyncError(safeCode(error)); }
    finally { if (remote) { await rollback(remote); await remote.end().catch(() => {}); } }
    if (performance.now()-start>run.limits.maxBatchMs) throw new SyncError('DRAIN_LATENCY_LIMIT');
    if (batch.batch_no<batches.length) await delay(run.limits.delayMs,undefined,{signal});
  }
  await local.query('BEGIN'); await guard(local,cfg,store.target,run,true);
  const refreshed=await load(local,run.run_id);
  if (refreshed.batches.some(b => b.state !== 'reconciled')) throw new SyncError('DRAIN_FENCE_LOST');
  await finish(local,run,'reconciled'); await local.query('COMMIT');
  log('corporate_drain_reconciled',{run_id:run.run_id});
}

async function cancelPlan(store: Store, cfg: Config, request: Extract<DrainRequest,{kind:'cancel'}>) {
  const local=store.client!;
  await local.query('BEGIN');
  const {run,batches}=await load(local,request.runId);
  if (run.plan_hash !== request.planHash || run.binding !== cfg.corporateDelivery!.binding ||
    run.source_key !== cfg.sourceKey || run.target_table !== store.target) throw new SyncError('DRAIN_AUTHORIZATION_CHANGED');
  if (run.state === 'stopped' && run.last_code === 'DRAIN_PLAN_CANCELLED') { await local.query('ROLLBACK'); return; }
  if (run.state !== 'planned' || batches.some(b => b.state !== 'planned')) throw new SyncError('DRAIN_PLAN_ALREADY_STARTED');
  // Cancel only an unused authorization. Never touch control blocks, receipts, history or MADM.
  await local.query("UPDATE olos_http.corporate_drain_runs SET state='stopped',last_code='DRAIN_PLAN_CANCELLED',finished_at=clock_timestamp() WHERE run_id=$1",[run.run_id]);
  await local.query('COMMIT'); log('corporate_drain_plan_cancelled',{run_id:run.run_id});
}

async function status(cfg: Config, runId: string) {
  // Can observe an active drain without acquiring its source/delivery locks.
  const pool=new pg.Pool({connectionString:cfg.databaseUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:10000});
  pool.on('error',() => {});
  try {
    const local=await pool.connect(); local.on('error',() => {});
    try {
      await local.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await migration(local);
      const run=(await local.query<Run>('SELECT * FROM olos_http.corporate_drain_runs WHERE run_id=$1',[runId])).rows[0];
      if (!run || run.source_key !== cfg.sourceKey || run.binding !== cfg.corporateDelivery!.binding) throw new SyncError('DRAIN_RUN_NOT_FOUND');
      const batches=(await local.query<Batch>('SELECT * FROM olos_http.corporate_drain_batches WHERE run_id=$1 ORDER BY batch_no',[runId])).rows;
      assertManifest(run,batches);
      const result={run_id:run.run_id,plan_hash:run.plan_hash,state:run.state,selected:run.selected_count,
        confirmed:batches.reduce((n,b) => n+b.confirmed_count,0),error:run.last_code,
        reconciliation_confirmation:drainConsent('reconcile',run.run_id,run.plan_hash)};
      log('corporate_drain_status',result);
      for (const b of batches) log('corporate_drain_batch_status',{run_id:run.run_id,batch:b.batch_no,state:b.state,
        selected:b.evidence.length,confirmed:b.confirmed_count,already_existing:b.existing_count,duration_ms:b.duration_ms,
        metrics_available:b.duration_ms !== null,receipts:Array.isArray(b.outcome)?b.outcome.filter(o => o.remote_raw_id !== null).length:0});
      await local.query('COMMIT'); return result;
    } finally { local.release(true); }
  } finally { await pool.end(); }
}

export async function drainCommand(cfg: Config, request: DrainRequest, signal: AbortSignal = new AbortController().signal, hooks: DrainHooks = {}) {
  validateDrainRequest(request);
  if (!cfg.corporateDelivery || cfg.corporateDelivery.connection.writeEnabled) throw new SyncError('DRAIN_REQUIRES_GENERAL_WRITE_DISABLED');
  if (request.kind === 'status') return status(cfg,request.runId);
  const store=new Store(cfg);
  try {
    await store.open(); // Own source and Corporate Sync sessions for the entire bounded invocation.
    const local=store.client!;
    await migration(local); await sessionLocks(local,cfg.sourceKey);
    const timeout='limits' in request ? request.limits.statementTimeoutMs : Math.min(cfg.corporateDelivery.connection.timeoutMs,15000);
    await local.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)",[String(timeout)]);
    if (request.kind === 'plan') return await plan(store,cfg,request.limits);
    if (request.kind === 'execute') return await execute(store,cfg,request,signal,hooks);
    if (request.kind === 'cancel') return await cancelPlan(store,cfg,request);
    return await reconcile(store,cfg,request,signal,hooks);
  } finally {
    if (store.client) await rollback(store.client);
    await store.close();
  }
}
