// Standalone UI fixture. No database, scheduler, OLOS or existing HTTP service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { defaultRange } from '../admin/public/ui.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ADMIN_PLAYWRIGHT_PATH||'playwright');
const writes=[], requests=[],errors=[];
const evidenceDir=process.env.ADMIN_EVIDENCE_DIR||'admin/evidence';
let reportHold=null,releaseReport=null,reportHoldFrom=null,todayHold=null,releaseToday=null;
let statusDelay=0,eventDelay=0,eventOffset=0,eventsActive=0,maxEventsActive=0;
const eventTimes=[];
let session=false,state='RUNNING',interval=120000,eventPolls=0,reportError=false,statusError=false,eventError=false,empty=false,reportDelay=0;
let todayAutomatic=null;
let baseServer=Date.now(),baseReal=Date.now(),todayError=false,todayDelay=0,todayCalls='1280',activeCycle=false;
const serverNow=()=>baseServer+Date.now()-baseReal;
const setServerTime=ms=>{baseServer=ms;baseReal=Date.now();};
let nextAt=new Date(serverNow()+102000).toISOString();
const range=defaultRange(new Date(serverNow()));
const daily=Array.from({length:30},(_,i)=>{
  const d=new Date(range.from+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);
  return {day:d.toISOString().slice(0,10),calls:String(1000+i*20),identified_calls:String(400+i*8),operators:'12',with_cpf:'200',with_email:'300',confirmed:'350',pending:String(650+i*20),not_queued:'0',inconsistent:'0'};
});
const metric={calls:'60000',identified_calls:'20000',operators:'18',with_cpf:'5000',with_email:'7000',confirmed:'11259',pending:'48738',not_queued:'0',inconsistent:'3',undated:'4',missing_mapping:'2'};
let outboxAvailable=true;
const report=()=>({from:range.from,to:range.to,summary:{...metric},daily:empty?[]:daily.map(row=>({...row})),failed_reads:'2',observed_at:new Date(serverNow()).toISOString(),outbox_available:outboxAvailable});
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
    if(statusDelay)await new Promise(r=>setTimeout(r,statusDelay));
    if(statusError){json({error:'LOCAL_OR_DATABASE_FAILURE'},503);return;}
    json({state,desired_state:state,interval_ms:interval,cycle_in_progress:activeCycle,next_run_at:nextAt,server_time:new Date(serverNow()).toISOString(),authentication:{status:'ACCEPTED'},database:{reachable:true,schema_valid:true},ingestion:{status:'CONFIRMED',pending:[],latest:{started_at:'2026-11-04T15:00:00Z',state:'done'},last_completed:{finished_at:'2026-11-04T15:01:00Z',received_count:8,inserted:5,duplicates:3,duration_ms:240}},corporate_delivery:{ready:true,paused:true,blocked:false}});return;
  }
  if(path==='/api/today'||path==='/api/today/refresh'){if(path.endsWith('/refresh')&&(req.method!=='POST'||req.headers['x-csrf-token']!=='fixture-csrf')){json({error:'CSRF_FORBIDDEN'},403);return;}if(todayHold)await todayHold;if(todayDelay)await new Promise(r=>setTimeout(r,todayDelay));if(todayError)json({error:'LOCAL_OR_DATABASE_FAILURE'},503);else json({date:defaultRange(new Date(serverNow())).to,calls:todayCalls,observed_at:new Date(serverNow()).toISOString(),cache_seconds:300,server_time:new Date(serverNow()).toISOString(),time_basis:'first_local_persistence',...(path==='/api/today'&&todayAutomatic?todayAutomatic:{})});return;}
  if(path==='/api/reports'){if(reportHold&&new URL(req.url,'http://localhost').searchParams.get('from')===(reportHoldFrom||daily.at(-14).day))await reportHold;if(reportDelay)await new Promise(r=>setTimeout(r,reportDelay));if(reportError)json({error:'LOCAL_OR_DATABASE_FAILURE'},503);else {const r=report(),q=new URL(req.url,'http://localhost').searchParams;r.from=q.get('from')||r.from;r.to=q.get('to')||r.to;r.daily=r.daily.filter(d=>d.day>=r.from&&d.day<=r.to);
    r.period={operators:r.daily.length?'12':'0'};
    for(const key of ['calls','identified_calls','with_cpf','with_email','confirmed','pending','not_queued','inconsistent'])r.period[key]=r.daily.reduce((n,d)=>n+BigInt(d[key]),0n).toString();
    if(!outboxAvailable)for(const part of [r.summary,r.period,...r.daily])for(const key of ['confirmed','pending','not_queued','inconsistent'])part[key]=null;
    json(r);}return;}
  if(path==='/api/events'){eventPolls++;eventTimes.push(Date.now());eventsActive++;maxEventsActive=Math.max(maxEventsActive,eventsActive);if(eventDelay)await new Promise(r=>setTimeout(r,eventDelay));eventsActive--;if(eventError){json({error:'LOCAL_OR_DATABASE_FAILURE'},503);return;}json(Array.from({length:240},(_,i)=>({time:'2026-11-04T15:00:00.000Z',event:i+eventOffset===239?'scheduler_error':i+eventOffset===238?'poll_retry':'batch_completed',received:i+eventOffset,inserted:5,duplicates:2,request_ms:42,skipped:1,next_run_at:'2026-11-04T15:02:00.000Z',error:i+eventOffset===239?'RECOVERY_REQUIRED':undefined,email:'PRIVATE_EMAIL',payload:'PRIVATE_PAYLOAD'})));return;}
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
const context=await browser.newContext({viewport:{width:1600,height:1365},hasTouch:true,permissions:['clipboard-read','clipboard-write']});
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
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.locator('#chart-panel').evaluate(e=>Promise.all(e.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{}))));
  await page.evaluate(()=>{const p=document.createElement('p');p.id='fixture-label';p.style.cssText='position:fixed;bottom:4px;right:8px;z-index:20;margin:0;padding:3px 8px;background:white;border:1px solid #bec9c2;font-size:10px;color:#3f4944';p.textContent='HOMOLOGAÇÃO LOCAL · DADOS SINTÉTICOS DE TESTE';document.querySelector('main').prepend(p);});
  if((await page.viewportSize()).width<760)await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0.5);
  await page.screenshot({path:file.replace('admin/evidence',evidenceDir),fullPage:true});await page.locator('#fixture-label').evaluate(e=>e.remove());
};
try{
  await page.goto(origin);await page.locator('#login').waitFor({state:'visible'});
  await page.locator('#login-form').getByLabel('Usuário OLOS',{exact:true}).fill('fixture');await page.locator('#login-form').getByLabel('Senha OLOS',{exact:true}).fill('fixture');await nav('Entrar');
  await waitText('today-calls','1.280');await waitText('event-output','batch_completed');
  assert.equal(await page.locator('#metrics > article').count(),2);
  assert.equal(await page.locator('[data-view="dashboard"] #metric-calls').count(),0);
  assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#calls-chart svg').count(),0);
  assert.equal(requests.filter(r=>r.path==='/api/reports').length,0,'collapsed dashboard must not request history');
  assert.equal(await page.locator('#event-output .event-line').count(),200);
  assert.equal(await page.locator('#dashboard-terminal #terminal').count(),1);
  assert(await page.evaluate(()=>{const cards=document.querySelector('#metrics'),terminal=document.querySelector('#dashboard-terminal'),chart=document.querySelector('#chart-panel');return !!(cards.compareDocumentPosition(terminal)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(terminal.compareDocumentPosition(chart)&Node.DOCUMENT_POSITION_FOLLOWING);}));
  assert.equal(writes.length,1);
  // Daily manual refresh reuses the existing GET, state and in-flight guard.
  const refreshToday=page.getByRole('button',{name:'Atualizar coleta do dia',exact:true});
  const iconStyle=selector=>page.locator(selector).evaluate(e=>{const s=getComputedStyle(e);return [s.width,s.height,s.backgroundColor,s.borderRadius,s.color];});
  assert.deepEqual(await iconStyle('#refresh-today'),await iconStyle('#countdown-card .metric-icon'));
  assert.equal(await refreshToday.locator('use').getAttribute('href'),'#icon-refresh');
  assert.equal(await page.locator('#today-card use[href="#icon-arrow"]').count(),0);
  const beforeManual=await page.locator('#today-updated').textContent(),manualClock=serverNow();
  const todayRequests=()=>requests.filter(r=>r.path.startsWith('/api/today')).length;
  const beforeRequests=todayRequests();todayCalls='1287';setServerTime(manualClock+60000);
  todayHold=new Promise(resolve=>{releaseToday=resolve;});
  await refreshToday.click();await page.waitForFunction(()=>document.getElementById('refresh-today').getAttribute('aria-busy')==='true');
  assert(await refreshToday.isDisabled());assert.equal(await page.locator('#today-calls').textContent(),'1.280');
  assert.equal(await refreshToday.locator('svg').evaluate(e=>getComputedStyle(e).animationName),'today-refresh-spin');
  await page.evaluate(()=>{document.getElementById('refresh-today').click();window.__reportPoll();});
  assert.equal(todayRequests(),beforeRequests+1,'manual/automatic refresh coalesce into the same request');
  assert.deepEqual(requests.filter(r=>r.path==='/api/today/refresh').at(-1),{method:'POST',path:'/api/today/refresh'});
  await mkdir(evidenceDir,{recursive:true});await page.locator('#today-card').screenshot({path:evidenceDir+'/daily-refresh-loading.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await refreshToday.locator('svg').evaluate(e=>getComputedStyle(e).animationName),'none');
  releaseToday();todayHold=null;await waitText('today-calls','1.287');
  assert(!(await refreshToday.isDisabled()));assert.equal(await refreshToday.getAttribute('aria-busy'),'false');
  assert.notEqual(await page.locator('#today-updated').textContent(),beforeManual);
  assert.match(await page.locator('#today-updated').textContent(),/atualização a cada 5 min/);
  await page.locator('#today-card').screenshot({path:evidenceDir+'/daily-refresh-success.png'});
  // An automatic poll may carry an older published snapshot after a live count.
  const manualFooter=await page.locator('#today-updated').textContent();
  todayAutomatic={calls:'1200',observed_at:new Date(manualClock-60000).toISOString()};
  const staleResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/today');
  await page.evaluate(()=>window.__reportPoll());await staleResponse;
  await page.waitForFunction(()=>document.getElementById('refresh-today').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#today-calls').textContent(),'1.287');assert.equal(await page.locator('#today-updated').textContent(),manualFooter);todayAutomatic=null;
  todayError=true;await refreshToday.focus();
  assert(await refreshToday.evaluate(e=>parseFloat(getComputedStyle(e).outlineWidth)>=2));
  await page.keyboard.press('Enter');await waitText('today-updated','falha ao atualizar');
  assert.equal(await page.locator('#today-calls').textContent(),'1.287');assert(!(await refreshToday.isDisabled()));
  await page.locator('#today-card').screenshot({path:evidenceDir+'/daily-refresh-error.png'});
  await page.setViewportSize({width:390,height:844});
  assert.deepEqual(await iconStyle('#refresh-today'),await iconStyle('#countdown-card .metric-icon'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#today-card').screenshot({path:evidenceDir+'/daily-refresh-mobile-error.png'});
  await page.setViewportSize({width:1600,height:1365});
  todayError=false;todayCalls='1280';
  await refreshToday.focus();await page.keyboard.press('Space');await waitText('today-calls','1.280');
  assert.doesNotMatch(await page.locator('#today-updated').textContent(),/falha ao atualizar/);
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.equal(await page.locator('#event-output .event-new').count(),0,'initial history must not animate');
  await page.evaluate(()=>{window.__firstTerminalRow=document.querySelector('#event-output .event-line');});
  await page.locator('#event-search').dispatchEvent('input');
  assert(await page.evaluate(()=>window.__firstTerminalRow===document.querySelector('#event-output .event-line')),'unchanged rows retain DOM identity');
  await page.locator('#metrics').evaluate(e=>Promise.all(e.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{}))));
  const geometry=await page.evaluate(()=>{
    const rect=id=>{const {x,y,width,height}=document.getElementById(id).getBoundingClientRect();return {x,y,width,height};};
    return {viewport:{width:innerWidth,height:innerHeight},sidebar:rect('sidebar'),cards:[rect('today-card'),rect('countdown-card')],terminal:rect('terminal'),chart:rect('chart-panel'),canvas:getComputedStyle(document.documentElement).backgroundColor,terminalSurface:getComputedStyle(document.getElementById('terminal')).backgroundColor,cardRadius:getComputedStyle(document.getElementById('today-card')).borderRadius};
  });
  assert.equal(geometry.sidebar.width,320);assert.equal(geometry.cards[0].width,geometry.cards[1].width);assert(Math.abs(geometry.cards[0].y-geometry.cards[1].y)<.1);assert(Math.abs(geometry.cards[0].height-geometry.cards[1].height)<.1);
  assert.equal(geometry.canvas,'rgb(238, 253, 244)');assert.equal(geometry.terminalSurface,'rgb(13, 30, 23)');assert.equal(geometry.cardRadius,'14px');

  assert.equal(await page.locator('#event-output details').count(),0,'basic details require no click');
  assert.match(await page.locator('#event-output .event-line').last().textContent(),/ERROR \| scheduler_error \| received=239 inserted=5 duplicates=2 request_ms=42 skipped=1 next_run_at=04\/11\/2026, 12:02:00 Brasília error=RECOVERY_REQUIRED/);
  assert.doesNotMatch(await page.locator('#event-output').textContent(),/PRIVATE/);
  // A slow status call cannot block the real two-second terminal poll.
  statusDelay=4600;const realPollStart=eventTimes.length;
  await page.evaluate(()=>{void window.__statusPoll();});await page.waitForTimeout(4200);
  const timed=eventTimes.slice(realPollStart);assert(timed.length>=3);for(let i=2;i<timed.length;i++)assert(timed[i]-timed[i-1]>=1700&&timed[i]-timed[i-1]<=2400,'single two-second polling cycle');
  statusDelay=0;await page.waitForTimeout(550);
  // Slow event responses are coalesced, including manual invocations.
  eventDelay=300;await page.evaluate(()=>{for(let i=0;i<8;i++)void window.__statusPoll();});await page.waitForTimeout(400);eventDelay=0;assert.equal(maxEventsActive,1);
  const dailyRequests=requests.filter(r=>['/api/today','/api/reports'].includes(r.path)).length;
  await page.evaluate(()=>{for(let i=0;i<100;i++)window.__clockTick();});
  assert.equal(requests.filter(r=>['/api/today','/api/reports'].includes(r.path)).length,dailyRequests,'visual ticks do not fetch');
  await mkdir(evidenceDir,{recursive:true});await writeFile(evidenceDir+'/geometry.json',JSON.stringify(geometry,null,2));
  await screenshot('admin/evidence/premium-desktop.png');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot('admin/evidence/premium-mobile.png');
  await page.setViewportSize({width:900,height:1024});
  assert.equal(await page.locator('#sidebar').evaluate(e=>e.getBoundingClientRect().width),64);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(await page.getByRole('button',{name:'Sair',exact:true}).isVisible());
  await screenshot('admin/evidence/forest-tablet.png');
  await page.setViewportSize({width:1440,height:1100});
  // Keyboard accordion, cached reopening, and independent SVG failure.
  await page.locator('#chart-toggle').focus();await page.keyboard.press('Enter');
  await page.locator('#calls-chart svg').waitFor();assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'true');
  await screenshot('admin/evidence/premium-expanded.png');
  assert.equal(await page.locator('[data-chart-days]').count(),4);
  assert.equal(await page.locator('[data-chart-days="7"]').getAttribute('aria-pressed'),'true');
  const expected=days=>{const data=daily.slice(-days);return {total:data.reduce((n,r)=>n+BigInt(r.calls),0n).toLocaleString('pt-BR'),identified:data.reduce((n,r)=>n+BigInt(r.identified_calls),0n).toLocaleString('pt-BR')};};
  reportHold=new Promise(resolve=>{releaseReport=resolve;});
  const delayedResponse=page.waitForResponse(response=>response.url().includes('/api/reports?')&&response.url().includes(daily.at(-14).day));
  await page.evaluate(()=>{window.__chartValues=[];new MutationObserver(()=>window.__chartValues.push(document.getElementById('chart-total').textContent)).observe(document.getElementById('chart-total'),{childList:true});});
  await page.locator('[data-chart-days="14"]').click();await page.locator('[data-chart-days="30"]').click();
  await waitText('chart-total',expected(30).total);releaseReport();reportHold=null;await (await delayedResponse).finished();
  assert(!(await page.evaluate(()=>window.__chartValues)).includes(expected(14).total),'late response cannot replace selected dataset');
  for(const days of [7,14,30,1,7]){
    await page.locator(`[data-chart-days="${days}"]`).click();
    await waitText('chart-total',expected(days).total);
    assert.equal(await page.locator('#chart-identified').textContent(),expected(days).identified);
    assert.equal(await page.locator('#calls-chart [data-day-index]').count(),days);
    assert.equal(await page.locator('#calls-chart .chart-bar').count(),days*2);
    assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'true');
    if(days!==1){await screenshot(`admin/evidence/analytic-${days}d.png`);await page.locator('#chart-panel').screenshot({path:`${evidenceDir}/panel-${days}d.png`});}
  }
  await waitText('chart-total','10.640');await waitText('chart-average','1.520');await waitText('chart-percent','40,0%');
  assert.match(await page.locator('#chart-denominator').textContent(),/7 dias corridos · hoje parcial/);
  assert.equal(await page.locator('#chart-peak').textContent(),'1.580');
  assert.equal(await page.locator('#calls-chart .peak-label').count(),1);
  const chartRequests=()=>requests.filter(r=>r.path==='/api/reports').length;
  const beforeTooltip=chartRequests();
  const dayGroup=page.locator('#calls-chart [data-day-index]').last();
  await dayGroup.focus();await page.locator('#chart-tooltip').waitFor({state:'visible'});
  assert.match(await page.locator('#chart-tooltip').textContent(),/Hoje · em andamento.*Coletadas:1\.580.*Identificadas:632 \(40,0%\).*Snapshot:/);
  await screenshot('admin/evidence/analytic-tooltip.png');
  await page.keyboard.press('Escape');assert(await page.locator('#chart-tooltip').isHidden());
  await dayGroup.hover();await page.locator('#chart-tooltip').waitFor({state:'visible'});
  assert.equal(chartRequests(),beforeTooltip,'tooltip never requests a snapshot');
  const positions=await dayGroup.evaluate(g=>{const a=g.querySelector('.calls-bar').getBBox(),b=g.querySelector('.operators-bar').getBBox();return {aRight:a.x+a.width,bLeft:b.x,aBottom:a.y+a.height,bBottom:b.y+b.height};});
  assert(positions.bLeft>positions.aRight);assert(Math.abs(positions.aBottom-positions.bBottom)<.1);
  await page.evaluate(()=>{window.__analyticSvg=document.querySelector('#calls-chart svg');});
  await page.evaluate(()=>window.__reportPoll());
  assert(await page.evaluate(()=>window.__analyticSvg===document.querySelector('#calls-chart svg')),'cached polling does not replace SVG or animate bars');
  assert.equal(chartRequests(),beforeTooltip);
  await page.locator('#chart-report-link').click();await waitText('report-page','7 dias');
  assert.equal(await page.locator('#report-from').inputValue(),daily.at(-7).day);
  await nav('Dashboard');
  await page.setViewportSize({width:900,height:1024});await screenshot('admin/evidence/analytic-tablet.png');
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#calls-chart [data-day-index]').first().tap();await page.locator('#chart-tooltip').waitFor({state:'visible'});
  const tooltipBounds=await page.locator('#chart-tooltip').boundingBox();assert(tooltipBounds.x>=0&&tooltipBounds.x+tooltipBounds.width<=390);
  await screenshot('admin/evidence/analytic-mobile.png');
  await page.setViewportSize({width:1440,height:500});
  assert.equal(await page.locator('#sidebar').evaluate(e=>getComputedStyle(e).scrollbarWidth),'none');
  assert.equal(await page.locator('#event-output').evaluate(e=>getComputedStyle(e).scrollbarWidth),'none');
  assert.equal(await page.locator('nav button').first().evaluate(e=>getComputedStyle(e).fontWeight),'600');
  await page.locator('#sidebar').hover();await page.mouse.wheel(0,800);await page.waitForFunction(()=>document.getElementById('sidebar').scrollTop>0);
  await page.getByRole('button',{name:'Sair',exact:true}).focus();
  assert(await page.locator('#sidebar').evaluate(e=>e.scrollTop>0&&getComputedStyle(e).overflowY==='auto'));
  await screenshot('admin/evidence/sidebar-scrolled.png');
  await page.setViewportSize({width:1440,height:1100});
  await page.locator('#sidebar').evaluate(e=>{e.scrollTop=0;});
  await page.locator('#event-output').evaluate(e=>{e.scrollTop=0;});
  await page.locator('#event-output').hover();await page.mouse.wheel(0,200);await page.waitForFunction(()=>document.getElementById('event-output').scrollTop>0);
  await page.locator('#event-output').evaluate(e=>{e.scrollTop=0;});await page.locator('#event-output').focus();await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.getElementById('event-output').scrollTop>0);
  // Reports keep their own default 30-day filter after the chart-link check.
  await page.evaluate(([from,to])=>{document.getElementById('report-from').value=from;document.getElementById('report-to').value=to;},[range.from,range.to]);

  const historyRequests=requests.filter(r=>r.path==='/api/reports').length;
  await page.locator('#chart-toggle').focus();await page.keyboard.press('Space');assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'false');
  await page.keyboard.press('Enter');await page.waitForTimeout(250);assert.equal(requests.filter(r=>r.path==='/api/reports').length,historyRequests);
  await page.evaluate(()=>{document.getElementById('calls-chart').style.width='95%';const original=document.createElementNS.bind(document);document.createElementNS=()=>{throw new Error('synthetic SVG failure');};window.dispatchEvent(new Event('resize'));document.createElementNS=original;});
  await waitText('calls-chart','indicadores permanecem válidos');assert.equal(await page.locator('#today-calls').textContent(),'1.280');
  await page.evaluate(()=>{document.getElementById('calls-chart').style.width='';window.dispatchEvent(new Event('resize'));});assert.equal(await page.locator('#calls-chart svg').count(),1);
  todayError=true;await page.evaluate(()=>window.__reportPoll());await waitText('today-updated','Desatualizado');
  assert.equal(await page.locator('#today-calls').textContent(),'1.280');assert.equal(await page.locator('#calls-chart svg').count(),1);
  todayError=false;todayCalls='1291';await page.evaluate(()=>window.__reportPoll());await waitText('today-calls','1.291');
  // Status failures cannot hide daily values or stop the independent terminal feed.
  statusError=true;const polls=eventPolls;await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Sem conexão');assert.equal(await page.locator('#platform-state').textContent(),'Indisponível');assert.equal(await page.locator('#node-state').textContent(),'Indisponível');
  await page.waitForFunction(()=>document.getElementById('today-calls').textContent==='1.291');await page.waitForTimeout(100);assert(eventPolls>polls);
  statusError=false;await page.evaluate(()=>window.__statusPoll());
  for(const [mode,label]of [['PAUSED','Pausado'],['STOPPED','Parado'],['ERROR','Erro operacional'],['PAUSING','Pausando'],['STOPPING','Finalizando']]){state=mode;await page.evaluate(()=>window.__statusPoll());await waitText('countdown',label);}
  state='RUNNING';nextAt=null;await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Sem agendamento');
  nextAt=new Date(serverNow()-1000).toISOString();await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Aguardando execução');
  activeCycle=true;await page.evaluate(()=>window.__statusPoll());await waitText('countdown','Em leitura');activeCycle=false;
  nextAt=new Date(serverNow()+102000).toISOString();await page.evaluate(()=>window.__statusPoll());await page.waitForFunction(()=>/^01:(4[01]|39|42)$/.test(document.getElementById('countdown').textContent));assert.match(await page.locator('#countdown').textContent(),/^01:(4[01]|39|42)$/);
  await page.locator('#terminal-filters > summary').click();
  assert.equal(await page.locator('#event-all').count(),0);assert.equal(await page.locator('#event-output .event-line').count(),200);
  await page.locator('#event-level').selectOption('WARN');assert.equal(await page.locator('#event-output .event-line').count(),1);await waitText('event-output','poll_retry');
  await page.locator('#event-level').selectOption('INFO');assert.equal(await page.locator('#event-output .event-line').count(),198);
  await page.locator('#event-search').fill('received=40');assert.equal(await page.locator('#event-output .event-line').count(),1);await page.locator('#event-search').fill('');
  await page.locator('#event-level').selectOption('ERROR');assert.doesNotMatch(await page.locator('#event-output').textContent(),/batch_completed/);assert.match(await page.locator('#event-output').textContent(),/12:00:00/);
  await page.locator('#event-search').fill('absent');await waitText('event-output','Nenhum evento');await page.locator('#event-search').fill('');
  await nav('Pausar visualização');const pausedPolls=eventPolls;const frozen=await page.locator('#event-output').textContent();await page.waitForTimeout(2200);assert.equal(await page.locator('#event-output').textContent(),frozen);assert.equal(eventPolls,pausedPolls);
  await nav('Copiar logs');await waitText('event-status','Logs sanitizados copiados');const copy=await page.evaluate(()=>Promise.race([navigator.clipboard.readText(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Clipboard read timeout')),3000))]));assert.match(copy,/scheduler_error/);assert.equal(copy,await page.locator('#event-output .event-line').first().textContent());assert.doesNotMatch(copy,/PRIVATE/);await nav('Retomar visualização');await page.locator('#event-level').selectOption('ALL');
  // Keep the same visible row when the retained buffer drops its first event.
  await page.locator('#event-output').evaluate(e=>{e.scrollTop=500;});
  const anchor=await page.locator('#event-output').evaluate(e=>{const top=e.getBoundingClientRect().top,row=[...e.children].find(r=>r.getBoundingClientRect().bottom>top);return {key:row.dataset.eventKey,offset:row.getBoundingClientRect().top-top};});
  eventOffset=1;await page.evaluate(()=>window.__statusPoll());await waitText('event-output','received=240');assert(await page.locator('#event-output .event-line').last().evaluate(e=>e.classList.contains('event-new')));
  const anchorAfter=await page.locator('#event-output').evaluate((e,key)=>{const row=[...e.children].find(r=>r.dataset.eventKey===key);return row.getBoundingClientRect().top-e.getBoundingClientRect().top;},anchor.key);
  assert(Math.abs(anchorAfter-anchor.offset)<1,'manual scroll survives buffer rotation even with Autoscroll checked');
  await page.locator('#event-output').evaluate(e=>{e.scrollTop=e.scrollHeight;});eventOffset=2;await page.evaluate(()=>window.__statusPoll());await waitText('event-output','received=241');
  assert(await page.locator('#event-output').evaluate(e=>Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop)<2));
  await screenshot('admin/evidence/terminal-scrolled.png');
  await page.locator('#event-autoscroll').uncheck();
  await page.locator('#event-output').evaluate(e=>{e.scrollTop=40;});
  await page.evaluate(()=>window.__statusPoll());await page.waitForTimeout(100);
  assert.equal(await page.locator('#event-output').evaluate(e=>e.scrollTop),40);
  await nav('Copiar logs');await waitText('event-status','Logs sanitizados copiados');
  const fullCopy=await page.evaluate(()=>navigator.clipboard.readText());assert.equal(fullCopy.split('\n').length,200);
  assert.equal(fullCopy,(await page.locator('#event-output .event-line').allTextContents()).join('\n'));assert.doesNotMatch(fullCopy,/PRIVATE/);
  eventError=true;await page.evaluate(()=>window.__statusPoll());await waitText('terminal-live','SEM ATUALIZAÇÃO');
  await page.locator('#event-search').fill('scheduler_error');await waitText('terminal-live','SEM ATUALIZAÇÃO');await waitText('event-status','desatualizada');
  eventError=false;await page.locator('#event-search').fill('');await page.locator('#event-autoscroll').check();await page.evaluate(()=>window.__statusPoll());await waitText('terminal-live','AO VIVO');
  await nav('Relatórios');await waitText('report-page','Página 1 de 5');await waitText('metric-calls','38.700');assert.equal(await page.locator('#historical-metrics > article').count(),3);assert.equal(await page.locator('#corporate-state').textContent(),'Pausado');assert.match(await page.locator('#integrity-details').textContent(),/Registros sem data de chamada4Mappings sem registro local2Recibos divergentes3/);await screenshot('admin/evidence/premium-reports.png');assert.equal(await page.locator('#report-rows tr').count(),6);
  assert.equal(await page.locator('[data-report-days]').count(),5);
  for(const days of [1,7,15,30]){
    await page.locator(`[data-report-days="${days}"]`).click();await waitText('report-window',`${days} dias corridos`);await waitText('metric-calls',expected(days).total);
    assert.equal(await page.locator('#metric-calls').textContent(),expected(days).total);
    assert.equal(await page.locator('#metric-identified').textContent(),expected(days).identified);
    assert.equal(await page.locator('#metric-operators').textContent(),'12','distinct operators are not a daily sum');
    assert.equal(await page.locator('#metric-confirmed').textContent(),BigInt(days*350).toLocaleString('pt-BR'));
    assert.equal(await page.locator('#report-chart .confirmed-bar').count(),days);
  }
  await screenshot('admin/evidence/enterprise-desktop.png');await page.locator('[data-view="reports"]').screenshot({path:evidenceDir+'/enterprise-panel.png'});
  reportHoldFrom=daily.at(-15).day;reportHold=new Promise(resolve=>{releaseReport=resolve;});
  const lateReport=page.waitForResponse(response=>response.url().includes('/api/reports?')&&response.url().includes(reportHoldFrom));
  await page.locator('[data-report-days="15"]').click();await page.locator('[data-report-days="7"]').click();await waitText('metric-calls',expected(7).total);
  releaseReport();reportHold=null;await (await lateReport).finished();reportHoldFrom=null;
  assert.equal(await page.locator('#metric-calls').textContent(),expected(7).total);
  assert.equal(await page.locator('[data-report-days="7"]').getAttribute('aria-pressed'),'true');
  await page.locator('#report-rows [data-report-action="view"]').first().click();await page.locator('#report-day-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#report-day-details').textContent(),/Coletadas1\.580.*Recibos confirmados350/);
  await page.getByRole('button',{name:'Fechar',exact:true}).click();
  const rowDownload=page.waitForEvent('download');await page.locator('#report-rows [data-report-action="export"]').first().click();const rowFile=await rowDownload;
  const rowCsv=await readFile(await rowFile.path(),'utf8');assert.equal(rowCsv.split('\r\n').length,2);assert.match(rowCsv,/1580/);assert.doesNotMatch(rowCsv,/PRIVATE/);
  await page.evaluate(()=>{window.__createCsv=URL.createObjectURL;URL.createObjectURL=()=>{throw new Error('synthetic export failure');};});
  await nav('Exportar CSV');await waitText('report-status','Não foi possível gerar o CSV');await page.evaluate(()=>{URL.createObjectURL=window.__createCsv;});
  const beforeReportHover=chartRequests();await page.locator('#report-chart [data-day-index]').last().focus();await page.locator('#report-chart-tooltip').waitFor({state:'visible'});
  assert.match(await page.locator('#report-chart-tooltip').textContent(),/Recibos confirmados:350/);assert.equal(chartRequests(),beforeReportHover);
  outboxAvailable=false;await nav('Atualizar');await waitText('metric-confirmed','Indisponível');
  assert.equal(await page.locator('#report-chart .confirmed-bar').count(),0);assert.equal(await page.locator('#report-chart .chart-bar').count(),14);
  assert.match(await page.locator('#report-observation-state').textContent(),/parcial/);outboxAvailable=true;
  await page.locator('[data-report-days="30"]').click();await waitText('metric-calls',expected(30).total);
  const beforeInvalid=chartRequests();await page.locator('#report-from').fill('2026-12-31');await nav('Atualizar');
  await waitText('report-status','menor ou igual');assert.equal(chartRequests(),beforeInvalid);assert(await page.locator('#export-report').isDisabled());
  await page.locator('[data-report-days="30"]').click();await waitText('metric-calls',expected(30).total);
  await page.setViewportSize({width:900,height:1024});await screenshot('admin/evidence/enterprise-tablet.png');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:390,height:844});await screenshot('admin/evidence/enterprise-mobile.png');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1100});

  await nav('Próxima');await waitText('report-page','Página 2');await nav('Próxima');assert.equal(await page.locator('#report-rows tr').count(),6);
  const download=page.waitForEvent('download');await nav('Exportar CSV');const file=await download;assert.match(file.suggestedFilename(),/^olos-chamadas-/);const csv=await readFile(await file.path(),'utf8');assert.equal(csv.split('\r\n').length,31);assert.doesNotMatch(csv,/PRIVATE/);assert.equal(writes.filter(w=>w.path!=='/api/today/refresh').length,1);
  await page.locator('#report-from').fill(range.to);await page.locator('#report-to').fill(range.to);await nav('Atualizar');await waitText('report-page','1 dias');assert.equal(await page.locator('#report-rows tr').count(),1);
  await page.locator('#report-from').fill(range.from);await nav('Atualizar');await waitText('report-page','Página 1 de 5');
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#chart-body').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await page.emulateMedia({reducedMotion:'no-preference'});
  await nav('Terminal / Logs');await waitText('log-rows','fixture-read');assert.equal(await page.locator('#logs-terminal #terminal').count(),1);
  await nav('Agendamento');await page.getByLabel('Intervalo em minutos').fill('3');await nav('Salvar intervalo');await waitText('notice','Intervalo salvo');assert.deepEqual(writes.at(-1),{method:'PATCH',path:'/api/schedule',input:{interval_ms:180000},csrf:'fixture-csrf'});
  await nav('Credenciais OLOS');await waitText('credentials-complete','completa');await nav('Salvar credenciais');await waitText('notice','Credenciais salvas');assert.equal(writes.at(-1).path,'/api/credentials');assert.deepEqual(writes.at(-1).input,{baseUrl:'https://fixture.invalid/WebApiExportData',username:'fixture',password:'',revision:1});await nav('Testar conexão salva');await waitText('test-result','Autenticação validada');
  state='STOPPED';await page.evaluate(()=>window.__statusPoll());await nav('Iniciar Worker');await waitText('state','Operando');await nav('Agendamento');await nav('Pausar agendamento');await waitText('state','Pausado');await nav('Retomar agendamento');await waitText('state','Operando');
  await nav('Parar Worker');await nav('Cancelar');assert.equal(state,'RUNNING');await nav('Parar Worker');await nav('Confirmar parada');await waitText('state','Parado');assert.deepEqual(writes.at(-1).input,{confirm:true});
  await nav('Status operacional');await waitText('audit-rows','fixture-admin');await nav('Auditoria');assert.equal(await page.locator('#audit-heading').evaluate(e=>e===document.activeElement),true);await nav('Dashboard');
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0.5);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#chart-toggle').click();await page.waitForTimeout(250);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await nav('Abrir navegação');await nav('Relatórios');await waitText('report-page','Página 1');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  reportError=true;await nav('Atualizar');await waitText('report-status','Relatório indisponível');assert(!(await page.locator('#export-report').isDisabled()));assert.equal(await page.locator('#report-rows tr').count(),6);assert.match(await page.locator('#report-observation-state').textContent(),/desatualizada/);
  reportError=false;empty=true;await nav('Atualizar');await waitText('report-page','Nenhuma chamada');assert(await page.locator('#export-report').isDisabled());empty=false;
  // A delayed report must not restore data after logout/session expiration.
  reportDelay=500;await nav('Atualizar');await nav('Abrir navegação');await nav('Sair');await page.locator('#login').waitFor({state:'visible'});await page.waitForTimeout(600);assert.equal(await page.locator('#report-rows tr').count(),0);assert(await page.locator('#terminal').isHidden());
  reportDelay=0;reportError=true;todayError=true;await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');
  await waitText('today-updated','indisponível');assert.equal(await page.locator('#today-calls').textContent(),'—');assert.equal(await page.locator('#chart-toggle').getAttribute('aria-expanded'),'false');await page.locator('#chart-toggle').click();await waitText('chart-status','Série indisponível');assert.equal(await page.locator('#chart-total').textContent(),'—');todayError=false;await page.evaluate(()=>window.__reportPoll());await waitText('today-calls','1.291');assert.match(await page.locator('#chart-status').textContent(),/Série indisponível/);
  await nav('Abrir navegação');await nav('Sair');await page.locator('#login').waitFor({state:'visible'});reportError=false;empty=true;todayError=false;setServerTime(Date.parse('2026-11-02T02:59:50Z'));todayCalls='25';
  await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');await page.locator('#chart-toggle').click();await waitText('calls-chart','Nenhuma chamada');
  // Calendar rollover is driven by the synchronized Brasília day, not the browser timezone.
  setServerTime(Date.parse('2026-11-02T02:59:50Z'));todayCalls='25';await page.evaluate(()=>window.__statusPoll());await page.evaluate(()=>window.__reportPoll());await waitText('today-calls','25');
  todayHold=new Promise(resolve=>{releaseToday=resolve;});todayCalls='2';setServerTime(Date.parse('2026-11-02T03:00:00Z'));
  await page.evaluate(()=>window.__statusPoll());await waitText('today-updated','Novo dia');assert.equal(await page.locator('#today-calls').textContent(),'—');
  releaseToday();todayHold=null;await waitText('today-calls','2');todayDelay=0;
  empty=false;await nav('Abrir navegação');await nav('Relatórios');await page.locator('[data-report-days="1"]').click();await waitText('report-window','02/11/2026 — 02/11/2026');
  setServerTime(Date.parse('2026-11-03T03:00:00Z'));await page.evaluate(()=>window.__statusPoll());await waitText('report-window','03/11/2026 — 03/11/2026');await waitText('metric-calls',BigInt(daily.find(row=>row.day==='2026-11-03').calls).toLocaleString('pt-BR'));
  await nav('Abrir navegação');await nav('Dashboard');
  // A delayed daily response cannot repopulate the next session or a logged-out view.
  todayDelay=500;await page.evaluate(()=>window.__reportPoll());await nav('Abrir navegação');await nav('Sair');await page.waitForTimeout(650);
  assert.equal(await page.locator('#today-calls').textContent(),'—');assert.equal(await page.locator('#countdown').textContent(),'—');
  todayDelay=0;await page.locator('#login-form input[name=username]').fill('fixture');await page.locator('#login-form input[name=password]').fill('fixture');await nav('Entrar');await waitText('today-calls','2');
  eventDelay=600;await page.evaluate(()=>window.__statusPoll());
  session=false;await page.evaluate(()=>window.__reportPoll());await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#today-calls').textContent(),'—');assert(await page.locator('#terminal').isHidden());
  await page.waitForTimeout(700);assert.equal(await page.locator('#event-output .event-line').count(),0,'late events cannot repopulate an expired session');
  assert.deepEqual(errors,[]);assert(writes.filter(w=>w.path!=='/api/login').every(w=>w.csrf==='fixture-csrf'));
  assert(!writes.some(w=>w.path==='/api/reports'));
  console.log('PASS browser: premium two cards, daily increment/error/midnight, real countdown states, no requests per tick, accordion keyboard/cache, independent feeds; desktop/mobile, graph, exact metric sources, full 200-event buffer/details/2-second polling/coalescing/filter/pause/copy/scroll anchoring, pagination/full CSV, all original actions/CSRF/stop dialog, errors/empty states, logout race; no real services.');
}finally{clearTimeout(watchdog);await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
