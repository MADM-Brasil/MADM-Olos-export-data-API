import {date,count,dayLabel,defaultRange,reportFields,reportCsv,safeEvents,eventLines,renderDashboardChart,renderDashboardMetrics,renderTerminal,chartRange,chartModel,chartCompact,chartPercent,reportWindow,reportQuickRange,reportModel} from './ui.js';
import {ServerClock,brasiliaDay,statusLabels,renderToday,renderCountdown} from './dashboard.js';
/** @returns {any} */
const $=id=>document.getElementById(id);
let csrf='',revision=0,logged=false,refreshing=false,currentPage='dashboard';
const titles={dashboard:'Dashboard',reports:'Relatórios de Integração & Telemetria',logs:'Terminal / Logs',schedule:'Agendamento',credentials:'Credenciais OLOS',status:'Status operacional'};
const errors={AUTHENTICATION_REQUIRED:'Sua sessão expirou. Entre novamente.',LOGIN_FAILED:'Não foi possível autenticar na OLOS. Confira usuário e senha ou tente novamente mais tarde.',ADMIN_ACCESS_FORBIDDEN:'Identidade OLOS autenticada, mas sem autorização administrativa.',SOURCE_ID_UNIQUENESS_UNCONFIRMED:'Consumo bloqueado: a unicidade da identidade de origem ainda não foi confirmada. O painel continua disponível.',SCHEDULER_ALREADY_ACTIVE:'Já existe um administrador/agendador para esta fonte e este banco. Não abra uma segunda instância.',DESTINATION_ID_GENERATOR_REQUIRED:'Estrutura de destino ausente ou incompatível: geração de ID não validada.',RECOVERY_REQUIRED:'Há leituras pendentes. É necessária reconciliação antes de iniciar.',CONSUMER_ALREADY_ACTIVE:'Já existe um consumidor para esta origem.',CREDENTIAL_REVISION_CONFLICT:'A configuração mudou. Recarregue antes de salvar.',OLOS_URL_NOT_ALLOWED:'A origem da URL não está autorizada no servidor.',LOGIN_RATE_LIMITED:'Muitas tentativas. Aguarde um minuto.'};
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
async function api(path,method='GET',body){
  const requestEpoch=sessionEpoch;
  const res=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await res.json();
  if(!res.ok){if(res.status===401&&path!=='/login'&&requestEpoch===sessionEpoch)showLogin();throw new Error(errors[result.error]||result.error||'Falha na operação.');}return result;
}
let sessionEpoch=0;
const clock=new ServerClock();
let schedulerSnapshot=null,statusAt=0,statusFailed=false,todaySnapshot=null,todayFailed=false,todayFlight=null;
let activeDay=brasiliaDay(clock.now()),chartOpen=false;
function resetOperational(){$('state').textContent='Carregando';$('state').dataset.state='UNKNOWN';$('state').classList.remove('error');$('corporate-state').textContent='—';$('corporate-detail').textContent='Aguardando estado do controle local.';$('corporate-observed').textContent='Controle não observado.';schedulerSnapshot=null;statusAt=0;statusFailed=false;todaySnapshot=null;todayFailed=false;todayFlight=null;clock.anchor=null;activeDay=brasiliaDay(clock.now());renderToday($,null,clock.now());renderClock();}
function renderClock(){
  const stale=statusFailed||!!schedulerSnapshot&&performance.now()-statusAt>10000;
  renderCountdown($,schedulerSnapshot,clock.now(),stale);
  if(stale){$('state').textContent='Indisponível';$('state').dataset.state='UNKNOWN';$('state').classList.add('error');}
  for(const id of ['platform-state','node-state']){
    $(id).textContent=stale?'Indisponível':schedulerSnapshot?(statusLabels[schedulerSnapshot.state]||'Indisponível')+(id==='platform-state'?' · '+schedulerSnapshot.state:''):'Consultando';
    $(id).dataset.state=stale?'UNKNOWN':schedulerSnapshot?.state||'UNKNOWN';
    $(id).classList.toggle('error',stale||schedulerSnapshot?.state==='ERROR');
  }
  $('header-date').textContent=date(new Date(clock.now()).toISOString()).split(',')[0]+' · Brasília';
}
function tick(){
  if(!logged)return;
  renderClock();if(currentPage==='reports')reportObservation();renderToday($,todaySnapshot,clock.now(),todayFailed);
  const day=brasiliaDay(clock.now());
  if(activeDay!==day){activeDay=day;void refreshToday();if(currentPage==='reports'&&reportPreset!=='custom')setReportPreset(reportPreset);}
}
async function refreshToday(){
  if(!logged||todayFlight)return;
  const flight={epoch:sessionEpoch,day:brasiliaDay(clock.now())};todayFlight=flight;
  try{const r=await api('/today');if(!logged||flight.epoch!==sessionEpoch)return;
    if(typeof r?.calls!=='string'||!/^\d+$/.test(r.calls)||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.observed_at)))throw new Error('TODAY_INVALID');
    clock.sync(r.server_time);todaySnapshot=r;todayFailed=false;
  }catch{if(logged&&flight.epoch===sessionEpoch)todayFailed=true;}
  finally{if(todayFlight===flight)todayFlight=null;}
  if(!logged||flight.epoch!==sessionEpoch)return;
  renderToday($,todaySnapshot,clock.now(),todayFailed);
  if(flight.day!==brasiliaDay(clock.now())&&todaySnapshot?.date!==brasiliaDay(clock.now()))void refreshToday();
}

function showLogin(){sessionEpoch++;resetOperational();resetReports();eventEntries=[];eventPaused=false;eventsFailed=false;eventsUpdatedAt=null;renderEvents();logged=false;csrf='';$('app').hidden=true;$('login').hidden=false;$('credentials-form').reset();$('terminal').hidden=true;document.body.classList.remove('menu-open');syncMenu();}
function describe(id,details){$(id).replaceChildren();for(const [name,value]of details){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value??'Não medido';$(id).append(dt,dd);}}
function table(id,rows){const root=$(id);root.replaceChildren();for(const values of rows){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value??'—';tr.append(td);}root.append(tr);}}
let scheduleDirty=false;
$('minutes').addEventListener('input',()=>{scheduleDirty=true;});
async function refresh(){
  // The existing 2 s cycle also polls events when a status request is still pending.
  if(logged&&['dashboard','logs'].includes(currentPage))void refreshEvents();
  if(!logged||refreshing)return;refreshing=true;
  const epoch=sessionEpoch;
  try{
    const s=await api('/status');if(!logged||epoch!==sessionEpoch)return;clock.sync(s.server_time);schedulerSnapshot=s;statusAt=performance.now();if(statusFailed&&$('notice').textContent==='Não foi possível atualizar o estado operacional.')notice('');statusFailed=false;tick();$('state').textContent=statusLabels[s.state]||'Indisponível';$('state').dataset.state=s.state;$('state').classList.toggle('error',s.state==='ERROR');
    $('next').textContent=date(s.next_run_at);$('interval').textContent=s.interval_ms?`${s.interval_ms/60000} min`:'—';$('in-flight').textContent=s.cycle_in_progress?'Leitura / persistência em andamento':'Sem ciclo em andamento';
    const c=s.corporate_delivery;
    $('corporate-state').textContent=!c?'Indisponível':c.blocked?'Bloqueado':!c.ready?'Não preparado':c.paused?'Pausado':'Liberado no controle';
    $('corporate-observed').textContent=`Observado ${date(s.server_time)} · Brasília`;
    $('corporate-detail').textContent=c?(c.last_code||'Controle local; conexão e escrita não aferidas.'):'Nenhum controle corporativo disponível.';
    const last=s.ingestion?.last_completed,latest=s.ingestion?.latest;
    $('auth-health').textContent=s.authentication?.status==='ACCEPTED'?'Aceita nesta sessão':'Não verificada';
    $('db-health').textContent=s.database?.reachable?(s.database.schema_valid?'Estrutura validada':'Acessível, estrutura inválida'):'Indisponível';
    $('db-detail').textContent=s.database?.error?(errors[s.database.error]||s.database.error):'Verificação somente leitura, sem iniciar consumidor.';
    $('ingestion-health').textContent=({CONFIRMED:'Persistência confirmada',PENDING:'Leituras pendentes',NOT_OBSERVED:'Sem ciclo confirmado',UNKNOWN:'Não verificável'})[s.ingestion?.status]||'Não verificável';
    $('pending-summary').textContent=s.ingestion?.pending===null?'Não foi possível consultar pendências.':(s.ingestion?.pending?.map(p=>`${p.state}: ${p.count}`).join(' · ')||'Nenhuma leitura pendente.');
    describe('cycle-details',[['Estado real / desejado',`${s.state} / ${s.desired_state}`],['Última execução',date(latest?.started_at)],['Estado da última leitura',latest?.state||'Nenhuma'],['Último ciclo confirmado',date(last?.finished_at)],['Recebidos no último ciclo',last?.received_count],['Inseridos no PostgreSQL',last?.inserted],['Duplicidades',last?.duplicates],['Tempo de processamento',last?.duration_ms==null?'Não medido':`${last.duration_ms} ms`]]);
    const lastError=s.error||s.ingestion?.last_error?.code||latest?.error_code;$('worker-error').textContent=lastError?`Último erro: ${errors[lastError]||lastError}`:'Nenhum erro registrado.';$('worker-error').classList.toggle('error',!!lastError);
    if(!scheduleDirty)$('minutes').value=s.interval_ms?s.interval_ms/60000:'';
    $('schedule-by').textContent=s.updated_by?`Última alteração: ${s.updated_by} · ${date(s.updated_at)}`:'';
    $('start').disabled=!['STOPPED','ERROR'].includes(s.state);$('stop').disabled=['STOPPED','STOPPING'].includes(s.state);
    $('pause').disabled=s.state!=='RUNNING';$('resume').disabled=s.state!=='PAUSED';
    const details=[['Estado real',s.state],['Estado solicitado',s.desired_state],['Ciclo ativo',s.cycle_in_progress?'Sim':'Não'],['Próxima execução',date(s.next_run_at)],['Último erro',errors[s.error]||s.error||'Nenhum']];
    describe('operational',details);
    if(currentPage==='logs')await logs();

    if(currentPage==='status'){const rows=await api('/audit');if(!logged||epoch!==sessionEpoch)return;table('audit-rows',rows.map(r=>[date(r.occurred_at),r.actor,r.action]));}
  }catch(e){if(logged&&epoch===sessionEpoch){statusFailed=true;renderClock();notice('Não foi possível atualizar o estado operacional.',true);$('state').textContent='Indisponível';$('state').classList.add('error');$('corporate-state').textContent='Indisponível';$('corporate-observed').textContent='Controle local desatualizado ou indisponível.';}}finally{refreshing=false;}
}
async function credentials(){const epoch=sessionEpoch,c=await api('/credentials');if(!logged||epoch!==sessionEpoch)return;revision=c.revision;const f=$('credentials-form');for(const key of ['baseUrl','username'])f.elements.namedItem(key).value=c[key];f.elements.namedItem('password').value='';$('credentials-complete').textContent=`Configuração ${c.complete?'completa':'incompleta'} · ${c.origin==='environment'?'origem: variáveis de ambiente':'origem: banco criptografado'}. Campos secretos vazios preservam os valores atuais.`;$('password-configured').textContent=c.passwordConfigured?'Senha configurada no backend.':'Senha ainda não configurada.';testResult(c.lastTest);}
function testResult(r){$('test-result').textContent=r?`${r.ok?'Autenticação validada':'Falha no teste'} · ${r.code} · ${r.duration_ms} ms · ${date(r.at)}`:'Nenhum teste registrado para esta configuração.';}
async function logs(){const epoch=sessionEpoch;const rows=await api('/logs');if(!logged||epoch!==sessionEpoch)return;table('log-rows',rows.map(r=>[r.id,date(r.started_at),r.state,r.processed_count,r.received_count,r.request_ms,r.error_code]));}
async function enter(session){sessionEpoch++;csrf=session.csrf;logged=true;$('actor').textContent=session.actor;$('login').hidden=true;$('app').hidden=false;selectPage('dashboard');void refreshToday();void refreshEvents();await refresh();}
async function action(fn,button){if(button)button.disabled=true;try{await fn();}catch(e){notice(e.message,true);}finally{if(button)button.disabled=false;}}
$('login-form').addEventListener('submit',async (/** @type {any} */ e)=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;try{const input=Object.fromEntries(new FormData(f));f.elements.namedItem('password').value='';await enter(await api('/login','POST',input));f.reset();$('login-error').textContent='';}catch(err){$('login-error').textContent=err.message;f.elements.namedItem('password').value='';}finally{b.disabled=false;}});
function selectPage(page){currentPage=page;document.querySelectorAll('[data-view]').forEach((/** @type {HTMLElement} */ s)=>s.hidden=s.dataset.view!==currentPage);document.querySelectorAll('[data-page]').forEach((/** @type {HTMLElement} */ b)=>b.classList.toggle('selected',b.dataset.page===currentPage&&!b.dataset.anchor));$('title').textContent=titles[currentPage];$('breadcrumb').textContent=currentPage==='credentials'?'CONFIGURAÇÕES':currentPage==='reports'?'OPERAÇÃO / RELATÓRIOS':'OPERAÇÃO';notice('');$('report-observation').hidden=currentPage!=='reports';$('state').hidden=currentPage==='reports';document.querySelector('.subtitle').textContent=currentPage==='reports'?'Análise histórica, integridade estrutural e desempenho de despacho da esteira OLOS ExportDataV3.':'Visibilidade da operação. Integridade em cada etapa.';document.body.classList.remove('menu-open');syncMenu();mountTerminal();}
document.querySelectorAll('[data-page]').forEach((/** @type {HTMLButtonElement} */ button)=>button.addEventListener('click',()=>action(async()=>{selectPage(button.dataset.page);if(button.dataset.anchor){document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('selected',b===button));$(button.dataset.anchor).scrollIntoView({block:'start'});$(button.dataset.anchor).focus({preventScroll:true});}if(currentPage==='dashboard'){tick();void refreshToday();if(chartOpen)void dashboardReport();}if(currentPage==='reports'){if(reportPreset!=='custom')setReportPreset(reportPreset,false);await loadReport();}if(currentPage==='credentials')await credentials();if(currentPage==='logs'){void refreshEvents();await logs();}await refresh();})));
$('schedule-form').addEventListener('submit',(/** @type {any} */ e)=>{e.preventDefault();action(async()=>{
  const minutes=Number($('minutes').value);
  const result=await api('/schedule','PATCH',{interval_ms:minutes*60000});
  if(result.interval_ms!==minutes*60000)throw new Error('Intervalo retornado diferente do solicitado.');
  scheduleDirty=false;
  notice('Intervalo salvo e confirmado pelo backend.');
  await refresh();
},e.currentTarget.querySelector('button'));});
$('credentials-form').addEventListener('submit',(/** @type {any} */ e)=>{e.preventDefault();const f=e.currentTarget;action(async()=>{await api('/credentials','PUT',{...Object.fromEntries(new FormData(f)),revision});f.elements.namedItem('password').value='';await credentials();notice('Credenciais salvas. A operação atual não será interrompida.');},f.querySelector('button'));});
$('test-connection').addEventListener('click',(/** @type {any} */ e)=>action(async()=>testResult(await api('/credentials/test','POST',{})),e.currentTarget));
for(const name of ['start','pause','resume'])$(name).addEventListener('click',(/** @type {any} */ e)=>action(async()=>{await api('/worker/'+name,'POST',{});notice('Solicitação registrada. Acompanhe o estado real no painel.');await refresh();},e.currentTarget));
$('stop').addEventListener('click',()=>$('stop-dialog').showModal());$('cancel-stop').addEventListener('click',()=>$('stop-dialog').close());
$('confirm-stop').addEventListener('click',(/** @type {any} */ e)=>action(async()=>{await api('/worker/stop','POST',{confirm:true});$('stop-dialog').close();notice('Parada solicitada. Aguardando a conclusão efetiva do consumidor.');await refresh();},e.currentTarget));
$('refresh-logs').addEventListener('click',(/** @type {any} */ e)=>action(async()=>{await logs();await refreshEvents();},e.currentTarget));$('logout').addEventListener('click',(/** @type {any} */ e)=>action(async()=>{await api('/logout','POST',{});showLogin();},e.currentTarget));

let eventEntries=[],eventPaused=false,eventsBusy=false,eventsFailed=false,eventsUpdatedAt=null,reportData=null,reportPage=0,reportBusy=false,chartSnapshot=null;
const pageSize=6;
function mountTerminal(){const visible=['dashboard','logs'].includes(currentPage);$('terminal').hidden=!visible;if(visible)$(currentPage==='dashboard'?'dashboard-terminal':'logs-terminal').append($('terminal'));}
function renderEvents(){
  const shown=renderTerminal($('event-output'),eventEntries,$('event-search').value,$('event-level').value,$('event-autoscroll').checked);
  $('event-status').textContent=`${shown.visible} de ${shown.total} eventos do buffer disponível${eventsUpdatedAt?' · atualizado '+date(eventsUpdatedAt)+' · Brasília':''}${eventsFailed?' · visualização desatualizada':''}`;
  $('event-pause-label').textContent=eventPaused?'Retomar visualização':'Pausar visualização';
  $('event-pause').setAttribute('aria-pressed',String(eventPaused));
  $('terminal-live').dataset.live=String(!eventPaused&&!eventsFailed&&!!eventsUpdatedAt);
  $('terminal-live').textContent=eventPaused?'VISUALIZAÇÃO PAUSADA':eventsFailed?'SEM ATUALIZAÇÃO':eventsUpdatedAt?'AO VIVO · 2 s':'CONECTANDO';
}
async function refreshEvents(){
  if(!logged||eventPaused||eventsBusy)return;eventsBusy=true;const epoch=sessionEpoch;
  try{const events=await api('/events');if(!logged||epoch!==sessionEpoch||eventPaused)return;eventEntries=safeEvents(events);eventsFailed=false;eventsUpdatedAt=new Date();renderEvents();}
  catch{if(logged&&epoch===sessionEpoch){eventsFailed=true;$('terminal-live').dataset.live='false';$('terminal-live').textContent='SEM ATUALIZAÇÃO';$('event-status').textContent='Eventos indisponíveis. A visualização anterior pode estar desatualizada.';}}
  finally{eventsBusy=false;}
}
$('event-search').addEventListener('input',renderEvents);$('event-level').addEventListener('change',renderEvents);
$('event-autoscroll').addEventListener('change',()=>{if($('event-autoscroll').checked)$('event-output').scrollTop=$('event-output').scrollHeight;});
$('event-pause').addEventListener('click',()=>{eventPaused=!eventPaused;renderEvents();if(!eventPaused)void refreshEvents();});
$('event-copy').addEventListener('click',()=>action(async()=>{await navigator.clipboard.writeText(eventLines(eventEntries,$('event-search').value,$('event-level').value).join('\n'));$('event-status').textContent='Logs sanitizados copiados.';},$('event-copy')));
function syncMenu(){const open=document.body.classList.contains('menu-open');$('menu-toggle').setAttribute('aria-expanded',String(open));$('sidebar').inert=matchMedia('(max-width:760px)').matches&&!open;}
$('menu-toggle').addEventListener('click',()=>{document.body.classList.toggle('menu-open');syncMenu();});
window.addEventListener('resize',()=>{syncMenu();if(chartSnapshot&&chartOpen&&currentPage==='dashboard')paintChart();if(currentPage==='reports'&&reportData&&reportPaintWidth!==$('report-chart').clientWidth)paintReportChart();});syncMenu();
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('menu-open');syncMenu();}});
const initialRange=defaultRange();$('report-from').value=initialRange.from;$('report-to').value=initialRange.to;
function reportUrl(from,to){return '/reports?'+new URLSearchParams({from,to});}
let chartDays=7;
const chartCache=new Map(),chartFlights=new Map(),chartModels=new WeakMap();
const selectedChartRange=()=>chartRange(chartDays,new Date(clock.now()));
const chartKey=range=>`${range.from}/${range.to}`;
function rememberChart(snapshot){
  const model=chartModel(snapshot.daily,snapshot.from,snapshot.to);
  chartModels.set(snapshot,model);
  const age=Number.isFinite(Date.parse(snapshot.observed_at))?Math.max(0,clock.now()-Date.parse(snapshot.observed_at)):0;
  chartCache.set(chartKey(snapshot),{snapshot,at:performance.now()-age});
  if(chartCache.size>8)chartCache.delete(chartCache.keys().next().value);
}
function clearChart(){
  for(const name of ['total','identified','average','peak'])$('chart-'+name).textContent='—';
  for(const name of ['percent','denominator','peak-date'])$('chart-'+name).textContent='Indisponível';
  $('chart-scale').textContent='';$('chart-summary').textContent='';
  $('calls-chart').textContent='Série diária indisponível.';
}
function clearMetrics(){chartSnapshot=null;chartCache.clear();$('metrics-error').textContent='';$('chart-period').textContent='';for(const id of ['calls','identified','confirmed','pending','errors'])$('metric-'+id).textContent='—';$('metrics-observed').textContent='Indicadores indisponíveis';clearChart();}
function resetReports(){$('report-window').textContent='Janela ainda não observada';reportIntegrityAt=null;reportRevision++;reportPreset='30';reportFailed=false;reportBusy=false;syncReportPresets();$('report-day-dialog').close();$('report-form').setAttribute('aria-busy','false');chartDays=7;chartFlights.clear();chartOpen=false;$('chart-toggle').setAttribute('aria-expanded','false');$('chart-panel').classList.remove('is-open');$('chart-body').inert=true;$('chart-body').setAttribute('aria-hidden','true');$('chart-status').textContent='';$('integrity-details').replaceChildren();reportData=null;reportPage=0;table('report-rows',[]);$('report-summary').replaceChildren();$('report-page').textContent='Sem dados';$('report-prev').disabled=true;$('report-next').disabled=true;$('report-status').textContent='Selecione um período.';$('export-report').disabled=true;clearMetrics();clearReportPeriod();for(const id of ['report-undated','report-missing','report-divergent'])$(id).textContent='—';reportObservation();syncChartFilters();}
function syncChartFilters(){
  document.querySelectorAll('[data-chart-days]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.getAttribute('data-chart-days'))===chartDays)));
  $('chart-range-badge').textContent=chartDays===1?'Hoje':`Histórico ${chartDays}D`;
}
function paintChart(){
  if(!chartSnapshot||!chartOpen)return;
  const model=chartModels.get(chartSnapshot)||chartModel(chartSnapshot.daily,chartSnapshot.from,chartSnapshot.to),today=brasiliaDay(clock.now());
  chartModels.set(chartSnapshot,model);
  $('chart-total').textContent=count(model.total);$('chart-identified').textContent=count(model.identified);
  $('chart-average').textContent=model.average;$('chart-peak').textContent=model.peak?count(model.peak.calls):'—';
  $('chart-percent').textContent=model.total?`${model.percent} das chamadas do período`:'Sem chamadas no período';
  $('chart-denominator').textContent=`${model.denominator} ${model.denominator===1n?'dia':'dias'} corridos${chartSnapshot.to===today?' · hoje parcial':''}`;
  $('chart-peak-date').textContent=model.peak?`${dayLabel(model.peak.day)} · primeiro dia em caso de empate`:'Sem pico no período';
  $('chart-scale').textContent=model.empty?'Sem volume no período':`Escala: 0 — ${chartCompact(model.scale)} chamadas/dia`;
  $('chart-summary').textContent=`Total ${chartDays}D: ${count(model.total)}`;
  renderDashboardChart($('calls-chart'),chartSnapshot,undefined,{model,today});
  $('chart-period').textContent=`${dayLabel(chartSnapshot.from)} — ${dayLabel(chartSnapshot.to)} · Brasília`;
}
async function dashboardReport(){
  if(!logged||!chartOpen)return;
  const range=selectedChartRange(),key=chartKey(range),cached=chartCache.get(key);
  syncChartFilters();
  if(cached&&performance.now()-cached.at<(cached.snapshot.cache_seconds??300)*1000){chartSnapshot=cached.snapshot;$('chart-status').textContent=`Snapshot ${date(chartSnapshot.observed_at)}`;paintChart();return;}
  if(chartFlights.has(key))return chartFlights.get(key);
  if(!chartSnapshot||chartKey(chartSnapshot)!==key){chartSnapshot=null;clearChart();}
  $('chart-status').textContent='Consultando série…';
  const epoch=sessionEpoch;
  const flight=(async()=>{
    try{
      const snapshot=await api(reportUrl(range.from,range.to));if(!logged||epoch!==sessionEpoch)return;
      if(snapshot.from!==range.from||snapshot.to!==range.to)throw new Error('CHART_RANGE_MISMATCH');
      rememberChart(snapshot);
      if(key!==chartKey(selectedChartRange())||!chartOpen)return;
      chartSnapshot=snapshot;$('chart-status').textContent=`Snapshot ${date(snapshot.observed_at)}`;paintChart();
    }catch{
      if(logged&&epoch===sessionEpoch&&key===chartKey(selectedChartRange())){
        $('chart-status').textContent=chartSnapshot?'Série desatualizada · última observação preservada.':'Série indisponível. Tente novamente ao expandir.';
        if(!chartSnapshot)clearChart();
      }
    }finally{if(chartFlights.get(key)===flight)chartFlights.delete(key);}
  })();
  chartFlights.set(key,flight);return flight;
}
document.querySelectorAll('[data-chart-days]').forEach(button=>button.addEventListener('click',()=>{
  const days=Number(button.getAttribute('data-chart-days'));if(days===chartDays)return;
  chartDays=days;syncChartFilters();void dashboardReport();
}));
$('chart-toggle').addEventListener('click',()=>{
  chartOpen=!chartOpen;$('chart-toggle').setAttribute('aria-expanded',String(chartOpen));$('chart-panel').classList.toggle('is-open',chartOpen);
  $('chart-body').inert=!chartOpen;$('chart-body').setAttribute('aria-hidden',String(!chartOpen));
  if(chartOpen)void dashboardReport();
});
$('chart-body').addEventListener('transitionend',event=>{if(event.target===$('chart-body')&&chartOpen)paintChart();});
$('chart-report-link').addEventListener('click',()=>{
  reportPreset='custom';syncReportPresets();const range=selectedChartRange();$('report-from').value=range.from;$('report-to').value=range.to;
  const button=document.querySelector('[data-page="reports"]');if(button instanceof HTMLButtonElement)button.click();
});

let reportIntegrityAt=null,reportIntegrityCache=300;
let reportRevision=0,activeReportKey='',reportPreset='30',reportFailed=false,reportPaintWidth=0;
function syncReportPresets(){document.querySelectorAll('[data-report-days]').forEach(button=>button.setAttribute('aria-pressed',String(button.getAttribute('data-report-days')===reportPreset)));}
function setReportPreset(value,load=true){
  reportPreset=String(value);syncReportPresets();
  if(value==='custom'){$('report-from').focus();return;}
  const range=reportQuickRange(Number(value),new Date(clock.now()));
  if($('report-from').value!==range.from||$('report-to').value!==range.to)invalidateReport();
  $('report-from').value=range.from;$('report-to').value=range.to;
  if(load)void loadReport();
}
function reportIsStale(snapshot){const age=clock.now()-Date.parse(snapshot.observed_at);return reportFailed||age>(snapshot.cache_seconds??300)*1000||age< -5000;}
function reportObservation(){
  if(reportIntegrityAt)$('metrics-observed').textContent=`Histórico completo da origem · snapshot ${date(reportIntegrityAt)} · cache ${reportIntegrityCache} s${reportIsStale({observed_at:reportIntegrityAt,cache_seconds:reportIntegrityCache})?' · desatualizado':''}`;
  if(!reportData){$('report-observation-state').textContent=reportBusy?'Consultando':'Sem observação válida';$('report-observation-state').dataset.state='UNKNOWN';$('report-snapshot').textContent='Snapshot do período indisponível';return;}
  const stale=reportIsStale(reportData);
  $('report-observation-state').textContent=stale?'Observação desatualizada':reportData.outbox_available?'Snapshot observado':'Observação parcial · sem outbox';
  $('report-observation-state').dataset.state=stale?'PAUSED':'UNKNOWN';
  $('report-snapshot').textContent=`${date(reportData.observed_at)} · Brasília · não comprova conexão corporativa`;
}
function clearReportPeriod(){
  for(const id of ['metric-calls','metric-identified','metric-operators','metric-confirmed','metric-pending'])$(id).textContent='—';
  $('report-identification').textContent='Sem observação do período';$('report-summary').replaceChildren();table('report-rows',[]);
  $('report-chart').textContent='Série do período indisponível.';$('report-page').textContent='Sem dados';$('report-prev').disabled=true;$('report-next').disabled=true;
}
function invalidateReport(){
  reportRevision++;activeReportKey='';reportBusy=false;reportData=null;reportFailed=false;reportPage=0;
  $('apply-report').disabled=false;$('export-report').disabled=true;$('report-form').setAttribute('aria-busy','false');clearReportPeriod();reportObservation();
  $('report-window').textContent='Janela alterada · aguardando observação';$('report-status').textContent='Filtros alterados. Atualize para observar este período.';
}
function renderReport(){
  if(!reportData)return;
  const rows=[...reportData.daily].sort((a,b)=>b.day.localeCompare(a.day)),total=rows.length,maxPage=Math.max(0,Math.ceil(total/pageSize)-1);reportPage=Math.min(reportPage,maxPage);
  $('report-rows').replaceChildren();
  for(const row of rows.slice(reportPage*pageSize,(reportPage+1)*pageSize)){
    const tr=document.createElement('tr'),day=document.createElement('td');
    day.textContent=dayLabel(row.day);if(row.day===brasiliaDay(clock.now())){const badge=document.createElement('small');badge.className='report-today';badge.textContent='Hoje · parcial';day.append(badge);}tr.append(day);
    for(const field of ['calls','identified_calls','confirmed','pending','inconsistent']){const td=document.createElement('td');td.textContent=count(row[field]);tr.append(td);}
    const actions=document.createElement('td');actions.className='report-row-actions';
    for(const [action,label,icon] of [['view','Visualizar','eye'],['export','Exportar','download']]){
      const button=document.createElement('button');button.type='button';button.className='secondary';button.dataset.reportAction=action;button.dataset.reportDay=row.day;button.setAttribute('aria-label',`${label} ${dayLabel(row.day)}`);button.title=label;
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#icon-'+icon);svg.append(use);button.append(svg);actions.append(button);
    }tr.append(actions);$('report-rows').append(tr);
  }
  const first=total?reportPage*pageSize+1:0,last=Math.min(total,(reportPage+1)*pageSize);
  $('report-page').textContent=total?`Página ${reportPage+1} de ${maxPage+1} · ${first}–${last} de ${total} dias com chamadas`:'Nenhuma chamada neste período';
  $('report-prev').disabled=reportPage===0;$('report-next').disabled=reportPage===maxPage;
}
function paintReportChart(){
  if(!reportData||currentPage!=='reports')return;
  renderDashboardChart($('report-chart'),reportData,undefined,{model:reportModel(reportData),corporate:reportData.outbox_available,height:280,today:brasiliaDay(clock.now())});
  $('report-confirmed-legend').hidden=!reportData.outbox_available;
  $('report-chart-status').textContent=reportData.outbox_available?'Confirmações atribuídas à data da ligação; não são volume diário de despacho.':'Outbox indisponível: série corporativa omitida; não equivale a zero confirmações.';
  reportPaintWidth=$('report-chart').clientWidth;
}
async function loadReport(){
  if(!logged)return;
  let range;
  try{range=reportWindow($('report-from').value,$('report-to').value);}catch(error){invalidateReport();$('report-status').textContent=error.message;return;}
  const key=chartKey(range);if(reportBusy&&activeReportKey===key)return;activeReportKey=key;
  const revision=++reportRevision,epoch=sessionEpoch;
  if(reportData&&(reportData.from!==range.from||reportData.to!==range.to)){reportData=null;clearReportPeriod();}
  reportBusy=true;reportFailed=false;$('apply-report').disabled=true;$('export-report').disabled=true;$('report-form').setAttribute('aria-busy','true');
  $('report-window').textContent=`${dayLabel(range.from)} — ${dayLabel(range.to)} · ${range.days} dias corridos · aguardando observação`;$('report-status').textContent='Consultando snapshot local…';$('report-summary').replaceChildren();reportObservation();
  try{
    const r=await api(reportUrl(range.from,range.to));if(!logged||epoch!==sessionEpoch||revision!==reportRevision)return;
    if(r.from!==range.from||r.to!==range.to)throw new Error('O snapshot não corresponde ao filtro selecionado.');
    reportModel(r);reportData=r;reportIntegrityAt=r.observed_at;reportIntegrityCache=r.cache_seconds??300;reportPage=0;renderDashboardMetrics($,r,true);
    $('report-undated').textContent=count(r.summary.undated);$('report-missing').textContent=count(r.summary.missing_mapping);$('report-divergent').textContent=count(r.summary.inconsistent);
    $('report-identification').textContent=BigInt(r.period.calls)?`${chartPercent(BigInt(r.period.identified_calls),BigInt(r.period.calls))} no mesmo período`:'Sem chamadas no período';
    $('metrics-observed').textContent=`Histórico completo da origem · snapshot ${date(r.observed_at)} · cache ${r.cache_seconds??300} s`;
    describe('integrity-details',[['Registros sem data de chamada',count(r.summary.undated)],['Mappings sem registro local',count(r.summary.missing_mapping)],['Recibos divergentes',count(r.summary.inconsistent)]]);
    const selected=selectedChartRange();if(r.from===selected.from&&r.to===selected.to){rememberChart(r);chartSnapshot=r;}
    $('report-window').textContent=`${dayLabel(r.from)} — ${dayLabel(r.to)} · ${range.days} dias corridos`;
    $('report-status').textContent=`Snapshot ${date(r.observed_at)} · Brasília · cache de até ${r.cache_seconds??300} s${r.outbox_available?'':' · métricas corporativas indisponíveis'}.`;
    for(const [label,value]of [['Chamadas únicas',r.period.calls],['Com operador',r.period.identified_calls],['Operadores distintos no período',r.period.operators],['Confirmações MADM (recibos)',r.period.confirmed]]){const span=document.createElement('span');span.textContent=`${label}: ${count(value)}`;$('report-summary').append(span);}
    renderReport();paintReportChart();$('export-report').disabled=!r.daily.length;
  }catch(error){
    if(logged&&epoch===sessionEpoch&&revision===reportRevision){
      reportFailed=true;$('report-status').textContent='Relatório indisponível. Confira o período e tente novamente; nenhuma contagem foi estimada.';
      if(reportData){$('report-status').textContent+=' Último snapshot do mesmo filtro preservado e desatualizado.';$('export-report').disabled=!reportData.daily.length;}
      else clearReportPeriod();
      $('metrics-observed').textContent+=' · última observação desatualizada';
    }
  }finally{
    if(epoch===sessionEpoch&&revision===reportRevision){reportBusy=false;$('apply-report').disabled=false;$('report-form').setAttribute('aria-busy','false');reportObservation();}
  }
}
function exportReportRows(rows,from,to){
  if(!reportData)return;
  let url;
  try{
    url=URL.createObjectURL(new Blob([reportCsv(rows)],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`olos-chamadas-${from}-${to}.csv`;link.click();
    $('report-status').textContent=`CSV gerado do snapshot ${date(reportData.observed_at)} · ${rows.length} dias${reportIsStale(reportData)?' · observação desatualizada':''}.`;
  }catch{$('report-status').textContent='Não foi possível gerar o CSV. O snapshot permanece disponível.';}
  finally{if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
document.querySelectorAll('[data-report-days]').forEach(button=>button.addEventListener('click',()=>setReportPreset(button.getAttribute('data-report-days'))));
for(const id of ['report-from','report-to'])$(id).addEventListener('input',()=>{reportPreset='custom';syncReportPresets();invalidateReport();});
$('report-form').addEventListener('submit',event=>{event.preventDefault();void loadReport();});
$('report-prev').addEventListener('click',()=>{reportPage--;renderReport();});$('report-next').addEventListener('click',()=>{reportPage++;renderReport();});
$('export-report').addEventListener('click',()=>{if(reportData)exportReportRows(reportData.daily,reportData.from,reportData.to);});
$('report-rows').addEventListener('click',event=>{
  const button=event.target instanceof Element?event.target.closest('[data-report-action]'):null;if(!button||!reportData)return;
  const row=reportData.daily.find(entry=>entry.day===button.getAttribute('data-report-day'));if(!row)return;
  if(button.getAttribute('data-report-action')==='export'){exportReportRows([row],row.day,row.day);return;}
  $('report-day-title').textContent=`Detalhe de ${dayLabel(row.day)}`;$('report-day-snapshot').textContent=`Snapshot ${date(reportData.observed_at)} · Brasília${reportIsStale(reportData)?' · desatualizado':''}`;
  describe('report-day-details',reportFields.filter(field=>field!=='day').map(field=>[({calls:'Coletadas',identified_calls:'Com operador',operators:'Operadores distintos',confirmed:'Recibos confirmados',pending:'Outbox pendente',inconsistent:'Recibos divergentes',not_queued:'Sem outbox',with_cpf:'Com CPF',with_email:'Com e-mail'})[field],count(row[field])]));
  $('report-day-dialog').showModal();
});
$('report-day-close').addEventListener('click',()=>$('report-day-dialog').close());

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&logged){void refresh();if(currentPage==='dashboard')void refreshToday();}});
api('/session').then(enter).catch(()=>showLogin());setInterval(refresh,2000);setInterval(()=>{if(logged&&currentPage==='dashboard'){void refreshToday();if(chartOpen)void dashboardReport();}},30000);setInterval(tick,1000);
