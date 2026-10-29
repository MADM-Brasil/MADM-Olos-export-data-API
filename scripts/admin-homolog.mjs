// Local simulator profile only. Does not load the root .env or manage operational containers.
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),stateDir=resolve(root,'admin/.homolog'),envPath=resolve(root,'admin/.env.homolog');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function environment(create=false){
  if(create){
    const password=randomBytes(24).toString('hex');
    const content=`DATABASE_URL=postgresql://homolog:${password}@127.0.0.1:15434/olos_admin_homolog\nPOSTGRES_PASSWORD=${password}\nADMIN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nOLOS_SOURCE_KEY=olos-admin-homolog\nADMIN_ORIGIN=http://localhost:8081\nADMIN_PORT=8081\nADMIN_BIND=127.0.0.1\nADMIN_OLOS_USERS_JSON=["homolog-admin"]\nADMIN_OLOS_ALLOWED_ORIGINS=http://127.0.0.1:18081\nOLOS_BASE_URL=http://127.0.0.1:18081/WebApiExportData\nOLOS_USERNAME=homolog-admin\nOLOS_PASSWORD=homolog-password\nOLOS_CLIENT_ID=homolog-client\nOLOS_CLIENT_SECRET=homolog-client-secret\nOLOS_TLS_VERIFY=true\nSOURCE_ID_UNIQUENESS_CONFIRMED=false\nPOLL_INTERVAL_MS=120000\n`;
    await fs.writeFile(envPath,content,{mode:0o600,flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  }
  const e=parseEnv(await fs.readFile(envPath,'utf8')),url=new URL(e.DATABASE_URL);
  if(url.hostname!=='127.0.0.1'||url.port!=='15434'||url.pathname!=='/olos_admin_homolog'||e.OLOS_SOURCE_KEY!=='olos-admin-homolog'||
    e.ADMIN_ORIGIN!=='http://localhost:8081'||e.ADMIN_PORT!=='8081'||e.ADMIN_BIND!=='127.0.0.1'||e.OLOS_BASE_URL!=='http://127.0.0.1:18081/WebApiExportData'||
    e.ADMIN_OLOS_ALLOWED_ORIGINS!=='http://127.0.0.1:18081'||e.SOURCE_ID_UNIQUENESS_CONFIRMED!=='false')throw new Error('HOMOLOGATION_PROFILE_MISMATCH');
  return {PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',...e};
}
const occupied=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});
async function identity(pid){
  try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');const rest=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(rest[0]==='Z')return null;
    return {started:rest[19],cwd:await fs.realpath(`/proc/${pid}/cwd`),args:(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0')};}catch{return null;}
}
async function stop(kind){
  const file=resolve(stateDir,`${kind}.json`);let saved;try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
  const current=await identity(saved.pid);
  if(current){
    const expected=kind==='panel'?'dist/main.js':'scripts/mock-olos-auth.mjs';
    if(current.started!==saved.started||current.cwd!==root||!current.args.includes(expected)||(kind==='panel'&&!current.args.includes('admin')))throw new Error('LOCAL_PROCESS_IDENTITY_MISMATCH');
    process.kill(saved.pid,'SIGTERM');
    for(let i=0;i<100&&await identity(saved.pid);i++)await pause(100);
    if(await identity(saved.pid))throw new Error('LOCAL_PROCESS_STILL_STOPPING');
  }
  await fs.unlink(file);
}
async function start(kind,e){
  const port=kind==='panel'?8081:18081;
  if(await occupied(port))throw new Error(kind==='panel'?'PANEL_PORT_IN_USE':'MOCK_PORT_IN_USE');
  const log=await fs.open(resolve(stateDir,`${kind}.log`),'a',0o600);
  const child=spawn(process.execPath,kind==='panel'?['dist/main.js','admin']:['scripts/mock-olos-auth.mjs'],{cwd:root,env:e,detached:true,stdio:['ignore',log.fd,log.fd]});
  child.unref();await log.close();
  const current=await identity(child.pid);if(!current)throw new Error('LOCAL_PROCESS_NOT_STARTED');
  await fs.writeFile(resolve(stateDir,`${kind}.json`),JSON.stringify({pid:child.pid,started:current.started}),{mode:0o600});
  for(let i=0;i<100;i++){if(await occupied(port))return;await pause(100);if(!await identity(child.pid))break;}
  throw new Error('LOCAL_PROCESS_NOT_READY_CHECK_PRIVATE_LOG');
}
async function main(){
  if(Number(process.versions.node.split('.')[0])!==24)throw new Error('NODE_24_REQUIRED');
  const command=process.argv[2];if(!['setup','start','restart','stop','status'].includes(command))throw new Error('USE_setup_start_restart_stop_status');
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});const e=await environment(command==='setup');
  if(command==='setup'){
    const child=spawn('docker',['compose','--env-file',envPath,'-f','admin/compose.homolog.yaml','up','-d','--wait','postgres'],{cwd:root,env:e,stdio:'inherit'});
    const code=await new Promise(r=>child.once('exit',r));if(code!==0)throw new Error('LOCAL_POSTGRES_SETUP_FAILED');
    const pool=new pg.Pool({connectionString:e.DATABASE_URL,max:1});
    try{
      if(!(await pool.query("SELECT to_regclass('olos_http.reads') AS table_name")).rows[0].table_name)await pool.query(await fs.readFile(resolve(root,'migrations/001_ingestion.sql'),'utf8'));
      await pool.query(await fs.readFile(resolve(root,'admin/migrations/002_worker_administration.sql'),'utf8'));
    }finally{await pool.end();}
    console.log('Local simulated database prepared; raw.olos_calls was not created or modified.');return;
  }
  if(command==='status'){console.log(JSON.stringify({panel:await occupied(8081),simulator:await occupied(18081),database:'olos_admin_homolog',source:'olos-admin-homolog',origin:'http://localhost:8081'}));return;}
  if(command==='stop'){await stop('panel');console.log('Only the managed local panel was stopped.');return;}
  if(command==='restart')await stop('panel');
  if(!await occupied(18081))await start('mock',e);
  // Verify this is the synthetic fixture, not an arbitrary remote service.
  const probe=await fetch('http://127.0.0.1:18081/mock-stats',{signal:AbortSignal.timeout(1000)});const stats=await probe.json();
  if(!Number.isInteger(stats.auth_requests)||!Number.isInteger(stats.non_auth_requests))throw new Error('MOCK_IDENTITY_MISMATCH');
  await start('panel',e);console.log('Simulated homologation panel: http://localhost:8081. No transactional consumer enabled.');
}
main().catch(error=>{console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'LOCAL_HOMOLOGATION_COMMAND_FAILED');process.exitCode=1;});
