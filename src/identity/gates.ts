import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import { drainHash } from '../corporate-delivery/drain-request.js';
export async function identityAdopted(db:PoolClient):Promise<boolean>{
 if(!(await db.query("SELECT to_regclass('olos_http.identity_contract') IS NOT NULL AS ok")).rows[0].ok)return false;
 return (await db.query('SELECT adopted FROM olos_http.identity_contract WHERE singleton')).rows[0]?.adopted===true;
}
export async function identityDeliveryGate(db:PoolClient,entries:{source_id:string;target_id:string}[]){
 if(!await identityAdopted(db))return;
 if((await db.query("SELECT 1 FROM olos_http.identity_runs WHERE state='intent'")).rowCount)throw new SyncError('IDENTITY_RECONCILIATION_REQUIRED');
 if(entries.some(e=>e.source_id!==String(e.target_id)))throw new SyncError('IDENTITY_ORIGINAL_ID_REQUIRED');
}
// This evidence authorizes only the existing fixed history scope, checked by the caller.
export async function certifiedOriginal(db:PoolClient,source:string,entry:{source_id:string;target_id:string;payload:unknown}):Promise<boolean>{
 if(entry.source_id!==String(entry.target_id)||!await identityAdopted(db))return false;
 const plans=(await db.query(`SELECT p.manifest,p.hash,r.source_hash,r.target_table,o.payload_hash,c.binding
 FROM olos_http.identity_plans p JOIN olos_http.identity_runs state USING(id)
 JOIN olos_http.records r ON r.source_key=$1 AND r.source_id=$2
 JOIN olos_http.corporate_outbox o USING(source_key,source_id)
 JOIN olos_http.corporate_control c ON c.singleton
 JOIN olos_http.reads h ON h.id=(p.manifest->'history'->>'id')::uuid
 WHERE state.state='completed' AND p.manifest->>'source'=$1 AND p.manifest->'ids' ? $2
 AND p.manifest->'history'=to_jsonb(h) AND p.manifest->>'binding'=c.binding
 AND p.manifest->>'target'=r.target_table AND r.target_id::text=r.source_id AND o.target_id=r.target_id
 AND r.source_hash=o.source_hash`,[source,entry.source_id])).rows;
 return plans.some(p=>drainHash(p.manifest)===p.hash && p.manifest.entries.some((e:any)=>e.source_id===entry.source_id && e.source_hash===p.source_hash && e.new_hash===p.payload_hash && drainHash(e.new_payload)===drainHash(entry.payload)));
}
