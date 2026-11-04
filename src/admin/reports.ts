import type { Pool } from 'pg';
import { DateTime } from 'luxon';
import { WorkerError } from '../errors.js';
import { quote } from '../schema.js';

export const reportZone = 'America/Sao_Paulo';
// Display-only policy. Keep parity with positive canonical AgentId + identified name;
// this module neither admits delivery nor rewrites mapped values.
export const reportWhitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export const reportPlaceholder = '^([0-9]+|-1|null|undefined|n/a|unknown|desconhecido|sem operador|sem agente|não identificado|nao identificado)$';
export function reportRange(from: unknown, to: unknown) {
  const parse = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? DateTime.fromISO(value, { zone: reportZone }) : DateTime.invalid('date');
  const start = parse(from), end = parse(to);
  if (!start.isValid || !end.isValid || end < start || end.diff(start, 'days').days >= 366) throw new WorkerError('REPORT_PERIOD_INVALID');
  return { from: start.toISODate()!, to: end.toISODate()! };
}

// Only the existing LOCAL pool. No corporate connection, consumer, advisory lock,
// credential service or operational mutation. At most one bounded query per repository.
export class AdminReports {
  private cached: { key: string; at: number; value: unknown } | undefined;
  private pending: { key: string; promise: Promise<unknown> } | undefined;
  constructor(private readonly pool: Pool, private readonly source: string,
    private readonly destination: { schema: string; table: string }) {}
  read(from: unknown, to: unknown): Promise<unknown> {
    const range = reportRange(from, to), key = `${range.from}/${range.to}`;
    if (this.cached?.key === key && Date.now() - this.cached.at < 30_000) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending.key === key ? this.pending.promise : Promise.reject(new WorkerError('REPORT_BUSY'));
    const promise = this.query(range).then(value => { this.cached = { key, at: Date.now(), value }; return value; })
      .finally(() => { this.pending = undefined; });
    this.pending = { key, promise }; return promise;
  }
  private async query(range: { from: string; to: string }) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query("SET LOCAL statement_timeout='5s'");
      await db.query("SET LOCAL lock_timeout='1s'");
      const hasOutbox = (await db.query("SELECT to_regclass('olos_http.corporate_outbox') IS NOT NULL AS present")).rows[0].present === true;
      const relation = `${quote(this.destination.schema)}.${quote(this.destination.table)}`;
      const delivery = hasOutbox ? `CASE WHEN o.source_id IS NULL THEN 'not_queued'
        WHEN o.target_id<>r.target_id OR o.source_hash<>r.source_hash THEN 'inconsistent'
        WHEN o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL THEN 'confirmed'
        WHEN o.state='pending' AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL THEN 'pending'
        ELSE 'inconsistent' END` : "'unavailable'::text";
      const counts = `count(*)::text AS calls,
        count(*) FILTER (WHERE identified)::text AS identified_calls,
        count(DISTINCT agent_id) FILTER (WHERE identified)::text AS operators,
        count(*) FILTER (WHERE has_cpf)::text AS with_cpf,
        count(*) FILTER (WHERE has_email)::text AS with_email,
        ${hasOutbox ? "count(*) FILTER (WHERE delivery='confirmed')::text" : 'NULL::text'} AS confirmed,
        ${hasOutbox ? "count(*) FILTER (WHERE delivery='pending')::text" : 'NULL::text'} AS pending,
        ${hasOutbox ? "count(*) FILTER (WHERE delivery='not_queued')::text" : 'NULL::text'} AS not_queued,
        ${hasOutbox ? "count(*) FILTER (WHERE delivery='inconsistent')::text" : 'NULL::text'} AS inconsistent`;
      const result = (await db.query(`WITH calls AS MATERIALIZED (
        SELECT r.source_id,r.agent_id,(d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          d.internal_id_olos IS NOT NULL AS mapped,
          coalesce(r.agent_id ~ '^[1-9][0-9]*$' AND btrim(d.nome_agente,$4)<>'' AND btrim(d.nome_agente,$4) !~* $5,false) AS identified,
          coalesce(btrim(d.cpf,$4)<>'',false) AS has_cpf,coalesce(btrim(d.email,$4)<>'',false) AS has_email,
          ${delivery} AS delivery
        FROM olos_http.records r LEFT JOIN ${relation} d ON d.internal_id_olos=r.target_id
        ${hasOutbox ? 'LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id' : ''}
        WHERE r.source_key=$1 AND r.target_table=$6
      ), summary AS (SELECT ${counts},count(*) FILTER (WHERE day IS NULL)::text AS undated,
          count(*) FILTER (WHERE NOT mapped)::text AS missing_mapping FROM calls),
      daily AS (SELECT day::text,${counts} FROM calls WHERE day BETWEEN $2::date AND $3::date GROUP BY day),
      period AS (SELECT ${counts} FROM calls WHERE day BETWEEN $2::date AND $3::date)
      SELECT (SELECT row_to_json(summary) FROM summary) AS summary,
        (SELECT row_to_json(period) FROM period) AS period,
        coalesce((SELECT json_agg(daily ORDER BY day) FROM daily),'[]') AS daily,
        (SELECT count(*)::text FROM olos_http.reads WHERE source_key=$1 AND error_code IS NOT NULL) AS failed_reads,
        transaction_timestamp() AS observed_at`, [this.source, range.from, range.to, reportWhitespace, reportPlaceholder, relation])).rows[0];
      return { ...result, from: range.from, to: range.to, timezone: reportZone, outbox_available: hasOutbox,
        confirmation_source: 'local_outbox_receipts', cache_seconds: 30 };
    } finally { await db.query('ROLLBACK').catch(() => {}); db.release(); }
  }
}
