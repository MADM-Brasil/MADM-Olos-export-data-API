import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { seal, unseal, CredentialService, validateBaseUrl, type Credentials, testConnection, configuredOlosOrigins } from '../src/admin/credentials.js';
import { AdminAuth, authorizedUsers } from '../src/admin/security.js';
import { adminServer } from '../src/admin/server.js';
import { type CredentialRow, type AdminRepository } from '../src/admin/repository.js';
import { WorkerError } from '../src/errors.js';
import { createScheduledConsumer } from '../src/admin/consumer.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';

const cfg=config({DATABASE_URL:'postgresql://unused@127.0.0.1:1/unused',OLOS_SOURCE_KEY:'fixture',OLOS_BASE_URL:'https://olos.example.com/WebApiExportData',
  OLOS_USERNAME:'fixture',OLOS_PASSWORD:'PRIVATE_PASSWORD',OLOS_CLIENT_ID:'fixture',OLOS_CLIENT_SECRET:'PRIVATE_SECRET',
  SOURCE_ID_UNIQUENESS_CONFIRMED:'true',SOURCE_TIME_ZONE:'UTC',INGESTION_BASELINE:'2026-10-01T00:00:00Z'});
const credentials:Credentials={baseUrl:cfg.baseUrl,username:cfg.username,password:cfg.password,clientId:cfg.clientId,clientSecret:cfg.clientSecret};
const key=randomBytes(32);
const editable={baseUrl:credentials.baseUrl,username:credentials.username,password:credentials.password};
function credentialRepo() {
  let stored:CredentialRow|undefined, last:Awaited<ReturnType<AdminRepository['lastEnvironmentTest']>>=null;
  const audit:Record<string,unknown>[]=[];
  const repo={source:'fixture',async credentials(){return stored;},async lastEnvironmentTest(){return last;},
    async saveCredentials(actor:string,revision:number,encrypted:string){if(revision!==(stored?.revision??0))throw new WorkerError('CREDENTIAL_REVISION_CONFLICT');stored={revision:revision+1,encrypted_payload:encrypted,last_test_at:null,last_test_ok:null,last_test_code:null,last_test_ms:null};audit.push({actor,action:'credentials_updated',revision:revision+1});},
    async tested(actor:string,revision:number,ok:boolean,code:string,ms:number){audit.push({actor,action:'credentials_tested',revision,ok,code,ms});last={at:'fixture',ok,code,duration_ms:ms};if(stored?.revision===revision){stored.last_test_at='fixture';stored.last_test_ok=ok;stored.last_test_code=code;stored.last_test_ms=ms;}},
  };
  return {repo,audit};
}
test('AES-GCM authenticates ciphertext/source/key and uses a fresh nonce',()=>{
  const a=seal(credentials,key,'fixture'),b=seal(credentials,key,'fixture');assert.notEqual(a,b);assert.deepEqual(unseal(a,key,'fixture'),credentials);
  assert(!a.includes('PRIVATE'));assert.throws(()=>unseal(a,key,'other'),/CREDENTIAL_DECRYPTION_FAILED/);
  assert.throws(()=>unseal(a,randomBytes(32),'fixture'),/CREDENTIAL_DECRYPTION_FAILED/);
  const parts=a.split('.');const bytes=Buffer.from(parts[3]!,'base64');bytes[0]=bytes[0]!^1;parts[3]=bytes.toString('base64');
  assert.throws(()=>unseal(parts.join('.'),key,'fixture'),/CREDENTIAL_DECRYPTION_FAILED/);
});
test('credentials fallback preserves env, blanks preserve secrets, view/audit never expose them',async()=>{
  const r=credentialRepo(),service=new CredentialService(r.repo,cfg,key,['https://olos.example.com'],async()=>{});
  assert.equal((await service.view()).origin,'environment');
  await service.save('admin:ana',{...editable,password:'',revision:0});
  assert.equal((await service.snapshot()).credentials.password,'PRIVATE_PASSWORD');assert.equal(cfg.password,'PRIVATE_PASSWORD');
  const view=await service.view();assert.equal(view.origin,'database');assert.equal(view.passwordConfigured,true);assert.equal(view.complete,true);
  assert.doesNotMatch(JSON.stringify(view)+JSON.stringify(r.audit),/PRIVATE_PASSWORD|PRIVATE_SECRET|encrypted_payload|access_token/);
  assert(!('clientId' in view));assert(!('clientSecret' in view));
  await service.save('admin:ana',{revision:1,username:'updated-fixture'});
  assert.deepEqual((await service.snapshot()).credentials,{...credentials,username:'updated-fixture'});
  await assert.rejects(service.save('admin:ana',{revision:2,clientId:'injected'}),/TECHNICAL_CREDENTIALS_SERVER_ONLY/);
  await assert.rejects(service.save('admin:ana',{...editable,revision:0}),/CREDENTIAL_REVISION_CONFLICT/);
  await service.test('admin:ana');assert.equal((await service.view()).lastTest?.ok,true);
});
test('test results belong to credential revision; late results cannot mark new credentials valid',async()=>{
  const r=credentialRepo();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const service=new CredentialService(r.repo,cfg,key,['https://olos.example.com'],()=>pending);
  await service.save('admin:ana',{...editable,revision:0});const testRun=service.test('admin:ana');await new Promise(r=>setImmediate(r));
  await assert.rejects(service.test('admin:ana'),/CONNECTION_TEST_ALREADY_ACTIVE/);
  await service.save('admin:ana',{...editable,password:'new-secret',revision:1});release();await testRun;
  assert.equal((await service.view()).lastTest,null);
});
test('unsafe URLs and credential-bearing URLs are rejected before any HTTP',()=>{
  for(const url of ['http://169.254.169.254/WebApiExportData','https://other.example.com/WebApiExportData','https://user:pass@olos.example.com/WebApiExportData','https://olos.example.com/other','https://olos.example.com/WebApiExportData?secret=x'])assert.throws(()=>validateBaseUrl(url,['https://olos.example.com']));
});
test('connection test only authenticates via backend',async()=>{
  const calls:string[]=[];
  const catalog=[{TableName:'AttemptsRawData',Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId']},{TableName:'Users',Columns:['AgentId','UserName']},{TableName:'Campaign',Columns:['CampaignId','Description']},{TableName:'Disposition',Columns:['DispositionId','Description']}];
  const server=createServer(async(req,res)=>{for await(const _ of req){}calls.push(req.url!);res.end(req.url!.endsWith('/api/auth')?JSON.stringify({access_token:'secret',refresh_token:'secret',token_type:'bearer',expires_in:3600}):JSON.stringify(catalog));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');
  try{await testConnection(cfg,{...credentials,baseUrl:`http://127.0.0.1:${addr.port}/WebApiExportData`});assert.deepEqual(calls,['/WebApiExportData/api/auth']);}
  finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('runtime credentials change between cycles, never interrupt active HTTP',async t=>{
  let revision=0,current={...credentials},release!:()=>void,reading!:()=>void;
  const started=new Promise<void>(r=>{reading=r;}),pending=new Promise<void>(r=>{release=r;});
  const authBodies:string[]=[];let reads=0;
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);
    if(req.url!.endsWith('/api/auth')){authBodies.push(Buffer.concat(chunks).toString());res.end(JSON.stringify({access_token:'fixture',token_type:'bearer',expires_in:3600}));}
    else{reads++;if(reads===1){reading();await pending;}res.end('[]');}
  });server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');current.baseUrl=`http://127.0.0.1:${addr.port}/WebApiExportData`;
  t.mock.method(Store.prototype,'open',async()=>{});t.mock.method(Store.prototype,'ping',async()=>{});t.mock.method(Store.prototype,'unresolved',async()=>[]);
  t.mock.method(Worker.prototype,'cycle',async function(this:Worker){await this.api.captureCurrentDayOnce();});
  const consumer=await createScheduledConsumer(cfg,async()=>({revision,credentials:{...current}}));
  try{const run=consumer.cycle();await started;revision++;current.password='NEW_PRIVATE_PASSWORD';assert.equal(reads,1);assert.equal(authBodies.length,1);release();await run;await consumer.cycle();assert.equal(reads,2);assert.match(authBodies[1]!,/NEW_PRIVATE_PASSWORD/);}
  finally{release();await consumer.close();await new Promise<void>(r=>server.close(()=>r()));}
});
test('consumer startup rejects pending captures before any HTTP or cycle',async t=>{
  t.mock.method(Store.prototype,'open',async()=>{});t.mock.method(Store.prototype,'unresolved',async()=>[{id:'fixture',state:'received'}]);
  let loaded=0;await assert.rejects(createScheduledConsumer(cfg,async()=>{loaded++;return{revision:0,credentials};}),/RECOVERY_REQUIRED/);assert.equal(loaded,0);
});

test('admin API enforces session, role, CSRF, origin, stop confirmation and secret redaction',async()=>{
  const users=authorizedUsers('["ana"]');
  const actions:unknown[]=[];const r=credentialRepo();const service=new CredentialService(r.repo,cfg,key,['https://olos.example.com'],async()=>{});
  const server=adminServer({origin:'https://panel.example.com',publicDir:resolve('admin/public'),auth:new AdminAuth(users,async(_username,password)=>{if(password!=='admin-fixture-password')throw new Error('denied');},async()=>{}),credentials:service,
    scheduler:{async request(actor,patch){actions.push({actor,patch});},status:()=>({state:'STOPPED',cycle_in_progress:false,next_run_at:null,error:null,enabled:false,interval_ms:120000,desired_state:'STOPPED',updated_at:null,updated_by:null})},
    events:()=>[{time:'2026-10-28T18:00:00.000Z',event:'batch_completed',received:5,inserted:4,duplicates:1}],
    repository:{async logs(){return[];},async auditLog(){return[];},async observation(){return {database:{reachable:true,schema_valid:false,error:'DESTINATION_ID_GENERATOR_REQUIRED'},ingestion:{status:'NOT_OBSERVED',latest:null,last_completed:null,pending:[],last_error:null}};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}`;
  let cookie='',csrf='';
  const request=(path:string,method='GET',value?:unknown,extra:Record<string,string>={})=>fetch(url+path,{method,headers:{Origin:'https://panel.example.com','Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf,...extra},...(value===undefined?{}:{body:JSON.stringify(value)})});
  try{
    assert.equal((await request('/api/status')).status,401);
    assert.equal((await request('/api/events')).status,401);
    assert.equal((await request('/api/credentials','PUT',{...editable,revision:0})).status,401);
    assert.equal((await request('/api/login','POST',{username:'visitor',password:'admin-fixture-password'})).status,403);
    const login=await request('/api/login','POST',{username:'ana',password:'admin-fixture-password'});assert.equal(login.status,200);
    assert.match(login.headers.get('set-cookie')!,/HttpOnly/);assert.match(login.headers.get('set-cookie')!,/Secure/);assert.match(login.headers.get('set-cookie')!,/SameSite=Strict/);
    cookie=login.headers.get('set-cookie')!.split(';')[0]!;csrf=(await login.json() as {csrf:string}).csrf;
    assert.equal((await request('/api/worker/start','POST',{}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await request('/api/worker/start','POST',{}, {Origin:'https://evil.example.com'})).status,403);
    assert.equal((await request('/api/worker/stop','POST',{})).status,400);
    assert.equal((await request('/api/worker/stop','POST',{confirm:true})).status,202);
    assert.deepEqual(actions,[{actor:'ana',patch:{mode:'STOPPED'}}]);
    const events=await request('/api/events');assert.equal(events.status,200);assert.deepEqual(await events.json(),[{time:'2026-10-28T18:00:00.000Z',event:'batch_completed',received:5,inserted:4,duplicates:1}]);
    assert.equal((await request('/api/schedule','PATCH',{interval_ms:59999})).status,400);
    assert.equal((await request('/api/schedule','PATCH',{})).status,400);
    assert.equal((await request('/api/schedule','PATCH',{interval_ms:180000})).status,200);
    const saved=await request('/api/credentials','PUT',{...editable,revision:0});assert.equal(saved.status,200);assert.doesNotMatch(await saved.text(),/PRIVATE_PASSWORD|PRIVATE_SECRET|encrypted_payload/);
    assert.equal((await request('/api/credentials/test','POST',{})).status,200);
    const page=await request('/');assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.match(await page.text(),/Credenciais OLOS/);
    await request('/api/logout','POST',{});assert.equal((await request('/api/status')).status,401);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('session expiry and login throttling reject unauthorized changes',async()=>{
  let now=100000;const auth=new AdminAuth(['admin'],async(_username,password)=>{if(password!=='password-fixture')throw new Error('invalid');},async()=>{},()=>now);
  const login=await auth.login('admin','password-fixture');assert.equal(auth.session(`olos_admin=${login.token}`).actor,'admin');now+=8*3600000;
  assert.throws(()=>auth.session(`olos_admin=${login.token}`),/AUTHENTICATION_REQUIRED/);
  for(let i=0;i<10;i++)await assert.rejects(auth.login('unknown','incorrect'),/LOGIN_FAILED/);
  await assert.rejects(auth.login('admin','password-fixture'),/LOGIN_RATE_LIMITED/);
});

test('OLOS simulated password grant supplies backend client credentials; authorization is independent',async()=>{
  const {createMockAuthServer}=await import(new URL('../scripts/mock-olos-auth.mjs',import.meta.url).href);
  const {server,stats}=createMockAuthServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();assert(addr&&typeof addr!=='string');
  const localCfg={...cfg,sourceKey:'olos-admin-homolog',baseUrl:`http://127.0.0.1:${addr.port}/WebApiExportData`,
    username:'configured-service-user',password:'configured-service-password',clientId:'homolog-client',clientSecret:'homolog-client-secret'};
  const r=credentialRepo(),audit:unknown[]=[];
  const service=new CredentialService(r.repo,localCfg,key,[`http://127.0.0.1:${addr.port}`]);
  const auth=new AdminAuth(authorizedUsers('["homolog-admin"]'),(u,p)=>service.authenticateUser(u,p),async(actor,result)=>{audit.push({actor,result});});
  try{
    const login=await auth.login('homolog-admin','homolog-password');assert.equal(login.session.actor,'homolog-admin');
    assert.doesNotMatch(JSON.stringify(login.session),/homolog-password|homolog-client|PRIVATE_MOCK|access_token|refresh_token/);
    assert.equal((await service.snapshot()).credentials.password,'configured-service-password');
    assert.equal(await r.repo.credentials(),undefined); // login never migrates/saves submitted credentials
    await assert.rejects(auth.login('homolog-admin','wrong'),/LOGIN_FAILED/);
    await assert.rejects(auth.login('homolog-visitor','homolog-password'),/ADMIN_ACCESS_FORBIDDEN/);
    assert.equal(stats.auth_requests,3);assert.equal(stats.non_auth_requests,0);
    assert.deepEqual(audit,[{actor:'homolog-admin',result:'accepted'},{actor:'unauthenticated',result:'failed'},{actor:'unlisted-olos-user',result:'denied'}]);
    auth.logout(login.token);assert.throws(()=>auth.session(`olos_admin=${login.token}`),/AUTHENTICATION_REQUIRED/);
    const invalid=new CredentialService(r.repo,{...localCfg,clientSecret:'wrong'},key,[`http://127.0.0.1:${addr.port}`]);
    await assert.rejects(invalid.authenticateUser('homolog-admin','homolog-password'));
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('web login remains usable in ERROR and cannot start a scheduler or claim ingestion health',async()=>{
  const auth=new AdminAuth(['homolog-admin'],async()=>{},async()=>{});
  let requested=0;
  const r=credentialRepo();const service=new CredentialService(r.repo,cfg,key,['https://olos.example.com'],async()=>{});
  const server=adminServer({origin:'http://localhost:8081',publicDir:resolve('admin/public'),auth,credentials:service,
    scheduler:{async request(){requested++;},status:()=>({state:'ERROR',cycle_in_progress:false,next_run_at:null,error:'SOURCE_ID_UNIQUENESS_UNCONFIRMED',enabled:true,interval_ms:120000,desired_state:'RUNNING',updated_at:null,updated_by:null})},
    repository:{async logs(){return[];},async auditLog(){return[];},async observation(){return {database:{reachable:true,schema_valid:false,error:'DESTINATION_ID_GENERATOR_REQUIRED'},ingestion:{status:'NOT_OBSERVED',latest:null,last_completed:null,pending:[],last_error:null}};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert(addr&&typeof addr!=='string');
  try{
    const login=await fetch(`http://127.0.0.1:${addr.port}/api/login`,{method:'POST',headers:{Origin:'http://localhost:8081','Content-Type':'application/json'},body:JSON.stringify({username:'homolog-admin',password:'synthetic'})});
    assert.equal(login.status,200);const session=await login.json() as {csrf:string};const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const response=await fetch(`http://127.0.0.1:${addr.port}/api/status`,{headers:{Cookie:cookie}});const result=await response.json() as Record<string,any>;
    assert.equal(result.state,'ERROR');assert.equal(result.authentication.status,'ACCEPTED');assert.equal(result.database.schema_valid,false);assert.equal(result.ingestion.status,'NOT_OBSERVED');assert.equal(requested,0);
    const schedule=await fetch(`http://127.0.0.1:${addr.port}/api/schedule`,{method:'PATCH',headers:{Cookie:cookie,Origin:'http://localhost:8081','Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{"interval_ms":180000}'});
    assert.equal(schedule.status,200);assert.equal(requested,1);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('operational origin is inherited without recopying credentials or opening arbitrary destinations',()=>{
  assert.deepEqual(configuredOlosOrigins(cfg.baseUrl,''),['https://olos.example.com']);
  assert.deepEqual(configuredOlosOrigins(cfg.baseUrl,'https://olos.example.com, https://second.example.com'),['https://olos.example.com','https://second.example.com']);
  assert.throws(()=>configuredOlosOrigins(cfg.baseUrl,'https://evil.example.com'),/ADMIN_OLOS_ORIGIN_INVALID/);
  assert.throws(()=>configuredOlosOrigins('https://secret:password@olos.example.com/WebApiExportData'),/ADMIN_OLOS_ORIGIN_INVALID/);
});
