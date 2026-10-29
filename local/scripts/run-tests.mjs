import {spawnSync} from 'node:child_process';
const url=new URL(process.env.LOCAL_DATABASE_URL);
if(url.hostname!=='postgres'||url.pathname!=='/olos_http_local'||url.username!=='olos_local')throw Error('Isolated compose required');
url.pathname='/olos_http_local_test';
const env={...process.env,LOCAL_DATABASE_URL:url.href};
for(const args of [['run','migrate'],['test']]){
  const r=spawnSync('npm',args,{cwd:'/app/local',env,stdio:'inherit'});
  if(r.status!==0)process.exit(r.status??1);
}
