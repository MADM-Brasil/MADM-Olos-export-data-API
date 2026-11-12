import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import { log } from '../errors.js';
import type { DeliveryConfig } from './config.js';
import type { ReadoptionRequest,ReadoptionActivation,ReadoptionResult } from './readoption-contract.js';
import { prepareCorporateReadoption } from './readoption.js';
import { validateReadoption,activateReadoption,abortReadoption,readoptionStatus } from './readoption-activation.js';
import { assertReadoptionSchema } from './readoption-proof.js';
const actions=new Map([
 ['corporate-prepare-id-readoption','prepare'],['corporate-validate-id-readoption','validate'],
 ['corporate-activate-id-readoption','activate'],['corporate-reconcile-id-readoption','reconcile'],
 ['corporate-abort-id-readoption','abort'],['corporate-id-readoption-status','status'],['corporate-id-readoption-evidence','evidence']
] as const);
export const readoptionCommands=[...actions.keys()];
export function readoptionAction(command:string){return (actions as ReadonlyMap<string,Action>).get(command);}
type Action='prepare'|'validate'|'activate'|'reconcile'|'abort'|'status'|'evidence';
export type ReadoptionCommand=
 |{action:'status'|'evidence';source:string;requestId:string}
 |{action:'prepare'|'validate'|'abort';request:ReadoptionRequest}
 |{action:'activate'|'reconcile';request:ReadoptionActivation};
export function readoptionArguments(action:Action,args:string[],env:NodeJS.ProcessEnv,source:string):ReadoptionCommand {
 const query=action==='status'||action==='evidence',activation=action==='activate'||action==='reconcile';
 if(!query&&env.OLOS_CORPORATE_READOPTION_CONFIRMATION!=='AUTHORIZE_CORPORATE_ID_READOPTION')throw new SyncError('READOPTION_NOT_AUTHORIZED');
 if(activation&&env.OLOS_CORPORATE_READOPTION_ACTIVATION_CONFIRMATION!=='AUTHORIZE_CORPORATE_ID_READOPTION_ACTIVATION')throw new SyncError('READOPTION_ACTIVATION_NOT_AUTHORIZED');
 if(args[0]!=='--confirm-source'||args[1]!==source)throw new SyncError('READOPTION_SOURCE_MISMATCH');
 if(args[2]!=='--request-id'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(args[3]??''))throw new SyncError('READOPTION_ARGUMENTS_INVALID');
 if(query){if(args.length!==4)throw new SyncError('READOPTION_ARGUMENTS_INVALID');return {action,source,requestId:args[3]!};}
 if(args[4]!=='--evidence'||!/^[A-Za-z0-9._:-]{1,100}$/.test(args[5]??''))throw new SyncError('READOPTION_ARGUMENTS_INVALID');
 const request={source,requestId:args[3]!,evidence:args[5]!};
 if(activation){
  if(![8,10].includes(args.length)||args[6]!=='--validation'||!/^[0-9a-f]{64}$/.test(args[7]??''))throw new SyncError('READOPTION_ARGUMENTS_INVALID');
  if(args.length===10&&(args[8]!=='--max-batches'||!/^[1-9][0-9]{0,4}$/.test(args[9]??'')||Number(args[9])>10000))throw new SyncError('READOPTION_ARGUMENTS_INVALID');
  return {action,request:{...request,validation:args[7]!,maxBatches:args.length===10?Number(args[9]):10}};
 }
 if(args.length!==6)throw new SyncError('READOPTION_ARGUMENTS_INVALID');
 return {action,request};
}
export async function executeReadoptionCommand(db:PoolClient,cfg:DeliveryConfig,target:string,command:ReadoptionCommand) {
 if(command.action==='status'||command.action==='evidence'){
  const status=await readoptionStatus(db,cfg,target,command.source,command.requestId,command.action==='evidence');
  log('corporate_readoption_status',{request_id:status.requestId,state:status.state,completed:status.completed,
   previous_adoption_id:status.previous_adoption_id,previous_reversion_id:status.previous_reversion_id,validation_digest:status.validation_digest,
   predecessor_digest:status.predecessor_digest,remote_contract_hash:status.remote_contract_hash,registration_digest:status.registration_digest,
   registered:status.registered,batches:status.batches,registration_cursor:status.registration_cursor,registration_end:status.registration_end,
   barrier_at:status.barrier_at?.toISOString()??null,activated_at:status.activated_at?.toISOString()??null,error:status.last_error,
   authority_generation:status.authority.id_allocator_generation,authority_required:status.authority.id_allocator_required,paused:status.authority.paused});
  for(const batch of status.batch_evidence??[])log('corporate_readoption_batch_evidence',{request_id:status.requestId,batch:batch.batch_no,
    first_id:batch.first_id,last_id:batch.last_id,members:batch.member_count,chain_hash:batch.chain_hash,quarantine_digest:batch.quarantine_digest});
  return;
 }
 if(!('request' in command))throw new SyncError('READOPTION_ARGUMENTS_INVALID');
 const request=command.request;await assertReadoptionSchema(db);
 if(command.action==='prepare'){
  await prepareCorporateReadoption(db,request,cfg.binding,target,cfg);
  await executeReadoptionCommand(db,cfg,target,{action:'status',source:request.source,requestId:request.requestId});return;
 }
 let result:ReadoptionResult;
 if(command.action==='validate')result=await validateReadoption(db,cfg,target,request);
 else if(command.action==='abort')result=await abortReadoption(db,cfg,target,request);
 else if(command.action==='activate'||command.action==='reconcile')result=await activateReadoption(db,cfg,target,command.request,{},command.action==='reconcile');
 else throw new SyncError('READOPTION_ARGUMENTS_INVALID');
 log('corporate_readoption_result',{request_id:result.requestId,state:result.state,completed:result.completed,
  already_applied:result.alreadyApplied,registered:result.registered,batches:result.batches});
 if((command.action==='activate'||command.action==='reconcile')&&!result.completed)throw new SyncError(result.state==='ready'?'READOPTION_ACTIVATION_NOT_STARTED':'READOPTION_ACTIVATION_INCOMPLETE');
}
