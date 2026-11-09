import { count, date, dayLabel, zone } from './ui.js';

export const statusLabels = {RUNNING:'Operando',PAUSED:'Pausado',PAUSING:'Pausando',STOPPED:'Parado',STOPPING:'Finalizando',ERROR:'Erro operacional'};
const calendarFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
export const brasiliaDay = milliseconds => {
  const parts=calendarFormatter.formatToParts(new Date(milliseconds)),part=type=>parts.find(p=>p.type===type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

// Wall time anchors come from the server; elapsed time is monotonic, never an
// accumulated tick count. A local-clock fallback is explicitly identified.
export class ServerClock {
  constructor(monotonic = () => performance.now(), wall = () => Date.now()) {
    this.monotonic = monotonic; this.wall = wall; this.anchor = null;
  }
  sync(iso) {
    const time = Date.parse(iso);
    if (Number.isFinite(time)) this.anchor = {time,at:this.monotonic()};
  }
  now() { return this.anchor ? this.anchor.time + this.monotonic() - this.anchor.at : this.wall(); }
  get synchronized() { return this.anchor !== null; }
}

export function countdownView(status, now, stale = false) {
  if(stale)return {value:'Sem conexão',detail:'Agendamento indisponível. Aguardando sincronização.',state:'stale'};
  if(!status)return {value:'—',detail:'Consultando agendamento…',state:'loading'};
  const labels={PAUSED:['Pausado','Novas leituras estão pausadas.'],STOPPED:['Parado','Nenhuma nova leitura programada.'],ERROR:['Erro operacional','Consulte o status operacional.'],PAUSING:['Pausando','Aguardando a conclusão da operação ativa.'],STOPPING:['Finalizando','Aguardando a conclusão da operação ativa.']};
  if(labels[status.state])return {value:labels[status.state][0],detail:labels[status.state][1],state:status.state.toLowerCase()};
  if(status.state!=='RUNNING')return {value:'Indisponível',detail:'Estado do scheduler não reconhecido.',state:'unavailable'};
  if(status.cycle_in_progress)return {value:'Em leitura',detail:'Leitura em andamento. O próximo horário ainda não está definido.',state:'active'};
  const due=status.next_run_at ? Date.parse(status.next_run_at) : NaN;
  if(!Number.isFinite(due))return {value:'Sem agendamento',detail:'Aguardando o próximo agendamento do scheduler.',state:'waiting'};
  const remaining=Math.ceil((due-now)/1000);
  if(remaining<=0)return {value:'Aguardando execução',detail:'Horário alcançado. Aguardando confirmação do scheduler.',state:'waiting'};
  return {value:`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`,detail:`Programada para ${date(status.next_run_at)} · Brasília`,state:'scheduled'};
}

export function todayView(snapshot, now, failed = false) {
  const day=brasiliaDay(now);
  if(!snapshot)return {value:'—',detail:failed?'Contagem indisponível. Aguardando nova observação.':'Buscando primeira observação…',state:failed?'unavailable':'loading'};
  if(snapshot.date!==day)return {value:'—',detail:'Novo dia em Brasília. Aguardando o acumulado de hoje.',state:'rollover'};
  const observed=Date.parse(snapshot.observed_at),age=now-observed;
  const valid=typeof snapshot.calls==='string'&&/^\d+$/.test(snapshot.calls)&&Number.isFinite(observed);
  if(!valid)return {value:'—',detail:'Contagem indisponível. Nenhum valor foi estimado.',state:'unavailable'};
  const stale=failed||age>(snapshot.cache_seconds??300)*1000||age< -5000;
  return {value:count(snapshot.calls),detail:`${stale?'Desatualizado · última leitura válida':'Observado em'} ${date(snapshot.observed_at)}${stale?'':' · atualização a cada 5 min'}`,state:stale?'stale':'fresh'};
}

export function renderToday(element, snapshot, now, failed = false) {
  const view=todayView(snapshot,now,failed),value=element('today-calls'),card=element('today-card');
  if(value.textContent!==view.value){
    value.textContent=view.value;
    if(view.state==='fresh'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)
      value.animate?.([{opacity:.55,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'ease-out'});
  }
  card.dataset.state=view.state;card.setAttribute('aria-busy',String(view.state==='loading'||view.state==='rollover'));
  if(element('today-updated').textContent!==view.detail)element('today-updated').textContent=view.detail;
  element('dashboard-date').textContent=`${dayLabel(brasiliaDay(now))} · Brasília`;
}
export function renderCountdown(element,status,now,stale=false) {
  const view=countdownView(status,now,stale);
  if(element('countdown').textContent!==view.value)element('countdown').textContent=view.value;
  element('countdown').classList.toggle('timer-message',view.state!=='scheduled');
  if(element('countdown-detail').textContent!==view.detail)element('countdown-detail').textContent=view.detail;
  element('countdown-card').dataset.state=view.state;
}
