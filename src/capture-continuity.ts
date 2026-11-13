import type {PoolClient} from 'pg';
import {WorkerError} from './errors.js';
import {fingerprint} from './read-recovery.js';

export const historicalRead='2523225a-a46d-407a-ad5a-d1ff771e576e';
export const continuitySource='olos-production';
const assessment='UNKNOWN';
export interface ContinuityConsent {
  version:2;
  authorizationId:string; parentHash:string; actor:string; evidenceRef:string; evidenceSha256:string;
  expiresAt:string; acceptedHistoricalGap:true; remoteOperationSettled:false; cursorAssessment:typeof assessment;
  acceptedUnknownCursorRisk:true; acceptedUnreconciledOperationRisk:true;
}
export function continuityConsent(value:unknown):ContinuityConsent {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkerError('CONTINUITY_CONSENT_INVALID');
  const v=value as Record<string,unknown>;
  // Risk acceptance is not proof of cursor safety or reconciliation of the original request.
  // Legacy attestations must never be silently reinterpreted as this consent.
  if(Object.keys(v).sort().join(',')!=='acceptedHistoricalGap,acceptedUnknownCursorRisk,acceptedUnreconciledOperationRisk,actor,authorizationId,cursorAssessment,evidenceRef,evidenceSha256,expiresAt,parentHash,remoteOperationSettled,version'
    ||v.version!==2||v.acceptedUnknownCursorRisk!==true||v.acceptedUnreconciledOperationRisk!==true
    ||!['authorizationId','parentHash','actor','evidenceRef','evidenceSha256'].every(k=>typeof v[k]==='string')
    ||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(String(v.authorizationId))||!/^\w[\w.@:/-]{0,199}$/.test(String(v.actor))
    ||!/^\w[\w.@:/-]{0,199}$/.test(String(v.evidenceRef))||! /^[a-f0-9]{64}$/.test(String(v.evidenceSha256))
    ||! /^[a-f0-9]{64}$/.test(String(v.parentHash))||typeof v.expiresAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.expiresAt)
    ||!Number.isFinite(Date.parse(v.expiresAt))||new Date(v.expiresAt).toISOString()!==v.expiresAt||v.acceptedHistoricalGap!==true||v.remoteOperationSettled!==false||v.cursorAssessment!==assessment)
    throw new WorkerError('CONTINUITY_CONSENT_INVALID');
  return v as unknown as ContinuityConsent;
}
export interface PendingCapture {id:string;state:string}
export async function continuityParent(db:PoolClient,source:string,target:string):Promise<string> {
  if(source!==continuitySource)throw new WorkerError('CONTINUITY_SOURCE_MISMATCH');
  const result=await db.query<{snapshot:string}>(`SELECT to_jsonb(r)::text AS snapshot FROM olos_http.reads r
    WHERE id=$1 AND source_key=$2 AND target_table=$3 AND state='reading' AND error_code='RESPONSE_TOO_LARGE'
    AND response_body IS NULL AND response_spool_read_id IS NULL AND processed_count=0
    AND spec->>'kind'='current' AND NOT(spec ? 'capture')
    AND spec->'recovery_authorization'->'manifest'->>'version'='2'
    AND NOT EXISTS(SELECT 1 FROM olos_http.capture_spool s WHERE s.read_id=r.id)`,[historicalRead,source,target]);
  if(result.rowCount!==1)throw new WorkerError('CONTINUITY_PARENT_CHANGED');
  return fingerprint(result.rows[0]!.snapshot);
}
export async function captureContinuity<T extends PendingCapture>(db:()=>PoolClient,pending:T[],source:string,target:string,binding:string,streaming:boolean):Promise<{pending:T[];authorizationId?:string}> {
  if(!streaming||source!==continuitySource||pending.length!==1||pending[0]!.id!==historicalRead)return {pending};
  const client=db();
  if(!(await client.query("SELECT to_regclass('olos_http.capture_continuity') IS NOT NULL AS present")).rows[0].present)return {pending};
  const row=(await client.query<{authorization_id:string;parent_hash:string;consent:unknown}>(`SELECT authorization_id,parent_hash,consent FROM olos_http.capture_continuity
    WHERE source_key=$1 AND parent_id=$2 AND target_table=$3 AND binding=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[source,historicalRead,target,binding])).rows[0];
  if(!row)return {pending};
  const consent=continuityConsent(row.consent);
  if(consent.authorizationId!==row.authorization_id||consent.parentHash!==row.parent_hash)throw new WorkerError('CONTINUITY_CONSENT_INVALID');
  if(await continuityParent(client,source,target)!==row.parent_hash)throw new WorkerError('CONTINUITY_PARENT_CHANGED');
  return {pending:[],authorizationId:row.authorization_id};
}
export async function authorizeContinuity(db:PoolClient,consent:ContinuityConsent,source:string,target:string,binding:string) {
  let committing=false;
  try {
    await db.query('BEGIN');
    const previous=(await db.query('SELECT consent,binding,revoked_at,expires_at>clock_timestamp() AS valid FROM olos_http.capture_continuity WHERE authorization_id=$1',[consent.authorizationId])).rows[0];
    if(previous){
      if(previous.revoked_at)throw new WorkerError('CONTINUITY_AUTHORIZATION_REVOKED');
      if(!previous.valid)throw new WorkerError('CONTINUITY_AUTHORIZATION_EXPIRED');
      if(!(await db.query('SELECT consent=$2::jsonb AND binding=$3 AS same FROM olos_http.capture_continuity WHERE authorization_id=$1',[consent.authorizationId,JSON.stringify(consent),binding])).rows[0].same)throw new WorkerError('CONTINUITY_REQUEST_REUSED');
      await db.query('ROLLBACK');return;
    }
    if((await db.query("SELECT id FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received')",[source])).rows.some(r=>r.id!==historicalRead))throw new WorkerError('RECOVERY_REQUIRED');
    if(await continuityParent(db,source,target)!==consent.parentHash)throw new WorkerError('CONTINUITY_PARENT_CHANGED');
    await db.query(`INSERT INTO olos_http.capture_continuity(authorization_id,source_key,parent_id,target_table,binding,parent_hash,consent,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8::timestamptz WHERE $8::timestamptz>clock_timestamp() RETURNING authorization_id`,
      [consent.authorizationId,source,historicalRead,target,binding,consent.parentHash,JSON.stringify(consent),consent.expiresAt]).then(r=>{if(r.rowCount!==1)throw new WorkerError('CONTINUITY_AUTHORIZATION_EXPIRED');});
    committing=true;await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});if(committing)throw new WorkerError('CONTINUITY_COMMIT_UNKNOWN');throw error;}
}
