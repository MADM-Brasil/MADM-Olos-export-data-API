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
export function renderChart(root, rows, from, to) {
  root.replaceChildren();
  if (!rows.length) { root.textContent = 'Nenhuma chamada encontrada neste período.'; return; }
  const byDay = new Map(rows.map(r => [r.day,r]));
  const series = [], cursor = new Date(`${from}T12:00:00Z`), end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end && series.length < 366) {
    const key = cursor.toISOString().slice(0,10);
    series.push(byDay.get(key) || { day:key,calls:'0',identified_calls:'0' }); cursor.setUTCDate(cursor.getUTCDate()+1);
  }
  const max = Math.max(1,...series.map(r => Number(r.calls))), width = Math.max(300,root.clientWidth || 960), height = 260, left = 62, bottom = 225, top = 22;
  const svg = svgNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':`Chamadas diárias de ${dayLabel(from)} a ${dayLabel(to)}. Barras verdes: chamadas únicas e com operador. Consulte Relatórios para valores tabulados.`});
  for (let i=0;i<=4;i++) {
    const y=bottom-(bottom-top)*i/4;
    svg.append(svgNode('line',{x1:left,y1:y,x2:width-10,y2:y,class:'grid-line'}),svgNode('text',{x:left-10,y:y+4,'text-anchor':'end'},new Intl.NumberFormat('pt-BR',{notation:'compact',maximumFractionDigits:1}).format(max*i/4)));
  }
  const step=(width-left-10)/series.length;
  series.forEach((r,i) => {
    const x=left+i*step+step*.17,w=Math.max(1,step*.55);
    for (const [field,css,factor] of [['calls','calls-bar',1],['identified_calls','operators-bar',.4]]) {
      const h=Number(r[field])/max*(bottom-top);
      const bar=svgNode('rect',{x,y:bottom-h,width:w*Number(factor),height:h,rx:2,class:css});
      bar.append(svgNode('title',{},`${dayLabel(r.day)} · ${count(r.calls)} chamadas · ${count(r.identified_calls)} com operador`));svg.append(bar);
    }
    if(i%Math.max(1,Math.ceil(series.length/(width<500?4:7)))===0)svg.append(svgNode('text',{x:x+w/2,y:248,'text-anchor':'middle'},dayLabel(r.day).slice(0,5)));
  });root.append(svg);
}

// A chart failure must never invalidate a successfully fetched count snapshot.
export function renderDashboardChart(root, snapshot, draw = renderChart) {
  try { draw(root, snapshot.daily, snapshot.from, snapshot.to); }
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
  element('chart-period').textContent=`${dayLabel(r.from)} — ${dayLabel(r.to)} · Brasília`;
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
