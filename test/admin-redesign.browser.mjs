// Standalone UI fixture. No database, scheduler, OLOS or existing HTTP service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { defaultRange } from '../admin/public/ui.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ADMIN_PLAYWRIGHT_PATH||'playwright');
const writes=[], requests=[],errors=[];
let session=false,state='STOPPED',interval=120000,eventPolls=0,reportError=false,statusError=false,empty=false,reportDelay=0;
const range=defaultRange();
const daily=Array.from({length:30},(_,i)=>{
  const d=new Date(range.from+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);
  return {day:d.toISOString().slice(0,10),calls:String(1000+i*20),identified_calls:String(400+i*8),operators:'12',with_cpf:'200',with_email:'300',confirmed:'350',pending:'650',not_queued:'0',inconsistent:'0'};
});
const metric={calls:'60000',identified_calls:'20000',operators:'18',with_cpf:'5000',with_email:'7000',confirmed:'11259',pending:'48741',not_queued:'0',inconsistent:'0',undated:'0',missing_mapping:'0'};
const report=()=>({from:range.from,to:range.to,summary:metric,period:metric,daily:empty?[]:daily,failed_reads:'2',observed_at:new Date().toISOString(),outbox_available:true});
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path});
  const json=(value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const files={'/':'index.html','/app.js':'app.js','/ui.js':'ui.js','/style.css':'style.css'};
  if(files[path]){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");res.end(await readFile(new URL('../admin/public/'+files[path],import.meta.url)));return;}
  let input={};if(req.method!=='GET'){let text='';for await(const chunk of req)text+=chunk;input=text?JSON.parse(text):{};writes.push({method:req.method,path,input,csrf:req.headers['x-csrf-token']});}
  if(path==='/api/login'){session=true;json({actor:'Homologação local',csrf:'fixture-csrf'});return;}
  if(!session){json({error:'AUTHENTICATION_REQUIRED'},401);return;}
  if(path==='/api/session'){json({actor:'Homologação local',csrf:'fixture-csrf'});return;}
  if(path==='/api/logout'){session=false;json({ok:true});return;}
  if(path==='/api/status'){
    if(statusError){json({error:'LOCAL_OR_DATABASE_FAILURE'},503);return;}
    json({state,desired_state:state,interval_ms:interval,cycle_in_progress:false,next_run_at:'2026-11-04T15:30:00Z',authentication:{status:'ACCEPTED'},database:{reachable:true,schema_valid:true},ingestion:{status:'CONFIRMED',pending:[],latest:{started_at:'2026-11-04T15:00:00Z',state:'done'},last_completed:{finished_at:'2026-11-04T15:01:00Z',received_count:8,inserted:5,duplicates:3,duration_ms:240}},corporate_delivery:{ready:true,paused:true,blocked:false}});return;
  }
  if(path==='/api/reports'){if(reportDelay)await new Promise(r=>setTimeout(r,reportDelay));if(reportError)json({error:'LOCAL_OR_DATABASE_FAILURE'},503);else json(report());return;}
  if(path==='/api/events'){eventPolls++;json(Array.from({length:240},(_,i)=>({time:'2026-11-04T15:00:00.000Z',event:i===239?'scheduler_error':i===238?'poll_retry':'batch_completed',received:eventPolls,error:i===239?'RECOVERY_REQUIRED':undefined,email:'PRIVATE_EMAIL',payload:'PRIVATE_PAYLOAD'})));return;}
  if(path==='/api/logs'){json([{id:'fixture-read',started_at:'2026-11-04T15:00:00Z',state:'done',processed_count:5,received_count:5,request_ms:20}]);return;}
  if(path==='/api/audit'){json([{occurred_at:'2026-11-04T15:00:00Z',actor:'fixture-admin',action:'scheduler_state'}]);return;}
  if(path==='/api/schedule'){interval=input.interval_ms;json({interval_ms:interval});return;}
  if(path.startsWith('/api/worker/')){state=path.endsWith('stop')?'STOPPED':path.endsWith('pause')?'PAUSED':'RUNNING';json({},202);return;}
  if(path==='/api/credentials/test'){json({ok:true,code:'CONNECTION_OK',at:'2026-11-04T15:00:00Z',duration_ms:20});return;}
  if(path==='/api/credentials'){json({revision:1,baseUrl:'https://fixture.invalid/WebApiExportData',username:'fixture',complete:true,origin:'environment',passwordConfigured:true});return;}
  json({error:'NOT_FOUND'},404);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.ADMIN_CHROMIUM_PATH?{executablePath:process.env.ADMIN_CHROMIUM_PATH}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
const watchdog=setTimeout(()=>void browser.close(),60000);
const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>assert(r.url().startsWith(origin+'/')||r.url().startsWith('blob:'),'Unexpected external request'));
const waitText=(id,value)=>page.waitForFunction(([id,value])=>document.getElementById(id).textContent.includes(value),[id,value]);
const nav=async name=>{console.log('UI:',name);await page.getByRole('button',{name,exact:true}).click();};
const screenshot=async(file)=>{
  await page.evaluate(()=>{const p=document.createElement('p');p.id='fixture-label';p.textContent='HOMOLOGAÇÃO LOCAL · DADOS SINTÉTICOS DE TESTE';document.querySelector('main').prepend(p);});
  await page.screenshot({path:file,fullPage:true});await page.locator('#fixture-label').evaluate(e=>e.remove());
};
try{
  await page.goto(origin);await page.locator('#login').waitFor({state:'visible'});
  await page.locator('#login-form').getByLabel('Usuário OLOS',{exact:true}).fill('fixture');await page.locator('#login-form').getByLabel('Senha OLOS',{exact:true}).fill('fixture');await nav('Entrar');
  await waitText('metric-calls','60.000');await waitText('event-output','batch_completed');assert.equal(await page.locator('#calls-chart svg').count(),1);assert.equal(await page.locator('#event-output').textContent().then(s=>s.split('\n').length),200);
  assert.equal(writes.length,1,'Dashboard must not perform operational writes');assert.match(await page.locator('#metric-confirmed').textContent(),/11.259/);assert.equal(await page.locator('#corporate-state').textContent(),'Pausado');
  await screenshot('/tmp/olos-admin-dashboard-desktop.png');
  await page.locator('#event-level').selectOption('ERROR');assert.doesNotMatch(await page.locator('#event-output').textContent(),/batch_completed/);assert.match(await page.locator('#event-output').textContent(),/12:00:00/);
  await page.locator('#event-search').fill('absent');await waitText('event-output','Nenhum evento');await page.locator('#event-search').fill('');
  await nav('Pausar visualização');const frozen=await page.locator('#event-output').textContent();await page.waitForTimeout(2200);assert.equal(await page.locator('#event-output').textContent(),frozen);
  await nav('Copiar logs');await waitText('event-status','Logs sanitizados copiados');const copy=await page.evaluate(()=>Promise.race([navigator.clipboard.readText(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Clipboard read timeout')),3000))]));assert.match(copy,/scheduler_error/);assert.doesNotMatch(copy,/PRIVATE/);await nav('Retomar visualização');await page.locator('#event-level').selectOption('ALL');
  await nav('Relatórios');await waitText('report-page','Página 1 de 3');assert.equal(await page.locator('#report-rows tr').count(),14);
  await nav('Próxima');await waitText('report-page','Página 2');await nav('Próxima');assert.equal(await page.locator('#report-rows tr').count(),2);
  const download=page.waitForEvent('download');await nav('Exportar CSV');const file=await download;assert.match(file.suggestedFilename(),/^olos-chamadas-/);const csv=await readFile(await file.path(),'utf8');assert.equal(csv.split('\r\n').length,31);assert.doesNotMatch(csv,/PRIVATE/);assert.equal(writes.length,1);
  await nav('Terminal / Logs');await waitText('log-rows','fixture-read');assert.equal(await page.locator('#logs-terminal #terminal').count(),1);
  await nav('Agendamento');await page.getByLabel('Intervalo em minutos').fill('3');await nav('Salvar intervalo');await waitText('notice','Intervalo salvo');assert.deepEqual(writes.at(-1),{method:'PATCH',path:'/api/schedule',input:{interval_ms:180000},csrf:'fixture-csrf'});
  await nav('Credenciais OLOS');await waitText('credentials-complete','completa');await nav('Salvar credenciais');await waitText('notice','Credenciais salvas');assert.equal(writes.at(-1).path,'/api/credentials');assert.deepEqual(writes.at(-1).input,{baseUrl:'https://fixture.invalid/WebApiExportData',username:'fixture',password:'',revision:1});await nav('Testar conexão salva');await waitText('test-result','Autenticação validada');
  await nav('Iniciar Worker');await waitText('state','RUNNING');await nav('Agendamento');await nav('Pausar agendamento');await waitText('state','PAUSED');await nav('Retomar agendamento');await waitText('state','RUNNING');
  await nav('Parar Worker');await nav('Cancelar');assert.equal(state,'RUNNING');await nav('Parar Worker');await nav('Confirmar parada');await waitText('state','STOPPED');assert.deepEqual(writes.at(-1).input,{confirm:true});
  await nav('Status operacional');await waitText('audit-rows','fixture-admin');await nav('Dashboard');
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0.5);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('/tmp/olos-admin-dashboard-mobile.png');
  await nav('Abrir navegação');await nav('Relatórios');await waitText('report-page','Página 1');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  reportError=true;await nav('Aplicar período');await waitText('report-status','Relatório indisponível');assert(await page.locator('#export-report').isDisabled());assert.equal(await page.locator('#report-rows tr').count(),0);
  reportError=false;empty=true;await nav('Aplicar período');await waitText('report-page','Nenhuma chamada');assert(await page.locator('#export-report').isDisabled());empty=false;
  // A delayed report must not restore data after logout/session expiration.
  reportDelay=500;await nav('Aplicar período');await nav('Abrir navegação');await nav('Sair');await page.locator('#login').waitFor({state:'visible'});await page.waitForTimeout(600);assert.equal(await page.locator('#report-rows tr').count(),0);assert(await page.locator('#terminal').isHidden());
  reportDelay=0;reportError=true;await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');
  await waitText('metrics-error','Não foi possível');assert.equal(await page.locator('#metric-calls').textContent(),'—');
  await nav('Abrir navegação');await nav('Sair');await page.locator('#login').waitFor({state:'visible'});reportError=false;empty=true;
  await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');await waitText('calls-chart','Nenhuma chamada');
  assert.deepEqual(errors,[]);assert(writes.filter(w=>w.path!=='/api/login').every(w=>w.csrf==='fixture-csrf'));
  assert(!writes.some(w=>w.path==='/api/reports'));
  console.log('PASS browser: desktop/mobile, graph, exact metric sources, 200-event bound/filter/pause/copy, pagination/full CSV, all original actions/CSRF/stop dialog, errors/empty states, logout race; no real services.');
}finally{clearTimeout(watchdog);await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
