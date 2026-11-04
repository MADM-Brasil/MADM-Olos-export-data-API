// Synthetic benchmark only; never load environment files or connect to a real DB.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { Config } from '../src/config.js';
import { columns, digest, type Row } from '../src/corporate-sync/mapping.js';
import { drainSelection } from '../src/corporate-delivery/drain-selection.js';
import { historyPeriod } from '../src/corporate-delivery/history-period.js';
import { identifiedAgentPattern, operatorNameWhitespace, operatorNamePlaceholderPattern } from '../src/corporate-delivery/identified-operator.js';
import { preservedHistoryRead } from '../src/corporate-delivery/preserved-history.js';

export async function applyDrainIndex(db: pg.Client) {
  // Explicit fixture/DDL budget, separate from the unchanged 2-second selector.
  await db.query("SET statement_timeout='60s'; SET lock_timeout='2s'");
  const sql=await readFile(new URL('../migrations/008_drain_operator_index.sql',import.meta.url),'utf8');
  try { for(const statement of sql.split('-- statement-breakpoint')) await db.query(statement); }
  finally { await db.query('SELECT pg_advisory_unlock_all()'); await db.query("SET statement_timeout='2s'"); }
}

// Frozen comparison query from published 1e50a89, including row locks and casts.
function baseline(source:string,limit:number,period:ReturnType<typeof historyPeriod>) {
  return {text:`SELECT o.source_id FROM olos_http.corporate_outbox o
    JOIN olos_http.records r USING(source_key,source_id) JOIN olos_http.reads h ON h.id=$2
    WHERE o.source_key=$1 AND o.state='pending' AND ((o.created_at<h.started_at AND r.created_at<h.started_at) OR EXISTS(
      SELECT 1 FROM olos_http.history_gap_members gm JOIN olos_http.reads gr ON gr.id=gm.read_id
      WHERE gm.source_key=o.source_key AND gm.source_id=o.source_id AND gr.state='done'))
    AND o.target_id::text=o.source_id AND r.target_id=o.target_id
    AND r.agent_id ~ $4 AND jsonb_typeof(o.payload->'nome_agente')='string'
    AND btrim(o.payload->>'nome_agente',$5)<>'' AND btrim(o.payload->>'nome_agente',$5) !~* $6
    AND jsonb_typeof(o.payload->'data_ligacao')='string' AND o.payload->>'data_ligacao' ~ $7
    AND (o.payload->>'data_ligacao') COLLATE "C" >= $8 AND (o.payload->>'data_ligacao') COLLATE "C" < $9
    ORDER BY o.target_id LIMIT $3 FOR UPDATE OF o,r NOWAIT`,
    values:[source,preservedHistoryRead,limit,identifiedAgentPattern,operatorNameWhitespace,operatorNamePlaceholderPattern,period.pattern,period.start,period.end]};
}
function nodes(plan:any):any[] {return [plan,...(plan.Plans??[]).flatMap(nodes)];}
const emit=(data:unknown)=>console.log('DRAIN_BENCH '+JSON.stringify(data));

export async function benchmarkDrainSelection(db:pg.Client,cfg:Config,distribution:'uniform'|'tail') {
  assert.equal(process.env.OLOS_DIRECT_DISPOSABLE_TEST,'true');
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,'olos_direct_test');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM olos_http.records')).rows[0].n,2);
  const control=(await db.query('SELECT * FROM olos_http.corporate_control')).rows[0];
  const period=historyPeriod(new Map(control.destination_shape));
  const template=(await db.query('SELECT payload FROM olos_http.corporate_outbox LIMIT 1')).rows[0].payload;
  const positive=distribution==='uniform'?'g%64=0':'g>725285-11259';
  // Includes automatic attempts, invalid IDs, missing/placeholder names, dates
  // outside September/October, old target IDs and post-parent unproven records.
  await db.query("SET statement_timeout='60s'");
  await db.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,campaign_id,disposition_id,created_at)
    SELECT $1,(2000000+g)::text,'"raw"."olos_calls"',2000000+g+CASE WHEN g%29=0 THEN 900000000 ELSE 0 END,
      repeat('a',64),CASE WHEN ${positive} THEN '7' WHEN g%257=0 THEN '007' WHEN g%13=0 THEN '-1' ELSE '0' END,'8','9',
      h.started_at+CASE WHEN g%19=0 THEN interval '1 minute' ELSE interval '-1 hour' END
    FROM generate_series(1,725285) g JOIN olos_http.reads h ON h.id=$2`,[cfg.sourceKey,preservedHistoryRead]);
  const serialized=columns.map(c=>`(p.payload->'${c}')::text`).join("||','||");
  // Bounded fixture loading, not part of the measured selector. Materialize
  // each JSON payload once instead of rebuilding it for each hash field.
  for(let start=2000001;start<2725286;start+=25000)await db.query(`WITH payloads AS MATERIALIZED (
    SELECT r.*,r.source_id::bigint-2000000 AS g, $2::jsonb || jsonb_build_object(
      'internal_id_olos',r.target_id::text,'olos_call_id',r.source_id,'telefone',lpad(r.source_id,11,'0'),
      'nome_agente',CASE WHEN r.agent_id='7' THEN CASE WHEN r.source_id::bigint%11=0 THEN 'Sem operador'
        WHEN r.source_id::bigint%13=0 THEN NULL ELSE 'Synthetic Operator' END ELSE NULL END,
      'data_ligacao',CASE WHEN r.source_id::bigint%17=0 THEN '2026-11-01T03:00:00.000000Z'
        WHEN r.source_id::bigint%2=0 THEN '2026-09-15T13:00:00.000000Z' ELSE '2026-10-15T13:00:00.000000Z' END,
      'cpf',NULL,'email',NULL,'lead_id_origem',NULL) AS payload
    FROM olos_http.records r WHERE r.source_key=$1 AND r.source_id >= $3 AND r.source_id < $4)
    INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,origin,created_at)
    SELECT p.source_key,p.source_id,p.target_id,p.source_hash,p.payload,
      encode(sha256(convert_to('['||${serialized}||']','UTF8')),'hex'),'capture',
      h.started_at+CASE WHEN p.g%23=0 THEN interval '1 minute' ELSE interval '-1 hour' END
    FROM payloads p JOIN olos_http.reads h ON h.id=$5`,[cfg.sourceKey,template,String(start),String(Math.min(start+25000,2725286)),preservedHistoryRead]);
  await db.query('ANALYZE olos_http.records; ANALYZE olos_http.corporate_outbox');
  await db.query("SET statement_timeout='2s'");
  const counts=(await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE agent_id ~ '${identifiedAgentPattern}')::int AS operators
    FROM olos_http.records`)).rows[0];
  const sizes=(await db.query(`SELECT pg_size_pretty(pg_total_relation_size('olos_http.records')) AS records,
    pg_size_pretty(pg_total_relation_size('olos_http.corporate_outbox')) AS outbox`)).rows[0];
  emit({distribution,counts,sizes,settings:(await db.query(`SELECT version(),current_setting('shared_buffers') AS shared_buffers,
    current_setting('work_mem') AS work_mem,current_setting('statement_timeout') AS statement_timeout`)).rows[0]});
  for(const r of (await db.query("SELECT payload,payload_hash FROM olos_http.corporate_outbox WHERE source_id::bigint>=2000001 ORDER BY target_id LIMIT 10")).rows) {
    assert.equal(digest(r.payload as Row),r.payload_hash);
  }
  const expected=new Map<number,string[]>();
  for(const phase of ['before','index_only','optimized'] as const){
    if(phase==='index_only'){
      const start=performance.now();await applyDrainIndex(db);
      emit({distribution,index_build_ms:performance.now()-start,index:(await db.query(`SELECT pg_size_pretty(pg_relation_size('olos_http.records_identified_operator_order')) AS size`)).rows[0]});
    }
    for(const limit of [100,250,500,1000]){
      const query=phase==='optimized'?drainSelection(cfg.sourceKey,limit,period,true):baseline(cfg.sourceKey,limit,period);
      for(let repeat=0;repeat<3;repeat++){
        await db.query('BEGIN');
        try{
          const start=performance.now();
          const explained=(await db.query({text:'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query.text,values:query.values})).rows[0]['QUERY PLAN'][0];
          const flat=nodes(explained.Plan);
          emit({distribution,phase,limit,repeat,wall_ms:performance.now()-start,planning_ms:explained['Planning Time'],execution_ms:explained['Execution Time'],
            cost:explained.Plan['Total Cost'],shared_hit:explained.Plan['Shared Hit Blocks'],shared_read:explained.Plan['Shared Read Blocks'],
            nodes:flat.map(p=>({type:p['Node Type'],relation:p['Relation Name'],index:p['Index Name'],rows:p['Actual Rows'],loops:p['Actual Loops']})),
            ...(repeat===0?{explain:explained}:{})});
          const ids=(await db.query(query)).rows.map(r=>r.source_id as string);
          if(expected.has(limit))assert.deepEqual(ids,expected.get(limit));else expected.set(limit,ids);
          assert.equal(ids.length,limit);
          if(phase==='optimized')assert.ok(flat.some(p=>p['Index Name']==='records_identified_operator_order'),'partial index not used');
        }catch(error){
          if(phase!=='before'||(error as {code?:string}).code!=='57014')throw error;
          emit({distribution,phase,limit,repeat,timeout_ms:2000,sqlstate:'57014'});
        }finally{await db.query('ROLLBACK');}
      }
    }
  }
  // The literal also makes the index available for generic prepared plans.
  await db.query("SET plan_cache_mode='force_generic_plan'");
  const q=drainSelection(cfg.sourceKey,100,period,true);
  await db.query('BEGIN');
  try {
    const ids=(await db.query({name:'drain-benchmark-generic',...q})).rows.map(r=>r.source_id as string);
    assert.deepEqual(ids,expected.get(100));
    const generic=(await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE "drain-benchmark-generic" (${q.values.map(v=>db.escapeLiteral(String(v))).join(',')})`)).rows[0]['QUERY PLAN'][0];
    const prepared=(await db.query("SELECT generic_plans,custom_plans FROM pg_prepared_statements WHERE name='drain-benchmark-generic'")).rows[0];
    assert.ok(Number(prepared.generic_plans)>0);assert.equal(Number(prepared.custom_plans),0);
    assert.ok(nodes(generic.Plan).some(p=>p['Index Name']==='records_identified_operator_order'));
    emit({distribution,phase:'generic',prepared,execution_ms:generic['Execution Time'],explain:generic});
  } finally {await db.query('ROLLBACK');await db.query("SET plan_cache_mode='auto'");}
}
