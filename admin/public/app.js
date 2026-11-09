import {date,count,dayLabel,defaultRange,reportFields,reportCsv,safeEvents,eventLines,renderDashboardChart,renderDashboardMetrics,renderTerminal} from './ui.js';
import {ServerClock,brasiliaDay,statusLabels,renderToday,renderCountdown} from './dashboard.js';
/** @returns {any} */
const $=id=>document.getElementById(id);
let csrf='',revision=0,logged=false,refreshing=false,currentPage='dashboard';
const titles={dashboard:'Dashboard',reports:'Relatórios',logs:'Terminal / Logs',schedule:'Agendamento',credentials:'Credenciais OLOS',status:'Status operacional'};
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
let schedulerSnapshot=null,statusAt=0,statusFailed=false,todaySnapshot=null,todayFailed=false,todayFlight=null,chartFlight=null;
let activeDay=brasiliaDay(clock.now()),chartOpen=false,chartReceivedAt=0;
function resetOperational(){$('state').textContent='Carregando';$('state').dataset.state='UNKNOWN';$('state').classList.remove('error');$('corporate-state').textContent='—';$('corporate-detail').textContent='Aguardando estado do controle local.';schedulerSnapshot=null;statusAt=0;statusFailed=false;todaySnapshot=null;todayFailed=false;todayFlight=null;chartFlight=null;clock.anchor=null;activeDay=brasiliaDay(clock.now());renderToday($,null,clock.now());renderCountdown($,null,clock.now());}
function renderClock(){renderCountdown($,schedulerSnapshot,clock.now(),statusFailed||!!schedulerSnapshot&&performance.now()-statusAt>10000);}
function tick(){
  if(!logged)return;
  renderClock();renderToday($,todaySnapshot,clock.now(),todayFailed);
  const day=brasiliaDay(clock.now());
  if(activeDay!==day){activeDay=day;void refreshToday();}
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
    $('corporate-detail').textContent=c?(c.last_code||'Controle local; não comprova conectividade ou escrita habilitada.'):'Nenhum controle corporativo disponível.';
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
  }catch(e){if(logged&&epoch===sessionEpoch){statusFailed=true;renderClock();notice('Não foi possível atualizar o estado operacional.',true);$('state').textContent='Indisponível';$('state').classList.add('error');$('corporate-state').textContent='Indisponível';}}finally{refreshing=false;}
}
async function credentials(){const epoch=sessionEpoch,c=await api('/credentials');if(!logged||epoch!==sessionEpoch)return;revision=c.revision;const f=$('credentials-form');for(const key of ['baseUrl','username'])f.elements.namedItem(key).value=c[key];f.elements.namedItem('password').value='';$('credentials-complete').textContent=`Configuração ${c.complete?'completa':'incompleta'} · ${c.origin==='environment'?'origem: variáveis de ambiente':'origem: banco criptografado'}. Campos secretos vazios preservam os valores atuais.`;$('password-configured').textContent=c.passwordConfigured?'Senha configurada no backend.':'Senha ainda não configurada.';testResult(c.lastTest);}
function testResult(r){$('test-result').textContent=r?`${r.ok?'Autenticação validada':'Falha no teste'} · ${r.code} · ${r.duration_ms} ms · ${date(r.at)}`:'Nenhum teste registrado para esta configuração.';}
async function logs(){const epoch=sessionEpoch;const rows=await api('/logs');if(!logged||epoch!==sessionEpoch)return;table('log-rows',rows.map(r=>[r.id,date(r.started_at),r.state,r.processed_count,r.received_count,r.request_ms,r.error_code]));}
async function enter(session){sessionEpoch++;csrf=session.csrf;logged=true;$('actor').textContent=session.actor;$('login').hidden=true;$('app').hidden=false;selectPage('dashboard');void refreshToday();void refreshEvents();await refresh();}
async function action(fn,button){if(button)button.disabled=true;try{await fn();}catch(e){notice(e.message,true);}finally{if(button)button.disabled=false;}}
$('login-form').addEventListener('submit',async (/** @type {any} */ e)=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;try{const input=Object.fromEntries(new FormData(f));f.elements.namedItem('password').value='';await enter(await api('/login','POST',input));f.reset();$('login-error').textContent='';}catch(err){$('login-error').textContent=err.message;f.elements.namedItem('password').value='';}finally{b.disabled=false;}});
function selectPage(page){currentPage=page;document.querySelectorAll('[data-view]').forEach((/** @type {HTMLElement} */ s)=>s.hidden=s.dataset.view!==currentPage);document.querySelectorAll('[data-page]').forEach((/** @type {HTMLElement} */ b)=>b.classList.toggle('selected',b.dataset.page===currentPage));$('title').textContent=titles[currentPage];$('breadcrumb').textContent=currentPage==='credentials'?'CONFIGURAÇÕES':currentPage==='reports'?'ANÁLISE':'OPERAÇÃO';notice('');document.body.classList.remove('menu-open');syncMenu();mountTerminal();}
document.querySelectorAll('[data-page]').forEach((/** @type {HTMLButtonElement} */ button)=>button.addEventListener('click',()=>action(async()=>{selectPage(button.dataset.page);if(currentPage==='dashboard'){tick();void refreshToday();if(chartOpen)void dashboardReport();}if(currentPage==='reports')await loadReport();if(currentPage==='credentials')await credentials();if(currentPage==='logs'){void refreshEvents();await logs();}await refresh();})));
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
const pageSize=14;
function mountTerminal(){const visible=['dashboard','logs'].includes(currentPage);$('terminal').hidden=!visible;if(visible)$(currentPage==='dashboard'?'dashboard-terminal':'logs-terminal').append($('terminal'));}
function renderEvents(){
  const shown=renderTerminal($('event-output'),eventEntries,$('event-search').value,$('event-level').value,$('event-autoscroll').checked);
  $('event-status').textContent=`${shown.visible} de ${shown.total} eventos do buffer disponível${eventsUpdatedAt?' · atualizado '+date(eventsUpdatedAt)+' · Brasília':''}${eventsFailed?' · visualização desatualizada':''}`;
  $('event-pause').textContent=eventPaused?'Retomar visualização':'Pausar visualização';
  $('event-pause').setAttribute('aria-pressed',String(eventPaused));
  $('terminal-live').textContent=eventPaused?'VISUALIZAÇÃO PAUSADA':eventsFailed?'SEM ATUALIZAÇÃO':eventsUpdatedAt?'AO VIVO · 2 s':'CONECTANDO';
}
async function refreshEvents(){
  if(!logged||eventPaused||eventsBusy)return;eventsBusy=true;const epoch=sessionEpoch;
  try{const events=await api('/events');if(!logged||epoch!==sessionEpoch||eventPaused)return;eventEntries=safeEvents(events);eventsFailed=false;eventsUpdatedAt=new Date();renderEvents();}
  catch{if(logged&&epoch===sessionEpoch){eventsFailed=true;$('terminal-live').textContent='SEM ATUALIZAÇÃO';$('event-status').textContent='Eventos indisponíveis. A visualização anterior pode estar desatualizada.';}}
  finally{eventsBusy=false;}
}
$('event-search').addEventListener('input',renderEvents);$('event-level').addEventListener('change',renderEvents);
$('event-autoscroll').addEventListener('change',()=>{if($('event-autoscroll').checked)$('event-output').scrollTop=$('event-output').scrollHeight;});
$('event-pause').addEventListener('click',()=>{eventPaused=!eventPaused;renderEvents();if(!eventPaused)void refreshEvents();});
$('event-copy').addEventListener('click',()=>action(async()=>{await navigator.clipboard.writeText(eventLines(eventEntries,$('event-search').value,$('event-level').value).join('\n'));$('event-status').textContent='Logs sanitizados copiados.';},$('event-copy')));
function syncMenu(){const open=document.body.classList.contains('menu-open');$('menu-toggle').setAttribute('aria-expanded',String(open));$('sidebar').inert=matchMedia('(max-width:760px)').matches&&!open;}
$('menu-toggle').addEventListener('click',()=>{document.body.classList.toggle('menu-open');syncMenu();});
window.addEventListener('resize',()=>{syncMenu();if(chartSnapshot&&chartOpen&&currentPage==='dashboard')renderDashboardChart($('calls-chart'),chartSnapshot);});syncMenu();
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('menu-open');syncMenu();}});
const initialRange=defaultRange();$('report-from').value=initialRange.from;$('report-to').value=initialRange.to;
function reportUrl(from,to){return '/reports?'+new URLSearchParams({from,to});}
function clearMetrics(){chartSnapshot=null;chartReceivedAt=0;$('metrics-error').textContent='';$('chart-period').textContent='';for(const id of ['calls','identified','confirmed','pending','errors'])$('metric-'+id).textContent='—';$('metrics-observed').textContent='Indicadores indisponíveis';$('calls-chart').textContent='Série diária indisponível.';}
function resetReports(){chartOpen=false;$('chart-toggle').setAttribute('aria-expanded','false');$('chart-panel').classList.remove('is-open');$('chart-body').inert=true;$('chart-body').setAttribute('aria-hidden','true');$('chart-status').textContent='';$('integrity-details').replaceChildren();reportData=null;reportPage=0;table('report-rows',[]);$('report-summary').replaceChildren();$('report-page').textContent='Sem dados';$('report-prev').disabled=true;$('report-next').disabled=true;$('report-status').textContent='Selecione um período.';$('export-report').disabled=true;clearMetrics();}
function paintChart(){
  if(!chartSnapshot||!chartOpen)return;
  renderDashboardChart($('calls-chart'),chartSnapshot);
  $('chart-period').textContent=`${dayLabel(chartSnapshot.from)} — ${dayLabel(chartSnapshot.to)} · Brasília`;
}
async function dashboardReport(){
  if(!logged||!chartOpen||chartFlight)return;
  const range=defaultRange(new Date(clock.now()));
  if(chartSnapshot&&chartSnapshot.from===range.from&&chartSnapshot.to===range.to&&performance.now()-chartReceivedAt<(chartSnapshot.cache_seconds??300)*1000){paintChart();return;}
  const flight={epoch:sessionEpoch};chartFlight=flight;
  $('chart-status').textContent='Consultando série…';
  try{const r=await api(reportUrl(range.from,range.to));if(!logged||flight.epoch!==sessionEpoch)return;
    chartSnapshot=r;chartReceivedAt=performance.now()-Math.max(0,clock.now()-Date.parse(r.observed_at));$('chart-status').textContent=`Snapshot ${date(r.observed_at)}`;paintChart();
  }catch{if(logged&&flight.epoch===sessionEpoch){$('chart-status').textContent=chartSnapshot?'Série desatualizada · última observação preservada.':'Série indisponível. Tente novamente ao expandir.';if(!chartSnapshot)$('calls-chart').textContent='Não foi possível consultar a série diária.';}}
  finally{if(chartFlight===flight)chartFlight=null;}
}
$('chart-toggle').addEventListener('click',()=>{
  chartOpen=!chartOpen;$('chart-toggle').setAttribute('aria-expanded',String(chartOpen));$('chart-panel').classList.toggle('is-open',chartOpen);
  $('chart-body').inert=!chartOpen;$('chart-body').setAttribute('aria-hidden',String(!chartOpen));
  if(chartOpen)void dashboardReport();
});
$('chart-body').addEventListener('transitionend',()=>{if(chartOpen)paintChart();});

function renderReport(){
  if(!reportData)return;const rows=reportData.daily,total=rows.length,maxPage=Math.max(0,Math.ceil(total/pageSize)-1);reportPage=Math.min(reportPage,maxPage);
  table('report-rows',rows.slice(reportPage*pageSize,(reportPage+1)*pageSize).map(r=>reportFields.map(key=>key==='day'?dayLabel(r[key]):count(r[key]))));
  $('report-page').textContent=total?`Página ${reportPage+1} de ${maxPage+1} · ${total} dias com chamadas`:'Nenhuma chamada neste período';
  $('report-prev').disabled=reportPage===0;$('report-next').disabled=reportPage===maxPage;
}
async function loadReport(){
  if(!logged||reportBusy)return;reportBusy=true;const epoch=sessionEpoch,from=$('report-from').value,to=$('report-to').value;
  $('apply-report').disabled=true;$('export-report').disabled=true;reportData=null;table('report-rows',[]);$('report-summary').replaceChildren();$('report-prev').disabled=true;$('report-next').disabled=true;$('report-page').textContent='—';$('report-status').textContent='Consultando dados locais…';
  try{const r=await api(reportUrl(from,to));if(!logged||epoch!==sessionEpoch)return;reportData=r;reportPage=0;renderDashboardMetrics($,r);
    describe('integrity-details',[['Registros sem data de chamada',count(r.summary.undated)],['Mappings sem registro local',count(r.summary.missing_mapping)],['Recibos divergentes',count(r.summary.inconsistent)],['Registros sem outbox',count(r.summary.not_queued)],['Operadores distintos no histórico',count(r.summary.operators)],['Com CPF preenchido',count(r.summary.with_cpf)],['Com e-mail preenchido',count(r.summary.with_email)]]);
    const range=defaultRange(new Date(clock.now()));if(r.from===range.from&&r.to===range.to){chartSnapshot=r;chartReceivedAt=performance.now()-Math.max(0,clock.now()-Date.parse(r.observed_at));}

    $('report-status').textContent=`${dayLabel(r.from)} a ${dayLabel(r.to)} · Snapshot ${date(r.observed_at)} · intervalo de atualização: ${r.cache_seconds ?? 300} s · Brasília${r.outbox_available?'':' · Outbox indisponível'}. ${count(r.summary.undated)} registros sem data ficam fora do período.`;
    for(const [label,value]of [['Chamadas únicas',r.period.calls],['Com operador',r.period.identified_calls],['Operadores distintos no período',r.period.operators],['Confirmações MADM (recibos)',r.period.confirmed]]){const span=document.createElement('span');span.textContent=`${label}: ${count(value)}`;$('report-summary').append(span);}
    renderReport();$('export-report').disabled=!r.daily.length;
  }catch{if(logged&&epoch===sessionEpoch){$('metrics-observed').textContent+=' · desatualizado';$('report-status').textContent='Relatório indisponível. Confira um período válido de até 366 dias e tente novamente; nenhuma contagem foi estimada.';}}
  finally{reportBusy=false;$('apply-report').disabled=false;}
}
$('report-form').addEventListener('submit',e=>{e.preventDefault();void loadReport();});
$('report-prev').addEventListener('click',()=>{reportPage--;renderReport();});$('report-next').addEventListener('click',()=>{reportPage++;renderReport();});
$('export-report').addEventListener('click',()=>{if(!reportData)return;const url=URL.createObjectURL(new Blob([reportCsv(reportData.daily)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`olos-chamadas-${reportData.from}-${reportData.to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&logged){void refresh();if(currentPage==='dashboard')void refreshToday();}});
api('/session').then(enter).catch(()=>showLogin());setInterval(refresh,2000);setInterval(()=>{if(logged&&currentPage==='dashboard'){void refreshToday();if(chartOpen)void dashboardReport();}},30000);setInterval(tick,1000);
