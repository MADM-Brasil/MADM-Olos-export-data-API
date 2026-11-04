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
const numericFields = new Set(['received','inserted','updated','duplicates','duration_ms','request_ms','persistence_ms','interval_ms','retry_ms','port','queued','confirmed']);
export function safeEvents(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(-200).filter(e => e && events.has(e.event)).map(e => {
    const safe = { event: e.event, time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.time) ? e.time : null };
    for (const [key,value] of Object.entries(e)) {
      if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      if (['enabled','blocked'].includes(key) && typeof value === 'boolean') safe[key] = value;
      if (key === 'error' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value)) safe[key] = value;
      if (key === 'read_id' && typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) safe[key] = value;
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
  return entries.filter(e => e.event.toLowerCase().includes(search.toLowerCase()) && (level === 'ALL' || eventLevel(e) === level))
    .map(e => `[${date(e.time)} Brasília] ${eventLevel(e)} ${e.event} ${Object.entries(e).filter(([k]) => !['event','time'].includes(k)).map(([k,v]) => `${k}=${v}`).join(' ')}`);
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
