import { readFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { localConfig } from './config.js';
import { LocalStore,type BaselinePlan } from './store.js';
import { inspectContract } from './normalization.js';
import { errorCode,WorkerError,log } from '../../src/errors.js';

async function main(){
  const [command='status',file]=process.argv.slice(2);
  if(!['baseline','import','resume','reprocess','status','inspect-contract'].includes(command))throw new WorkerError('LOCAL_COMMAND_NOT_ALLOWED');
  const cfg=localConfig();
  if(command==='inspect-contract'){
    if(!file)throw new WorkerError('SAMPLE_FILE_REQUIRED');
    process.stdout.write(JSON.stringify(inspectContract(await readFile(file,'utf8'),cfg.sourceTimeZone))+'\n');return;
  }
  const store=new LocalStore(cfg);
  try{
    await store.open();
    if(command==='baseline'){
      if(!file)throw new WorkerError('BASELINE_PLAN_REQUIRED');
      const plan=JSON.parse(await readFile(file,'utf8')) as BaselinePlan&{sampleFile:string};
      if(typeof plan.sampleFile!=='string')throw new WorkerError('SAMPLE_FILE_REQUIRED');
      await store.baseline(plan,await readFile(resolve(dirname(file),plan.sampleFile),'utf8'));log('local_baseline_created');
    } else if(command==='import'){
      if(!file)throw new WorkerError('RESPONSE_FILE_REQUIRED');
      const body=await readFile(file,'utf8');if(Buffer.byteLength(body)>32*1024*1024)throw new WorkerError('RESPONSE_TOO_LARGE');
      const run=await store.stage(body);log('local_run_received',{run_id:run.id});
      log('local_run_completed',await store.process(run.id));
    } else if(command==='resume'){for(const result of await store.resume())log('local_run_resumed',result);}
    else if(command==='reprocess')log('local_reprocess_completed',await store.reprocess());
    else log('local_status',await store.status());
  }finally{await store.close();}
}
main().catch(error=>{log('local_operation_failed',{error:errorCode(error)});process.exitCode=1;});
