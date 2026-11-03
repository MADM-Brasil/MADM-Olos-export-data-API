import { createHash } from 'node:crypto';
import { SyncError } from '../corporate-sync/errors.js';
import { preservedHistoryRead } from './preserved-history.js';

export interface DrainLimits {
  batchSize: number;
  maxBatches: number;
  delayMs: number;
  maxBatchMs: number;
  statementTimeoutMs: number;
  contract: 'v1';
  historyReadId: string;
}
export type DrainRequest =
  | { kind: 'plan'; limits: DrainLimits }
  | { kind: 'execute'; limits: DrainLimits; runId: string; planHash: string; confirmation: string }
  | { kind: 'reconcile'; runId: string; planHash: string; confirmation: string }
  | { kind: 'cancel'; runId: string; planHash: string; confirmation: string }
  | { kind: 'status'; runId: string };

export function drainHash(value: unknown): string {
  function canonical(v: any): any {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function drainConsent(kind: 'execute' | 'reconcile' | 'cancel', runId: string, planHash: string): string {
  return `AUTHORIZE_EXPORTDATA_DRAIN_${kind === 'execute' ? 'V1' : kind === 'cancel' ? 'CANCEL_PLAN' : 'RECONCILIATION'}:${runId}:${planHash}`;
}
export function validateDrainLimits(p: DrainLimits): void {
  for (const [value, min, max] of [[p.batchSize,1,1000], [p.maxBatches,1,100], [p.delayMs,1000,60000],
    [p.maxBatchMs,100,60000], [p.statementTimeoutMs,100,15000]]) {
    if (!Number.isSafeInteger(value) || value! < min! || value! > max!) throw new SyncError('DRAIN_LIMITS_INVALID');
  }
  if (p.batchSize * p.maxBatches > 10000 || p.statementTimeoutMs > p.maxBatchMs ||
    p.contract !== 'v1' || p.historyReadId !== preservedHistoryRead) throw new SyncError('DRAIN_SCOPE_INVALID');
}
export function validateDrainRequest(request: DrainRequest): void {
  if (!['plan','execute','reconcile','cancel','status'].includes(request.kind)) throw new SyncError('DRAIN_PARAMETERS_INVALID');
  if ('limits' in request) validateDrainLimits(request.limits);
  if ('runId' in request && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.runId)) {
    throw new SyncError('DRAIN_RUN_ID_INVALID');
  }
  if (request.kind === 'execute' || request.kind === 'reconcile' || request.kind === 'cancel') {
    if (!/^[0-9a-f]{64}$/.test(request.planHash) || request.confirmation !== drainConsent(request.kind,request.runId,request.planHash)) {
      throw new SyncError('DRAIN_NOT_AUTHORIZED');
    }
  }
}
export function parseDrainRequest(command: string, args: string[]): DrainRequest {
  const commands: Record<string,DrainRequest['kind']> = { 'corporate-drain-plan':'plan', 'corporate-drain-backlog':'execute',
    'corporate-drain-reconcile':'reconcile', 'corporate-drain-status':'status', 'corporate-drain-cancel':'cancel' };
  const kind = commands[command];
  if (!kind || args.length % 2 !== 0) throw new SyncError('DRAIN_PARAMETERS_INVALID');
  const values = new Map<string,string>();
  for (let i=0; i<args.length; i+=2) {
    if (values.has(args[i]!)) throw new SyncError('DRAIN_PARAMETERS_INVALID');
    values.set(args[i]!,args[i+1]!);
  }
  const get = (key: string) => {
    const value = values.get(key);
    if (value === undefined) throw new SyncError('DRAIN_PARAMETERS_INVALID');
    values.delete(key); return value;
  };
  const number = (key: string) => {
    const value=get(key);
    if (!/^[1-9][0-9]*$/.test(value)) throw new SyncError('DRAIN_LIMITS_INVALID');
    return Number(value);
  };
  let request: DrainRequest;
  if (kind === 'status') request={kind,runId:get('--run-id')};
  else if (kind === 'reconcile' || kind === 'cancel') request={kind,runId:get('--run-id'),planHash:get('--plan-hash'),confirmation:get('--confirm')};
  else {
    const limits = {batchSize:number('--batch-size'),maxBatches:number('--max-batches'),delayMs:number('--delay-ms'),
      maxBatchMs:number('--max-batch-ms'),statementTimeoutMs:number('--statement-timeout-ms'),
      contract:get('--contract') as 'v1',historyReadId:get('--preserve-history-read')};
    request=kind === 'plan' ? {kind,limits} : {kind,limits,runId:get('--run-id'),planHash:get('--plan-hash'),confirmation:get('--confirm')};
  }
  if (values.size) throw new SyncError('DRAIN_PARAMETERS_INVALID');
  validateDrainRequest(request); return request;
}
