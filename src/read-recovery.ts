import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { rows, readFields } from './api.js';
import type { Config } from './config.js';
import { WorkerError } from './errors.js';

export interface RecoveryRange { start: string; end: string; expectedIds: string[] }
export interface RecoveryManifest {
  version: 1; sourceKey: string; targetTable: string; parentId: string; parentStartedAt: string; date: string;
  evidenceRef: string; evidenceSha256: string;
  remoteOperationComplete: true; rereadCursorSafe: true; exactIdsConfirmed: true;
  operation: { start: string; end: string; quantity: string; dateRead: string };
  ranges: RecoveryRange[];
}
export interface RecoveryAuthorization { manifest: RecoveryManifest; hash: string; binding: string }
export const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
export const recoveryBinding = (cfg: Config) => fingerprint(JSON.stringify([
  cfg.baseUrl,cfg.username,cfg.clientId,cfg.tlsVerify,cfg.sourceTimeZone??null,cfg.ingestionBaseline??null,
  cfg.maxResponseBytes,cfg.recoveryMaxResponseBytes,cfg.sourceIdConfirmed,
]));
export function recoveryHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new WorkerError('RECOVERY_AUTHORIZATION_REQUIRED');
  return value;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new WorkerError('RECOVERY_MANIFEST_INVALID');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value)>9223372036854775807n) throw new WorkerError('RECOVERY_MANIFEST_INVALID');
  return value;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new WorkerError('RECOVERY_MANIFEST_INVALID');
  return value;
}
// Reconstruct a fixed field order: PostgreSQL jsonb does not preserve object key order.
export function recoveryManifest(value: unknown): RecoveryManifest {
  const m=object(value,['version','sourceKey','targetTable','parentId','parentStartedAt','date','evidenceRef','evidenceSha256',
    'remoteOperationComplete','rereadCursorSafe','exactIdsConfirmed','operation','ranges']);
  if(m.version!==1||m.remoteOperationComplete!==true||m.rereadCursorSafe!==true||m.exactIdsConfirmed!==true||
    !Array.isArray(m.ranges)||!m.ranges.length||m.ranges.length>2000)throw new WorkerError('RECOVERY_MANIFEST_INVALID');
  const operation=object(m.operation,['start','end','quantity','dateRead']);
  const ranges:RecoveryRange[]=[],seen=new Set<string>();
  let previous=-1n;
  for(const entry of m.ranges){
    const r=object(entry,['start','end','expectedIds']),start=id(r.start),end=id(r.end);
    readFields({kind:'reread',date:String(m.date),start,end});
    if(BigInt(start)<=previous||BigInt(end)-BigInt(start)+1n>10000n||!Array.isArray(r.expectedIds)||!r.expectedIds.length)throw new WorkerError('RECOVERY_MANIFEST_INVALID');
    const expectedIds=r.expectedIds.map(value=>id(value));
    let last=-1n;
    for(const expected of expectedIds){
      const n=BigInt(expected);
      if(n<BigInt(start)||n>BigInt(end)||n<=last||seen.has(expected))throw new WorkerError('RECOVERY_MANIFEST_INVALID');
      last=n;seen.add(expected);
      if(seen.size>200000)throw new WorkerError('RECOVERY_MANIFEST_TOO_LARGE');
    }
    previous=BigInt(end);ranges.push({start,end,expectedIds});
  }
  const first=ranges[0]!,last=ranges.at(-1)!,start=id(operation.start),end=id(operation.end),quantity=id(operation.quantity);
  if(start!==first.start||end!==last.end||BigInt(quantity)!==BigInt(seen.size)||
    first.expectedIds[0]!==start||last.expectedIds.at(-1)!==end)throw new WorkerError('RECOVERY_EVIDENCE_COVERAGE_MISMATCH');
  const parentStartedAt=text(m.parentStartedAt,/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  if(!Number.isFinite(Date.parse(parentStartedAt)))throw new WorkerError('RECOVERY_MANIFEST_INVALID');
  return {version:1,sourceKey:text(m.sourceKey,/^[^\u0000-\u001f]{1,200}$/),targetTable:text(m.targetTable,/^"[a-z_][a-z0-9_]*"\."[a-z_][a-z0-9_]*"$/),
    parentId:text(m.parentId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),parentStartedAt,date:String(m.date),
    evidenceRef:text(m.evidenceRef,/^[A-Za-z0-9._:-]{1,100}$/),evidenceSha256:recoveryHash(m.evidenceSha256),
    remoteOperationComplete:true,rereadCursorSafe:true,exactIdsConfirmed:true,
    operation:{start,end,quantity,dateRead:text(operation.dateRead,/^\d{4}-\d{2}-\d{2}T[0-9:.+-]{8,32}(?:Z)?$/)},ranges};
}
async function privateText(path: string, max: number): Promise<string> {
  const file=await open(path,'r');
  try{
    const stat=await file.stat();
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>max)throw new WorkerError('RECOVERY_PRIVATE_FILE_REQUIRED');
    // Bound the read even if the file grows after stat().
    const buffer=Buffer.alloc(stat.size+1),read=await file.read(buffer,0,buffer.length,0);
    if(read.bytesRead!==stat.size)throw new WorkerError('RECOVERY_EVIDENCE_CHANGED');
    return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,stat.size));
  }finally{await file.close();}
}
export async function loadRecoveryManifest(path: string, evidencePath: string, expectedHash: string, confirmation: string|undefined): Promise<RecoveryManifest> {
  if(confirmation!=='AUTHORIZE_EXPORTDATA_REREAD_RECOVERY')throw new WorkerError('RECOVERY_NOT_AUTHORIZED');
  const raw=await privateText(path,8*1024*1024);
  if(fingerprint(raw)!==recoveryHash(expectedHash))throw new WorkerError('RECOVERY_EVIDENCE_CHANGED');
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{throw new WorkerError('RECOVERY_MANIFEST_INVALID');}
  const manifest=recoveryManifest(parsed),evidence=await privateText(evidencePath,8*1024*1024);
  if(fingerprint(evidence)!==manifest.evidenceSha256)throw new WorkerError('RECOVERY_EVIDENCE_CHANGED');
  const op=manifest.operation;
  const matches=rows(evidence).filter(row=>row.TableName==='AttemptsRawData'&&row.PKColumnName==='AttemptsRawDataID'&&
    row.DateExport===`${manifest.date}T00:00:00`&&row.DateRead===op.dateRead&&
    row.PKIDStart===op.start&&row.PKIDEnd===op.end&&row.Quantity===op.quantity);
  if(matches.length!==1)throw new WorkerError('RECOVERY_OFFICIAL_LOG_MISMATCH');
  return manifest;
}
export function authorization(value: unknown, cfg: Config): RecoveryAuthorization {
  const a=object(value,['manifest','hash','binding']),manifest=recoveryManifest(a.manifest);
  const hash=fingerprint(JSON.stringify(manifest)),binding=recoveryBinding(cfg);
  if(a.hash!==hash||a.binding!==binding||manifest.sourceKey!==cfg.sourceKey||manifest.targetTable!==`"${cfg.schema}"."${cfg.table}"`)throw new WorkerError('RECOVERY_AUTHORIZATION_CHANGED');
  return {manifest,hash,binding};
}
