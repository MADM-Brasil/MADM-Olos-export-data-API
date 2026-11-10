// Explicitly opt-in. This file never reads .env/DATABASE_URL or existing databases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pg from 'pg';
import { LegacyAdminReports as AdminReports, reportWhitespace, reportPlaceholder } from './fixtures/admin-reports-legacy.js';

const execFile = promisify(execFileCallback);
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Use REPORT_PERF=1 scripts/test-admin-reports.sh');
const parsed = new URL(url);
if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/olos_admin_reports_test') throw new Error('Disposable database required');
const container = process.env.REPORT_PERF_CONTAINER;
if (!container?.startsWith('olos-')) throw new Error('Labeled disposable container required');
const inspection = JSON.parse((await execFile('docker', ['inspect', container])).stdout) as { Config: { Labels: Record<string, string> }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } }[];
assert.equal(inspection[0]?.Config.Labels['olos-http.disposable-test'], 'true');
assert(inspection[0]?.NetworkSettings.Ports['5432/tcp']?.some(p => p.HostIp === '127.0.0.1' && p.HostPort === parsed.port));
const directory = process.env.REPORT_PERF_EVIDENCE ?? '/tmp/olos-reports-p0';
await mkdir(directory, { recursive: true });
const candidateSQL=await readFile('test/fixtures/admin-reports-candidate-p0.sql','utf8');
const source = 'perf', target = '"raw"."olos_calls"';
let pool = new pg.Pool({ connectionString: url });
interface Day extends pg.QueryResultRow { day: string | null; operator_ids: string[] | null }
interface Clock extends pg.QueryResultRow { present: boolean; start_at: Date; end_at: Date; collection_date: string }
interface Measurement { name: string; ms: number; error: string | null }
const measurements: Measurement[] = [];
const canonical = (rows: Day[]) => rows.map(row => ({ ...row, operator_ids: row.operator_ids ? [...row.operator_ids].sort() : null }));
const ranges = [1, 7, 15, 30, 366].map(days => ({ from: new Date(Date.UTC(2026, 10, 10) - (days - 1) * 86400000).toISOString().slice(0, 10), to: '2026-11-10' }));

function capture(clock: Clock, days: Day[] = [], diagnostic = false, onQuery?: (sql: string) => void) {
  let query = '', parameters: unknown[] = [];const settings:string[]=[];
  const fake = { async connect() { return { async query(sql: string, values?: unknown[]) {
    if(sql.startsWith('SET LOCAL '))settings.push(sql);
    if (sql.includes('to_regclass')) return { rows: [clock] };
    if (sql.startsWith('WITH classified')) { query = sql; parameters = values ?? []; return { rows: days }; }
    if (sql.includes('failed_reads')) return { rows: [{ failed_reads: '0', observed_at: new Date('2026-11-10T15:00:00Z') }] };
    return { rows: [] };
  }, release() {} }; } } as unknown as pg.Pool;
  const traced = { async connect() { const db = await pool.connect(); return { async query(sql: string, values?: unknown[]) {
    onQuery?.(sql);
    // Diagnostic budget ONLY for exact oracle comparison, never production/gate.
    return db.query(sql.startsWith('WITH classified')?candidateSQL:diagnostic && sql.startsWith('SET LOCAL statement_timeout') ? "SET LOCAL statement_timeout='60s'" : sql, values);
  }, release() { db.release(); } }; } } as unknown as pg.Pool;
  return { fake, traced, captured: () => ({ query, parameters, settings }) };
}

async function measure(name: string, action: () => Promise<unknown>) {
  const start = performance.now(); let error: string | null = null;
  try { await action(); } catch (e) {
    const candidate = e as { code?: string; message?: string };
    if (candidate.code !== 'REPORT_TIMEOUT' && candidate.code !== '57014') throw e;
    error = 'REPORT_TIMEOUT';
  }
  const measurement = { name, ms: Math.round(performance.now() - start), error };
  measurements.push(measurement); console.log('REPORT_PERF', JSON.stringify(measurement));
  return measurement;
}

async function restart() {
  await pool.end();
  await execFile('docker', ['restart', container!], { timeout: 30_000 });
  for (let attempt=0; ; attempt++) {
    try { await execFile('docker', ['exec', container!, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'olos_admin_reports_test'], { timeout: 10_000 }); break; }
    catch (error) { if (attempt===29) throw error; await delay(500); }
  }
  // Docker can reassign an ephemeral published port when restarting the container.
  const address=(await execFile('docker',['port',container!,'5432/tcp'])).stdout.trim();
  assert(address.startsWith('127.0.0.1:'));
  parsed.port=address.slice(address.lastIndexOf(':')+1);
  pool = new pg.Pool({ connectionString: parsed.toString() });
}

await test('2M exact reports, dense operators, plans, cold/warm/concurrent admission gate', async t => {
  try {
    if (process.env.REPORT_PERF_PREPARED === '1') {
      assert.equal((await pool.query("SELECT obj_description('raw'::regnamespace,'pg_namespace') AS marker")).rows[0]?.marker, 'olos disposable performance fixture v1');
    } else {
      await pool.query(await readFile('test/fixtures/admin-reports.sql', 'utf8'));
      // Ratios from the incident, scaled to 2M records. Payloads are synthetic.
      await pool.query(`INSERT INTO raw.olos_calls(internal_id_olos,data_ligacao,nome_agente,cpf,email,telefone,nome_campanha_olos) OVERRIDING SYSTEM VALUE
        SELECT n,'2025-11-11T03:00:00Z'::timestamptz+(n%365)*interval '1 day',CASE WHEN n%20=0 THEN 'UNKNOWN' ELSE 'Operador Teste '||((n/365)%1000) END,
        CASE WHEN n%3=0 THEN 'synthetic' END,CASE WHEN n%5=0 THEN 'synthetic@example.invalid' END,repeat('x',12),repeat('synthetic ',20) FROM generate_series(1,786460) n`);
      await pool.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,created_at)
        SELECT $1,n::text,$2,n,repeat('a',64),((n/365)%1000+1)::text,'2026-11-10T12:00:00Z'::timestamptz FROM generate_series(1,2000000) n`, [source, target]);
      await pool.query(`INSERT INTO olos_http.corporate_outbox(source_key,source_id,target_id,source_hash,payload,payload_hash,state,origin,remote_raw_id,confirmed_at)
        SELECT $1,n::text,n,repeat('a',64),jsonb_build_object('synthetic',repeat('sample ',80)),repeat('b',64),
        CASE WHEN n%3=0 THEN 'confirmed' WHEN n%17=0 THEN 'skipped' ELSE 'pending' END,'capture',CASE WHEN n%3=0 THEN n END,
        CASE WHEN n%3=0 THEN '2026-11-10T13:00:00Z'::timestamptz END FROM generate_series(1,1910290) n`, [source]);
      await pool.query("COMMENT ON SCHEMA raw IS 'olos disposable performance fixture v1'");
      for (const table of ['raw.olos_calls', 'olos_http.records', 'olos_http.corporate_outbox']) await pool.query(`VACUUM ANALYZE ${table}`);
      await pool.query('CHECKPOINT');
    }
    const counts = (await pool.query(`SELECT (SELECT count(*) FROM olos_http.records)::text records,
      (SELECT count(*) FROM olos_http.corporate_outbox)::text outbox,(SELECT count(*) FROM raw.olos_calls)::text destination`)).rows[0];
    assert.deepEqual(counts, { records: '2000000', outbox: '1910290', destination: '786460' });
    const environment = (await pool.query(`SELECT version(),current_setting('work_mem') work_mem,current_setting('shared_buffers') shared_buffers,
      current_setting('max_parallel_workers_per_gather') parallel_workers,pg_database_size(current_database())::text database_bytes`)).rows[0];
    const clock = (await pool.query<Clock>(`SELECT true AS present,(transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS collection_date,
      ((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS start_at,
      (((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS end_at`)).rows[0]!;
    const intercepted = capture(clock);
    await new AdminReports(intercepted.fake, source, { schema: 'raw', table: 'olos_calls' }).read(ranges[0]!.from, ranges[0]!.to);
    const modern = {...intercepted.captured(),query:candidateSQL};
    const old = await readFile('test/fixtures/admin-reports-pre-p0.sql', 'utf8');
    const parameters = [source, reportWhitespace, reportPlaceholder, target, clock.start_at, clock.end_at];
    let before: Day[] = [], after: Day[] = [];
    await t.test('same repeatable-read snapshot: every aggregate, operator ID union and today agree', async () => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await db.query("SET LOCAL statement_timeout='60s'"); await db.query('SET LOCAL jit=off');
        before = (await db.query<Day>(old, parameters)).rows;
        after = (await db.query<Day>(modern.query, parameters)).rows;
        assert.deepEqual(canonical(after), canonical(before));
      } finally { await db.query('ROLLBACK'); db.release(); }
      const beforeReader = new AdminReports(capture(clock, before).fake, source, { schema: 'raw', table: 'olos_calls' }, () => 0, () => clock.collection_date);
      const afterReader = new AdminReports(capture(clock, after).fake, source, { schema: 'raw', table: 'olos_calls' }, () => 0, () => clock.collection_date);
      for (const range of ranges) assert.deepEqual(await afterReader.read(range.from, range.to), await beforeReader.read(range.from, range.to));
      assert.deepEqual(await afterReader.today(), await beforeReader.today());
    });
    await t.test('estimated/executed plans with explicit diagnostic budget', async () => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='60s'");await db.query('SET LOCAL jit=off');
        for (const [name, sql] of [['before', old], ['after', modern.query]] as const) {
          if(name==='after')for(const setting of modern.settings.filter(s=>!s.includes('statement_timeout')))await db.query(setting);
          const estimated = (await db.query(`EXPLAIN (SETTINGS, FORMAT JSON) ${sql}`, parameters)).rows;
          await writeFile(`${directory}/${name}-estimated.json`, JSON.stringify(estimated, null, 2));
          const executed = (await db.query(`EXPLAIN (ANALYZE,BUFFERS,SETTINGS,TIMING OFF,FORMAT JSON) ${sql}`, parameters)).rows;
          await writeFile(`${directory}/${name}-executed.json`, JSON.stringify(executed, null, 2));
        }
      } finally { await db.query('ROLLBACK'); db.release(); }
    });
    // Actual AdminReports with candidate SQL injected by the test-only proxy, unchanged 5s statements. Each instance starts empty.
    for (let i = 0; i < 3; i++) {
      await restart();
      await measure(`cold-shared-buffers-${i + 1}`, () => new AdminReports(capture(clock).traced, source, { schema: 'raw', table: 'olos_calls' }).read(ranges[4]!.from, ranges[4]!.to));
      await measure(`warm-database-empty-app-cache-${i + 1}`, () => new AdminReports(capture(clock).traced, source, { schema: 'raw', table: 'olos_calls' }).read(ranges[i]!.from, ranges[i]!.to));
    }
    await t.test('one database query for concurrent ranges; warm application cache stays exact', async () => {
      let queries = 0;
      const diagnostic = capture(clock, [], true, sql => { if (sql.startsWith('WITH classified')) queries++; });
      const reader = new AdminReports(diagnostic.traced, source, { schema: 'raw', table: 'olos_calls' });
      // This test proves cache/coalescing/equivalence, NOT cold-read latency.
      const responses = await Promise.all(ranges.map(range => reader.read(range.from, range.to)));
      assert.equal(queries, 1);
      const start = performance.now();
      assert.deepEqual(await Promise.all(ranges.map(range => reader.read(range.from, range.to))), responses);
      assert.equal(queries, 1);
      measurements.push({ name: 'warm-application-cache-five-ranges', ms: Math.round(performance.now() - start), error: null });
    });
    await t.test('concurrent receipt updates cannot change an already acquired snapshot', async () => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='60s'");await db.query('SET LOCAL jit=off');
        await db.query('SELECT count(*) FROM olos_http.reads'); // deterministic snapshot boundary
        await pool.query("UPDATE olos_http.corporate_outbox SET state='confirmed',remote_raw_id=1,confirmed_at=now() WHERE source_key=$1 AND source_id='1'", [source]);
        assert.deepEqual(canonical((await db.query<Day>(modern.query, parameters)).rows), canonical(after));
        await db.query('ROLLBACK');
        await db.query("SET statement_timeout='60s'");await db.query('SET jit=off');
        const fresh = (await db.query<Day>(modern.query, parameters)).rows;
        assert.notDeepEqual(canonical(fresh), canonical(after));
      } finally {
        await db.query('ROLLBACK');await db.query('RESET statement_timeout');await db.query('RESET jit');db.release();
        await pool.query("UPDATE olos_http.corporate_outbox SET state='pending',remote_raw_id=NULL,confirmed_at=NULL WHERE source_key=$1 AND source_id='1'", [source]);
      }
    });
    // Gate-controlled simulated operational transaction (no real ingestion code).
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("UPDATE olos_http.corporate_outbox SET source_hash='synthetic-concurrent' WHERE source_key=$1 AND source_id='2'", [source]);
      const pending = measure('concurrent-uncommitted-receipt-write', () => new AdminReports(capture(clock).traced, source, { schema: 'raw', table: 'olos_calls' }).read(ranges[3]!.from, ranges[3]!.to));
      await pending;
    } finally { await writer.query('ROLLBACK'); writer.release(); }
    await writeFile(`${directory}/summary.json`, JSON.stringify({ synthetic: true, candidate_adopted:false, counts, environment, query_settings:modern.settings,
      cold_definition: 'PostgreSQL restarted; host OS cache is not dropped', statement_timeout_ms: 5000,
      diagnostic_timeout_ms: 60000, required_margin_ms: 1000, measurements }, null, 2));
    await t.test('P0 gate: all fresh reads have at least 1s margin below 5s, not just a cached success', () => {
      const fresh = measurements.filter(m => m.name !== 'warm-application-cache-five-ranges');
      assert(fresh.every(m => m.error === null && m.ms < 4000), JSON.stringify(fresh));
    });
  } finally { await pool.end(); }
});
