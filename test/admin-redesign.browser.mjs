// Standalone UI fixture. No database, scheduler, OLOS or existing HTTP service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { defaultRange } from '../admin/public/ui.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ADMIN_PLAYWRIGHT_PATH||'playwright');
const writes=[], requests=[],errors=[];
let session=false,state='RUNNING',interval=120000,eventPolls=0,reportError=false,statusError=false,eventError=false,empty=false,reportDelay=0;
let baseServer=Date.now(),baseReal=Date.now(),todayError=false,todayDelay=0,todayCalls='1280',activeCycle=false;
const serverNow=()=>baseServer+Date.now()-baseReal;
const setServerTime=ms=>{baseServer=ms;baseReal=Date.now();};
let nextAt=new Date(serverNow()+102000).toISOString();
const range=defaultRange(new Date(serverNow()));
const daily=Array.from({length:30},(_,i)=>{
  const d=new Date(range.from+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);
  return {day:d.toISOString().slice(0,10),calls:String(1000+i*20),identified_calls:String(400+i*8),operators:'12',with_cpf:'200',with_email:'300',confirmed:'350',pending:'650',not_queued:'0',inconsistent:'0'};
});
const metric={calls:'60000',identified_calls:'20000',operators:'18',with_cpf:'5000',with_email:'7000',confirmed:'11259',pending:'48738',not_queued:'0',inconsistent:'3',undated:'4',missing_mapping:'2'};
const report=()=>({from:range.from,to:range.to,summary:metric,period:metric,daily:empty?[]:daily,failed_reads:'2',observed_at:new Date().toISOString(),outbox_available:true});
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path});
  const json=(value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const files={'/':'index.html','/app.js':'app.js','/ui.js':'ui.js','/dashboard.js':'dashboard.js','/style.css':'style.css'};
  if(files[path]){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");res.end(await readFile(new URL('../admin/public/'+files[path],import.meta.url)));return;}
  let input={};if(req.method!=='GET'){let text='';for await(const chunk of req)text+=chunk;input=text?JSON.parse(text):{};writes.push({method:req.method,path,input,csrf:req.headers['x-csrf-token']});}
  if(path==='/api/login'){session=true;json({actor:'Homologação local',csrf:'fixture-csrf'});return;}
  if(!session){json({error:'AUTHENTICATION_REQUIRED'},401);return;}
  if(path==='/api/session'){json({actor:'Homologação local',csrf:'fixture-csrf'});return;}
  if(path==='/api/logout'){session=false;json({ok:true});return;}
  if(path==='/api/status'){
    if(statusError){json({error:'LOCAL_OR_DATABASE_FAILURE'},503);return;}
    json({state,desired_state:state,interval_ms:interval,cycle_in_progress:activeCycle,next_run_at:nextAt,server_time:new Date(serverNow()).toISOString(),authentication:{status:'ACCEPTED'},database:{reachable:true,schema_valid:true},ingestion:{status:'CONFIRMED',pending:[],latest:{started_at:'2026-11-04T15:00:00Z',state:'done'},last_completed:{finished_at:'2026-11-04T15:01:00Z',received_count:8,inserted:5,duplicates:3,duration_ms:240}},corporate_delivery:{ready:true,paused:true,blocked:false}});return;
  }
  if(path==='/api/today'){if(todayDelay)await new Promise(r=>setTimeout(r,todayDelay));if(todayError)json({error:'LOCAL_OR_DATABASE_FAILURE'},503);else json({date:defaultRange(new Date(serverNow())).to,calls:todayCalls,observed_at:new Date(serverNow()).toISOString(),cache_seconds:300,server_time:new Date(serverNow()).toISOString(),time_basis:'first_local_persistence'});return;}
  if(path==='/api/reports'){if(reportDelay)await new Promise(r=>setTimeout(r,reportDelay));if(reportError)json({error:'LOCAL_OR_DATABASE_FAILURE'},503);else {const r=report(),q=new URL(req.url,'http://localhost').searchParams;r.from=q.get('from')||r.from;r.to=q.get('to')||r.to;r.daily=r.daily.filter(d=>d.day>=r.from&&d.day<=r.to);json(r);}return;}
  if(path==='/api/events'){eventPolls++;if(eventError){json({error:'LOCAL_OR_DATABASE_FAILURE'},503);return;}json(Array.from({length:240},(_,i)=>({time:'2026-11-04T15:00:00.000Z',event:i===239?'scheduler_error':i===238?'poll_retry':'batch_completed',received:eventPolls,error:i===239?'RECOVERY_REQUIRED':undefined,email:'PRIVATE_EMAIL',payload:'PRIVATE_PAYLOAD'})));return;}
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
const watchdog=setTimeout(()=>void browser.close(),90000);
const page=await context.newPage();
await page.addInitScript(()=>{const original=window.setInterval.bind(window);window.setInterval=(fn,ms,...args)=>{if(ms===30000)window.__reportPoll=fn;if(ms===1000)window.__clockTick=fn;if(ms===2000)window.__statusPoll=fn;return original(fn,ms,...args);};});
page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
// HTTP 401/503 are deliberately injected below; application console errors are not.
page.on('console',message=>{if(message.type()==='error'&&!/^Failed to load resource: the server responded with a status of (401|404|503)\b/.test(message.text()))errors.push(message.text());});
page.on('request',r=>assert(r.url().startsWith(origin+'/')||r.url().startsWith('blob:'),'Unexpected external request'));
const waitText=(id,value)=>page.waitForFunction(([id,value])=>document.getElementById(id).textContent.includes(value),[id,value]);
const nav=async name=>{console.log('UI:',name);await page.getByRole('button',{name,exact:true}).click();};
const screenshot=async(file)=>{
  await page.evaluate(()=>{const p=document.createElement('p');p.id='fixture-label';p.textContent='HOMOLOGAÇÃO LOCAL · DADOS SINTÉTICOS DE TESTE';document.querySelector('main').prepend(p);});
  if((await page.viewportSize()).width<760)await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0.5);
  await page.screenshot({path:file,fullPage:true});await page.locator('#fixture-label').evaluate(e=>e.remove());
};
try{
  await page.goto(origin);await page.locator('#login').waitFor({state:'visible'});
  await page.locator('#login-form').getByLabel('Usuário OLOS',{exact:true}).fill('fixture');await page.locator('#login-form').getByLabel('Senha OLOS',{exact:true}).fill('fixture');await nav('Entrar');
  await waitText('today-calls','1.280');await waitText('event-output','batch_completed');
  assert.equal(await page.locator('#metrics > article').count(),2);
  assert.equal(await page.locator('[data-view="dashboard"] #metric-calls').count(),0);
  assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#calls-chart svg').count(),0);
  assert.equal(requests.filter(r=>r.path==='/api/reports').length,0,'collapsed dashboard must not request history');
  assert.equal(await page.locator('#event-output .event-line').count(),12);
  assert.equal(await page.locator('#dashboard-terminal #terminal').count(),1);
  assert(await page.evaluate(()=>{const cards=document.querySelector('#metrics'),terminal=document.querySelector('#dashboard-terminal'),chart=document.querySelector('#chart-panel');return !!(cards.compareDocumentPosition(terminal)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(terminal.compareDocumentPosition(chart)&Node.DOCUMENT_POSITION_FOLLOWING);}));
  assert.equal(writes.length,1);
  const dailyRequests=requests.filter(r=>['/api/today','/api/reports'].includes(r.path)).length;
  await page.evaluate(()=>{for(let i=0;i<100;i++)window.__clockTick();});
  assert.equal(requests.filter(r=>['/api/today','/api/reports'].includes(r.path)).length,dailyRequests,'visual ticks do not fetch');
  await mkdir('admin/evidence',{recursive:true});
  await screenshot('admin/evidence/premium-desktop.png');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot('admin/evidence/premium-mobile.png');
  await page.setViewportSize({width:1440,height:1100});
  // Keyboard accordion, cached reopening, and independent SVG failure.
  await page.locator('#chart-toggle').focus();await page.keyboard.press('Enter');
  await page.locator('#calls-chart svg').waitFor();assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'true');
  await screenshot('admin/evidence/premium-expanded.png');
  const historyRequests=requests.filter(r=>r.path==='/api/reports').length;
  await page.locator('#chart-toggle').focus();await page.keyboard.press('Space');assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'false');
  await page.keyboard.press('Enter');await page.waitForTimeout(250);assert.equal(requests.filter(r=>r.path==='/api/reports').length,historyRequests);
  await page.evaluate(()=>{const original=document.createElementNS.bind(document);document.createElementNS=()=>{throw new Error('synthetic SVG failure');};window.dispatchEvent(new Event('resize'));document.createElementNS=original;});
  await waitText('calls-chart','indicadores permanecem válidos');assert.equal(await page.locator('#today-calls').textContent(),'1.280');
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));assert.equal(await page.locator('#calls-chart svg').count(),1);
  todayError=true;await page.evaluate(()=>window.__reportPoll());await waitText('today-updated','Desatualizado');
  assert.equal(await page.locator('#today-calls').textContent(),'1.280');assert.equal(await page.locator('#calls-chart svg').count(),1);
  todayError=false;todayCalls='1291';await page.evaluate(()=>window.__reportPoll());await waitText('today-calls','1.291');
  // Status failures cannot hide daily values or stop the independent terminal feed.
  statusError=true;const polls=eventPolls;await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Sem conexão');
  await page.waitForFunction(()=>document.getElementById('today-calls').textContent==='1.291');await page.waitForTimeout(100);assert(eventPolls>polls);
  statusError=false;await page.evaluate(()=>window.__statusPoll());
  for(const [mode,label]of [['PAUSED','Pausado'],['STOPPED','Parado'],['ERROR','Erro operacional'],['PAUSING','Pausando'],['STOPPING','Finalizando']]){state=mode;await page.evaluate(()=>window.__statusPoll());await waitText('countdown',label);}
  state='RUNNING';nextAt=null;await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Sem agendamento');
  nextAt=new Date(serverNow()-1000).toISOString();await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Aguardando execução');
  activeCycle=true;await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Em leitura');activeCycle=false;
  nextAt=new Date(serverNow()+102000).toISOString();await page.evaluate(()=>window.__statusPoll());assert.match(await page.locator('#countdown').textContent(),/^01:(4[01]|39|42)$/);
  await page.locator('#terminal-filters > summary').click();
  await page.locator('#event-all').check();assert.equal(await page.locator('#event-output .event-line').count(),200);
  await page.locator('#event-level').selectOption('ERROR');assert.doesNotMatch(await page.locator('#event-output').textContent(),/batch_completed/);assert.match(await page.locator('#event-output').textContent(),/12:00:00/);
  await page.locator('#event-search').fill('absent');await waitText('event-output','Nenhum evento');await page.locator('#event-search').fill('');
  await nav('Pausar visualização');const frozen=await page.locator('#event-output').textContent();await page.waitForTimeout(2200);assert.equal(await page.locator('#event-output').textContent(),frozen);
  await nav('Copiar logs');await waitText('event-status','Logs sanitizados copiados');const copy=await page.evaluate(()=>Promise.race([navigator.clipboard.readText(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Clipboard read timeout')),3000))]));assert.match(copy,/scheduler_error/);assert.doesNotMatch(copy,/PRIVATE/);await nav('Retomar visualização');await page.locator('#event-level').selectOption('ALL');
  await page.locator('#event-autoscroll').uncheck();
  await page.locator('#event-output').evaluate(e=>{e.scrollTop=40;});
  await page.evaluate(()=>window.__statusPoll());await page.waitForTimeout(100);
  assert.equal(await page.locator('#event-output').evaluate(e=>e.scrollTop),40);
  eventError=true;await page.evaluate(()=>window.__statusPoll());await waitText('terminal-live','SEM ATUALIZAÇÃO');
  await page.locator('#event-search').fill('scheduler_error');await waitText('terminal-live','SEM ATUALIZAÇÃO');await waitText('event-status','desatualizada');
  eventError=false;await page.locator('#event-search').fill('');await page.locator('#event-autoscroll').check();await page.evaluate(()=>window.__statusPoll());await waitText('terminal-live','AO VIVO');
  await nav('Relatórios');await waitText('report-page','Página 1 de 3');await waitText('metric-calls','60.000');assert.equal(await page.locator('#historical-metrics > article').count(),6);assert.equal(await page.locator('#corporate-state').textContent(),'Pausado');assert.match(await page.locator('#integrity-details').textContent(),/Registros sem data de chamada4Mappings sem registro local2Recibos divergentes3/);await screenshot('admin/evidence/premium-reports.png');assert.equal(await page.locator('#report-rows tr').count(),14);
  await nav('Próxima');await waitText('report-page','Página 2');await nav('Próxima');assert.equal(await page.locator('#report-rows tr').count(),2);
  const download=page.waitForEvent('download');await nav('Exportar CSV');const file=await download;assert.match(file.suggestedFilename(),/^olos-chamadas-/);const csv=await readFile(await file.path(),'utf8');assert.equal(csv.split('\r\n').length,31);assert.doesNotMatch(csv,/PRIVATE/);assert.equal(writes.length,1);
  await page.locator('#report-from').fill(range.to);await page.locator('#report-to').fill(range.to);await nav('Aplicar período');await waitText('report-page','1 dias');assert.equal(await page.locator('#report-rows tr').count(),1);
  await page.locator('#report-from').fill(range.from);await nav('Aplicar período');await waitText('report-page','Página 1 de 3');
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#chart-body').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await page.emulateMedia({reducedMotion:'no-preference'});
  await nav('Terminal / Logs');await waitText('log-rows','fixture-read');assert.equal(await page.locator('#logs-terminal #terminal').count(),1);
  await nav('Agendamento');await page.getByLabel('Intervalo em minutos').fill('3');await nav('Salvar intervalo');await waitText('notice','Intervalo salvo');assert.deepEqual(writes.at(-1),{method:'PATCH',path:'/api/schedule',input:{interval_ms:180000},csrf:'fixture-csrf'});
  await nav('Credenciais OLOS');await waitText('credentials-complete','completa');await nav('Salvar credenciais');await waitText('notice','Credenciais salvas');assert.equal(writes.at(-1).path,'/api/credentials');assert.deepEqual(writes.at(-1).input,{baseUrl:'https://fixture.invalid/WebApiExportData',username:'fixture',password:'',revision:1});await nav('Testar conexão salva');await waitText('test-result','Autenticação validada');
  state='STOPPED';await page.evaluate(()=>window.__statusPoll());await nav('Iniciar Worker');await waitText('state','Operando');await nav('Agendamento');await nav('Pausar agendamento');await waitText('state','Pausado');await nav('Retomar agendamento');await waitText('state','Operando');
  await nav('Parar Worker');await nav('Cancelar');assert.equal(state,'RUNNING');await nav('Parar Worker');await nav('Confirmar parada');await waitText('state','Parado');assert.deepEqual(writes.at(-1).input,{confirm:true});
  await nav('Status operacional');await waitText('audit-rows','fixture-admin');await nav('Dashboard');
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0.5);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#chart-toggle').click();await page.waitForTimeout(250);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await nav('Abrir navegação');await nav('Relatórios');await waitText('report-page','Página 1');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  reportError=true;await nav('Aplicar período');await waitText('report-status','Relatório indisponível');assert(await page.locator('#export-report').isDisabled());assert.equal(await page.locator('#report-rows tr').count(),0);
  reportError=false;empty=true;await nav('Aplicar período');await waitText('report-page','Nenhuma chamada');assert(await page.locator('#export-report').isDisabled());empty=false;
  // A delayed report must not restore data after logout/session expiration.
  reportDelay=500;await nav('Aplicar período');await nav('Abrir navegação');await nav('Sair');await page.locator('#login').waitFor({state:'visible'});await page.waitForTimeout(600);assert.equal(await page.locator('#report-rows tr').count(),0);assert(await page.locator('#terminal').isHidden());
  reportDelay=0;reportError=true;todayError=true;await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');
  await waitText('today-updated','indisponível');assert.equal(await page.locator('#today-calls').textContent(),'—');assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'false');await page.locator('#chart-toggle').click();await waitText('chart-status','Série indisponível');todayError=false;await page.evaluate(()=>window.__reportPoll());await waitText('today-calls','1.291');assert.match(await page.locator('#chart-status').textContent(),/Série indisponível/);
  await nav('Abrir navegação');await nav('Sair');await page.locator('#login').waitFor({state:'visible'});reportError=false;empty=true;todayError=false;
  await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');await page.locator('#chart-toggle').click();await waitText('calls-chart','Nenhuma chamada');
  // Calendar rollover is driven by the synchronized Brasília day, not the browser timezone.
  setServerTime(Date.parse('2026-11-02T02:59:50Z'));todayCalls='25';await page.evaluate(()=>window.__statusPoll());await page.evaluate(()=>window.__reportPoll());await waitText('today-calls','25');
  todayDelay=350;todayCalls='2';setServerTime(Date.parse('2026-11-02T03:00:00Z'));
  await page.evaluate(()=>window.__statusPoll());await waitText('today-updated','Novo dia');assert.equal(await page.locator('#today-calls').textContent(),'—');
  await waitText('today-calls','2');todayDelay=0;
  // A delayed daily response cannot repopulate the next session or a logged-out view.
  todayDelay=500;await page.evaluate(()=>window.__reportPoll());await nav('Abrir navegação');await nav('Sair');await page.waitForTimeout(650);
  assert.equal(await page.locator('#today-calls').textContent(),'—');assert.equal(await page.locator('#countdown').textContent(),'—');
  todayDelay=0;await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');await waitText('today-calls','2');
  session=false;await page.evaluate(()=>window.__reportPoll());await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#today-calls').textContent(),'—');assert(await page.locator('#terminal').isHidden());
  assert.deepEqual(errors,[]);assert(writes.filter(w=>w.path!=='/api/login').every(w=>w.csrf==='fixture-csrf'));
  assert(!writes.some(w=>w.path==='/api/reports'));
  console.log('PASS browser: premium two cards, daily increment/error/midnight, real countdown states, no requests per tick, accordion keyboard/cache, independent feeds; desktop/mobile, graph, exact metric sources, 200-event bound/filter/pause/copy, pagination/full CSV, all original actions/CSRF/stop dialog, errors/empty states, logout race; no real services.');
}finally{clearTimeout(watchdog);await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
