import { WorkerError } from './errors.js';
import type { GapAuthorization } from './history-gaps.js';
export type GapRequest={kind:'prepare';input:string;output:string}|{kind:'status';id:string}|
 {kind:'capture';authorization:GapAuthorization}|{kind:'persist';authorization:GapAuthorization;references:string};
export function parseGapRequest(command:string,args:string[]):GapRequest|undefined{
 if(!['capture-reread','recover-local'].includes(command)||!args[0]?.startsWith('--'))return undefined;
 const values=new Map<string,string>();
 if(args.length%2)throw new WorkerError('GAP_PARAMETERS_INVALID');
 for(let i=0;i<args.length;i+=2){if(values.has(args[i]!))throw new WorkerError('GAP_PARAMETERS_INVALID');values.set(args[i]!,args[i+1]!);}
 const get=(key:string)=>{const v=values.get(key);values.delete(key);if(!v)throw new WorkerError('GAP_PARAMETERS_INVALID');return v;};
 let r:GapRequest;
 if(command==='capture-reread'&&values.has('--prepare'))r={kind:'prepare',input:get('--prepare'),output:get('--output')};
 else if(command==='capture-reread'&&values.has('--status'))r={kind:'status',id:get('--status')};
 else{
  const authorization={planId:get('--plan-id'),hash:get('--plan-hash'),block:Number(get('--block')),confirmation:get('--confirm')};
  r=command==='capture-reread'?{kind:'capture',authorization}:{kind:'persist',authorization,references:get('--references')};
 }
 if(values.size)throw new WorkerError('GAP_PARAMETERS_INVALID');return r;
}
