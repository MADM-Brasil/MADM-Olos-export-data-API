/** Presentation helpers: no network, operational actions or persistent browser storage. */
export const zone = 'America/Sao_Paulo';
export function date(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('pt-BR', { timeZone: zone }) : '—';
}
export function count(value) {
  return value !== null && value !== undefined && /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('pt-BR') : 'Indisponível';
}
export function dayLabel(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—'; }
export function defaultRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const to = `${part('year')}-${part('month')}-${part('day')}`;
  const start = new Date(`${to}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - 29);
  return { from: start.toISOString().slice(0, 10), to };
}
export const reportFields = ['day','calls','identified_calls','operators','with_cpf','with_email','confirmed','pending','not_queued','inconsistent'];
const headers = ['Data da ligação (America/Sao_Paulo)','Chamadas únicas','Chamadas com operador','Operadores distintos','Com CPF','Com e-mail','Confirmadas (recibo local MADM)','Pendentes (outbox)','Sem outbox','Divergentes (outbox)'];
export function reportCsv(rows) {
  // Only explicitly selected dates/counts. Never export payloads or spreadsheet formulas.
  const cell = value => `"${String(value ?? 'Indisponível').replaceAll('"', '""')}"`;
  return '\ufeff' + [headers, ...rows.map(row => reportFields.map(key => {
    const value = row[key];
    return key === 'day' ? dayLabel(value) : /^\d+$/.test(String(value ?? '')) ? value : 'Indisponível';
  }))].map(row => row.map(cell).join(';')).join('\r\n');
}
const events = new Set(['admin_listening','scheduler_started','scheduler_interval_changed','scheduler_paused','scheduler_resumed','scheduler_next_run','scheduler_error','poll_retry','batch_completed','recovery_required','reference_cache_refreshed','local_recovery_completed','olos_tls_verification_disabled','corporate_delivery_confirmed','corporate_delivery_deferred']);
const numericFields = new Set(['received','inserted','updated','duplicates','duration_ms','request_ms','persistence_ms','interval_ms','retry_ms','port','queued','skipped','confirmed']);
export function safeEvents(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(-200).filter(e => e && events.has(e.event)).map(e => {
    const safe = { event: e.event, time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.time) ? e.time : null };
    for (const [key,value] of Object.entries(e)) {
      if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      if (['enabled','blocked'].includes(key) && typeof value === 'boolean') safe[key] = value;
      if (key === 'error' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value)) safe[key] = value;
      if (key === 'read_id' && typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) safe[key] = value;
      if (key === 'next_run_at' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) safe[key] = value;
    }
    return safe;
  });
}
export function eventLevel(event) {
  if (event.event === 'scheduler_error' || event.event === 'recovery_required' || event.blocked === true) return 'ERROR';
  if (event.error || ['poll_retry','olos_tls_verification_disabled','corporate_delivery_deferred'].includes(event.event)) return 'WARN';
  return 'INFO';
}
export function eventLines(entries, search = '', level = 'ALL') {
  return terminalRows(entries,search,level).map(row=>row.line);
}
// Display, search and copy share the same sanitized fields and chronological order.
export function terminalRows(entries, search = '', level = 'ALL') {
  const occurrences=new Map();
  return entries.map((e,index)=>{
    const identity=JSON.stringify(e),occurrence=occurrences.get(identity)||0;
    occurrences.set(identity,occurrence+1);
    const time=`${date(e.time)} Brasília`,severity=eventLevel(e);
    const detail=Object.entries(e).filter(([k])=>!['event','time'].includes(k))
      .map(([k,v])=>`${k}=${k==='next_run_at'?date(v)+' Brasília':v}`).join(' ');
    return {key:`${identity}/${occurrence}`,index,time,severity,event:e.event,detail,
      timestamp:Date.parse(e.time)||0,line:`${time} | ${severity} | ${e.event} | ${detail}`};
  }).filter(row=>row.line.toLowerCase().includes(search.toLowerCase())&&(level==='ALL'||row.severity===level))
    .sort((a,b)=>a.timestamp-b.timestamp||a.index-b.index);
}
function svgNode(tag, attrs = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
  if (text) node.textContent = text; return node;
}
// Exact integer arithmetic for report counts; only bounded ratios become SVG numbers.
export function chartRange(days = 7, now = new Date()) {
  if (![1,7,14,30].includes(days)) throw new Error('CHART_PERIOD_INVALID');
  const {to}=defaultRange(now), start=new Date(`${to}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate()-days+1);
  return {from:start.toISOString().slice(0,10),to};
}
export function chartPercent(part, total) {
  if(total===0n)return '—';
  const tenths=(part*1000n+total/2n)/total;
  return `${tenths/10n},${tenths%10n}%`;
}
export function chartCompact(value) {
  /** @type {[bigint,string][]} */
  const units=[[1000000000000n,'tri'],[1000000000n,'bi'],[1000000n,'mi'],[1000n,'mil']];
  for(const [unit,label] of units){
    if(value>=unit){const tenths=(value*10n+unit/2n)/unit;return `${count(tenths/10n)}${tenths%10n?','+tenths%10n:''} ${label}`;}
  }
  return count(value);
}
export function chartModel(rows, from, to) {
  const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(!validDay(from)||!validDay(to)||from>to||!Array.isArray(rows))throw new Error('CHART_DATA_INVALID');
  const byDay=new Map();
  for(const row of rows){
    if(!validDay(row.day)||row.day<from||row.day>to||byDay.has(row.day)||
      !['calls','identified_calls'].every(key=>typeof row[key]==='string'&&/^\d+$/.test(row[key])))throw new Error('CHART_DATA_INVALID');
    const calls=BigInt(row.calls),identified=BigInt(row.identified_calls);
    if(identified>calls)throw new Error('CHART_DATA_INVALID');
    byDay.set(row.day,{day:row.day,calls,identified});
  }
  const series=[],cursor=new Date(`${from}T12:00:00Z`);
  while(cursor.toISOString().slice(0,10)<=to){
    if(series.length>=366)throw new Error('CHART_PERIOD_INVALID');
    const day=cursor.toISOString().slice(0,10);series.push(byDay.get(day)||{day,calls:0n,identified:0n});cursor.setUTCDate(cursor.getUTCDate()+1);
  }
  let total=0n,identified=0n,peak=null;
  for(const row of series){total+=row.calls;identified+=row.identified;if(row.calls>0n&&(!peak||row.calls>peak.calls))peak=row;}
  const denominator=BigInt(series.length),averageTenths=(total*10n+denominator/2n)/denominator;
  const maximum=peak?.calls||0n,raw=(maximum+4n)/5n;
  let magnitude=1n;while(magnitude*10n<=raw)magnitude*=10n;
  const step=[1n,2n,5n,10n].map(n=>n*magnitude).find(n=>n>=raw)||1n;
  return {series,total,identified,peak,denominator,average:`${count(averageTenths/10n)}${averageTenths%10n?','+averageTenths%10n:''}`,percent:chartPercent(identified,total),step,scale:maximum?((maximum+step-1n)/step)*step:5n,empty:total===0n};
}
const chartRenders=new WeakMap();
const weekDay=day=>new Intl.DateTimeFormat('pt-BR',{timeZone:zone,weekday:'short'}).format(new Date(`${day}T15:00:00Z`)).replace('.','').replace(/^./,c=>c.toUpperCase());
export function renderChart(root, rows, from, to, options = {}) {
  const model=options.model||chartModel(rows,from,to),today=options.today||defaultRange().to;
  const width=Math.max(360,root.clientWidth||960,model.series.length*42+72),height=360,left=60,right=16,top=36,bottom=306;
  const signature=JSON.stringify([rows,from,to,width,today]);
  const previous=chartRenders.get(root);
  if(previous?.signature===signature&&root.querySelector('svg')){previous.observedAt=options.observedAt;return;}
  root.replaceChildren();
  if(model.empty){root.textContent='Nenhuma chamada encontrada neste período.';chartRenders.delete(root);return;}
  const state={signature,observedAt:options.observedAt};chartRenders.set(root,state);
  const scroll=document.createElement('div');scroll.className='chart-scroll';scroll.tabIndex=0;scroll.setAttribute('aria-label','Gráfico diário; use as setas para rolar quando necessário');
  const svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,width,height,role:'group','aria-label':`Chamadas por data da ligação: ${dayLabel(from)} a ${dayLabel(to)}. Cada dia pode ser focado para consultar os valores.`});
  svg.style.width=`${width}px`;
  const ratio=value=>Number(value*1000000n/model.scale)/1000000;
  const ticks=Number(model.scale/model.step);
  for(let i=0;i<=ticks;i++){
    const value=model.step*BigInt(i),y=bottom-(bottom-top)*i/ticks;
    svg.append(svgNode('line',{x1:left,y1:y,x2:width-right,y2:y,class:'grid-line'}),svgNode('text',{x:left-12,y:y+4,'text-anchor':'end',class:'axis-label'},chartCompact(value)));
  }
  const step=(width-left-right)/model.series.length,w=Math.min(28,step*.28),gap=Math.min(5,step*.06);
  model.series.forEach((row,index)=>{
    const center=left+step*(index+.5),current=row.day===today;
    const group=svgNode('g',{'data-day-index':index,tabindex:0,role:'button','aria-describedby':'chart-tooltip','aria-label':`${dayLabel(row.day)}${current?' · Hoje, em andamento':''} · Coletadas ${count(row.calls)} · Identificadas ${count(row.identified)} (${chartPercent(row.identified,row.calls)})`,class:current?'day-group current-day':'day-group'});
    if(current)group.append(svgNode('rect',{x:center-step*.44,y:top,width:step*.88,height:bottom-top,class:'today-band',rx:8}));
    group.append(svgNode('rect',{x:center-step*.48,y:top,width:step*.96,height:height-top,fill:'transparent',class:'day-target'}));
    for(const [value,css,x] of [[row.calls,'calls-bar',center-gap/2-w],[row.identified,'operators-bar',center+gap/2]]){
      const h=ratio(value)*(bottom-top),y=bottom-h,r=Math.min(4,w/2,h/2);
      group.append(svgNode('path',{d:`M ${x} ${bottom} V ${y+r} Q ${x} ${y} ${x+r} ${y} H ${x+w-r} Q ${x+w} ${y} ${x+w} ${y+r} V ${bottom} Z`,class:`${css} chart-bar`,'data-value':value.toString(),'transform-origin':`0 ${bottom}`}));
    }
    group.append(svgNode('text',{x:center,y:330,'text-anchor':'middle',class:'day-date'},dayLabel(row.day).slice(0,5)),svgNode('text',{x:center,y:348,'text-anchor':'middle',class:'day-week'},current?'Hoje':weekDay(row.day)));
    if(row===model.peak){
      const y=bottom-ratio(row.calls)*(bottom-top),labelX=Math.max(left+48,Math.min(width-right-48,center));
      group.append(svgNode('circle',{cx:center,cy:y-9,r:2.5,class:'peak-dot'}),svgNode('text',{x:labelX,y:y-18,'text-anchor':'middle',class:'peak-label'},`PICO ${chartCompact(row.calls)}`));
    }
    svg.append(group);
  });
  scroll.append(svg);root.append(scroll);
  const tooltip=document.createElement('div');tooltip.id='chart-tooltip';tooltip.className='chart-tooltip';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;root.append(tooltip);
  let tooltipKey='';
  const hide=()=>{tooltip.hidden=true;};
  const show=(group,clientX,clientY)=>{
    const row=model.series[Number(group.getAttribute('data-day-index'))],current=row.day===today;
    const key=row.day+'/'+state.observedAt;
    if(tooltipKey!==key){
    tooltipKey=key;tooltip.replaceChildren();
    const heading=document.createElement('strong');heading.textContent=`${dayLabel(row.day)} · ${current?'Hoje · em andamento':weekDay(row.day)}`;tooltip.append(heading);
    for(const [label,value] of [['Coletadas',count(row.calls)],['Identificadas',`${count(row.identified)} (${chartPercent(row.identified,row.calls)})`]]){
      const line=document.createElement('div'),name=document.createElement('span'),amount=document.createElement('b');name.textContent=label+':';amount.textContent=value;line.append(name,amount);tooltip.append(line);
    }
    if(Number.isFinite(Date.parse(state.observedAt))){const meta=document.createElement('small');meta.textContent=`Snapshot: ${date(state.observedAt)} · Brasília`;tooltip.append(meta);}
    }
    tooltip.hidden=false;
    const bounds=root.getBoundingClientRect(),target=group.getBoundingClientRect();
    const x=clientX??target.left+target.width/2,y=clientY??target.top+target.height/2;
    tooltip.style.left=`${Math.max(8,Math.min(bounds.width-tooltip.offsetWidth-8,x-bounds.left+14))}px`;
    tooltip.style.top=`${Math.max(8,Math.min(bounds.height-tooltip.offsetHeight-8,y-bounds.top-tooltip.offsetHeight-16))}px`;
  };
  const target=event=>event.target instanceof Element?event.target.closest('[data-day-index]'):null;
  svg.addEventListener('pointermove',event=>{const group=target(event);if(group)show(group,event.clientX,event.clientY);});
  svg.addEventListener('pointerleave',()=>{if(!svg.contains(document.activeElement))hide();});
  svg.addEventListener('focusin',event=>{const group=target(event);if(group)show(group);});
  svg.addEventListener('focusout',event=>{if(!svg.contains(event.relatedTarget))hide();});
  svg.addEventListener('click',event=>{const group=target(event);if(group)show(group,event.clientX,event.clientY);});
  svg.addEventListener('keydown',event=>{if(event.key==='Escape')hide();if(['Enter',' '].includes(event.key)){const group=target(event);if(group){event.preventDefault();show(group);}}});
  scroll.addEventListener('scroll',hide,{passive:true});
}

// A chart failure must never invalidate a successfully fetched count snapshot.
export function renderDashboardChart(root, snapshot, draw = renderChart, options = {}) {
  try { draw(root, snapshot.daily, snapshot.from, snapshot.to, {...options,observedAt:snapshot.observed_at}); }
  catch { root.textContent = 'Não foi possível desenhar o gráfico. Os indicadores permanecem válidos; consulte a série diária em Relatórios.'; }
}
export function renderDashboardMetrics(element, r) {
  for (const [id,value] of [['calls',r.summary.calls],['identified',r.summary.identified_calls],['confirmed',r.summary.confirmed],['pending',r.summary.pending],['errors',r.failed_reads]]) element('metric-'+id).textContent=count(value);
  element('metrics-observed').textContent=`Snapshot local · ${date(r.observed_at)} · intervalo de atualização: ${r.cache_seconds ?? 300} s`;
  const gaps=[];
  if(r.summary.undated!=='0')gaps.push(`${count(r.summary.undated)} registros sem data de chamada; fora do gráfico`);
  if(r.summary.missing_mapping!=='0')gaps.push(`${count(r.summary.missing_mapping)} mappings sem registro local`);
  if(r.summary.inconsistent&&r.summary.inconsistent!=='0')gaps.push(`${count(r.summary.inconsistent)} recibos divergentes`);
  element('metrics-error').textContent=gaps.join(' · ');
}

const terminalHistory = new WeakMap();
export function renderTerminal(root, entries, search, level, autoscroll = true) {
  const scroll=root.scrollTop,follow=autoscroll&&root.scrollHeight-root.clientHeight-scroll<=24;
  const top=root.getBoundingClientRect().top;
  const anchor=[...root.children].find(node=>node.getBoundingClientRect().bottom>top);
  const anchorKey=anchor?.getAttribute('data-event-key'),offset=anchor?.getBoundingClientRect().top-top;
  const visible=terminalRows(entries,search,level);
  const previous=terminalHistory.get(root);
  const existing=new Map([...root.children].map(node=>[node.getAttribute('data-event-key'),node]));
  const retainedKeys=new Set(visible.map(row=>row.key));
  for(const node of [...root.childNodes])if(node.nodeType!==1||!retainedKeys.has(node.getAttribute('data-event-key')))node.remove();
  if(!visible.length)root.textContent='Nenhum evento corresponde aos filtros.';
  for(const [position,item] of visible.entries()){
    let row=existing.get(item.key);
    if(!row){
    row=document.createElement('div');row.className='event-line';row.dataset.eventKey=item.key;
    if(previous?.size&&!previous.has(item.key))row.classList.add('event-new');
    for(const [index,[css,text]] of [['event-time',item.time],['event-level',item.severity],['event-name',item.event],['event-detail',item.detail]].entries()){
      if(index){const separator=document.createElement('span');separator.className='event-separator';separator.textContent=' | ';row.append(separator);}
      const span=document.createElement('span');span.className=css;
      if(css==='event-detail'){
        for(const fragment of text.split(/([a-z_]+=)/g)){
          const part=document.createElement('span');part.textContent=fragment;
          if(/^[a-z_]+=$/.test(fragment))part.className='event-param';
          span.append(part);
        }
      }else span.textContent=text;
      if(css==='event-level')span.dataset.level=item.severity;
      row.append(span);
    }
    }
    const at=root.children[position];
    if(at!==row)root.insertBefore(row,at||null);
  }
  terminalHistory.set(root,new Set(terminalRows(entries).map(row=>row.key)));
  if(follow)root.scrollTop=root.scrollHeight;
  else {
    const retained=[...root.children].find(node=>node.getAttribute('data-event-key')===anchorKey);
    root.scrollTop=retained?root.scrollTop+retained.getBoundingClientRect().top-top-offset:scroll;
  }
  return {visible:visible.length,total:entries.length};
}
