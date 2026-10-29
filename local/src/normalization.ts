import { createHash } from 'node:crypto';
import { rows } from '../../src/api.js';
import { mapRecord, timestamp, type Cache } from '../../src/mapping.js';
import { WorkerError } from '../../src/errors.js';

export const NORMALIZATION_VERSION=1;
export const emptyCache=():Cache=>({users:new Map(),campaigns:new Map(),dispositions:new Map()});
export const digest=(body:string)=>createHash('sha256').update(body).digest('hex');
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const payloadDigest=(value:unknown)=>digest(JSON.stringify(canonical(value)));
function micros(value:string):bigint {
  const fraction=/\.(\d+)/.exec(value)?.[1]??'';
  return BigInt(Date.parse(value.replace(/\.\d+/,'')))*1000n+BigInt(fraction.padEnd(6,'0'));
}
export function normalize(row:Record<string,unknown>,baseline:string,cache=emptyCache(),zone?:string) {
  const mapped=mapRecord(row,cache,zone);
  if(!mapped.data_ligacao)throw new WorkerError('BASELINE_REQUIRES_START_DATE');
  const {source_id,source_hash,agent_id,campaign_id,disposition_id,...document}=mapped;
  return {sourceId:source_id,payloadHash:payloadDigest(row),document:{internal_id_olos:null,...document},
    disposition:micros(mapped.data_ligacao)>=micros(baseline)?'eligible':'before_baseline'};
}
export function inspectContract(body:string,zone?:string) {
  const data=rows(body);
  if(!data.length)throw new WorkerError('CONTRACT_SAMPLE_EMPTY');
  const fields=new Map<string,Set<string>>();const ids=new Set<string>();let repeatedIds=0;
  for(const row of data) {
    const normalized=normalize(row,'1970-01-01T00:00:00Z',emptyCache(),zone);
    if(ids.has(normalized.sourceId))repeatedIds++;ids.add(normalized.sourceId);
    for(const [key,value] of Object.entries(row)) {
      // Report only fields used by the existing mapper, never payload values or unexpected keys.
      if(!['AttemptsRawDataID','CallId','AgentId','CampaignId','DispositionId','StartDate','OriginalPhoneNumber'].includes(key))continue;
      const types=fields.get(key)??new Set<string>();types.add(value===null?'null':typeof value);fields.set(key,types);
    }
  }
  return {records:data.length,repeatedIds,fields:Object.fromEntries([...fields].map(([k,v])=>[k,[...v]])),digest:digest(body),
    numericTokensPreservedAsStrings:true,globalUniquenessProven:false};
}
export function baselineTime(value:string):string {
  const result=timestamp(value);
  if(!result)throw new WorkerError('BASELINE_REQUIRED');
  return result;
}
