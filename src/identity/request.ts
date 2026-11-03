import { originalInternalId } from '../mapping.js';
import { SyncError } from '../corporate-sync/errors.js';
export type Kind='pending'|'confirmed';
export type Request={action:'plan';kind:Kind;ids:string[];review:string} |
 {action:'execute'|'reconcile'|'cancel';id:string;hash:string;confirmation:string} | {action:'status';id:string};
export function consent(action:string,id:string,hash:string,kind:Kind) {
 return `AUTHORIZE_IDENTITY_${action==='execute'?(kind==='confirmed'?'REMOTE_UPDATE':'LOCAL_UPDATE'):action.toUpperCase()}:${id}:${hash}`;
}
export function parseRequest(args:string[]):Request {
 const [action,...rest]=args;
 const values=new Map<string,string>();
 if(rest.length%2)throw new SyncError('IDENTITY_PARAMETERS_INVALID');
 for(let i=0;i<rest.length;i+=2){if(values.has(rest[i]!))throw new SyncError('IDENTITY_PARAMETERS_INVALID');values.set(rest[i]!,rest[i+1]!);}
 const get=(key:string)=>{const v=values.get(key);values.delete(key);if(!v)throw new SyncError('IDENTITY_PARAMETERS_INVALID');return v;};
 let r:Request;
 if(action==='plan')r={action,kind:get('--kind') as Kind,ids:get('--source-ids').split(','),review:get('--dependency-review')};
 else if(action==='status')r={action,id:get('--id')};
 else if(action==='execute'||action==='reconcile'||action==='cancel')r={action,id:get('--id'),hash:get('--hash'),confirmation:get('--confirm')};
 else throw new SyncError('IDENTITY_PARAMETERS_INVALID');
 if(values.size)throw new SyncError('IDENTITY_PARAMETERS_INVALID');validateRequest(r);return r;
}
export function validateRequest(r:Request){
 if(r.action==='plan'){
  if(!['pending','confirmed'].includes(r.kind)||!r.ids.length||r.ids.length>1000||new Set(r.ids).size!==r.ids.length||!/^[a-f0-9]{64}$/.test(r.review))throw new SyncError('IDENTITY_SCOPE_INVALID');
  r.ids.forEach(id=>originalInternalId(id,32));
 }else if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.id)||('hash'in r&&!/^[a-f0-9]{64}$/.test(r.hash)))throw new SyncError('IDENTITY_SCOPE_INVALID');
}
