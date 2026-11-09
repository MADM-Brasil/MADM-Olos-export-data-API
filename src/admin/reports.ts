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

// Counts stay decimal strings at the API boundary. Never round through Number.
const countFields = ['calls', 'identified_calls', 'with_cpf', 'with_email',
  'confirmed', 'pending', 'not_queued', 'inconsistent', 'missing_mapping'] as const;
type CountField = typeof countFields[number];
type Day = Record<CountField, string> & { day: string | null; operator_ids: string[] | null; collected_today: string };
type Snapshot = { days: Day[]; failed_reads: string; observed_at: Date; outbox_available: boolean; collection_date: string };
export const reportCacheSeconds = 300;
export const reportStatementTimeoutMs = 5_000;

// Full, read-only snapshots: late mappings, old receipts and backfilled calls can all
// change. A created_at watermark or additive daily counter would silently miss them.
export class AdminReports {
  private cached: { at: number; value: Snapshot } | undefined;
  private pending: Promise<Snapshot> | undefined;
  private failure: { at: number; day: string; error: unknown } | undefined;
  constructor(private readonly pool: Pool, private readonly source: string,
    private readonly destination: { schema: string; table: string },
    private readonly now: () => number = () => performance.now(),
    private readonly calendarDay: () => string = () => DateTime.now().setZone(reportZone).toISODate()!) {}

  async read(from: unknown, to: unknown): Promise<unknown> {
    const range = reportRange(from, to);
    const snapshot = await this.snapshot();
    const daily = snapshot.days.filter(d => d.day !== null && d.day >= range.from && d.day <= range.to);
    const summary = this.total(snapshot.days, snapshot.outbox_available);
    return { summary: { ...summary,
        undated: snapshot.days.find(d => d.day === null)?.calls ?? '0',
        missing_mapping: this.sum(snapshot.days, 'missing_mapping') },
      period: this.total(daily, snapshot.outbox_available),
      daily: daily.map(d => ({ day: d.day, ...this.total([d], snapshot.outbox_available) })),
      failed_reads: snapshot.failed_reads, observed_at: snapshot.observed_at,
      ...range, timezone: reportZone, outbox_available: snapshot.outbox_available,
      confirmation_source: 'local_outbox_receipts', cache_seconds: reportCacheSeconds };
  }
  async today() {
    const snapshot = await this.snapshot();
    return { date: snapshot.collection_date,
      calls: snapshot.days.reduce((n, day) => n + BigInt(day.collected_today), 0n).toString(),
      observed_at: snapshot.observed_at, timezone: reportZone, cache_seconds: reportCacheSeconds,
      time_basis: 'first_local_persistence', identity: 'source_key/source_id' };
  }
  private sum(days: Day[], field: CountField) {
    return days.reduce((n, day) => n + BigInt(day[field]), 0n).toString();
  }
  private total(days: Day[], outbox: boolean) {
    const counts = Object.fromEntries(countFields.filter(f => f !== 'missing_mapping')
      .map(f => [f, !outbox && ['confirmed', 'pending', 'not_queued', 'inconsistent'].includes(f) ? null : this.sum(days, f)]));
    // Operators are a union, NEVER the sum of per-day distinct counts. IDs remain
    // private to this repository snapshot and are not exposed by the HTTP API.
    const operators = new Set<string>();
    for (const day of days) for (const id of day.operator_ids ?? []) operators.add(id);
    return { ...counts, operators: String(operators.size) };
  }
  private snapshot(): Promise<Snapshot> {
    if (this.cached && this.cached.value.collection_date === this.calendarDay() && this.now() - this.cached.at < reportCacheSeconds * 1000) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    if (this.failure && this.failure.day === this.calendarDay() && this.now() - this.failure.at < reportCacheSeconds * 1000) return Promise.reject(this.failure.error);
    this.pending = this.query().then(value => {
      this.cached = { at: this.now(), value }; this.failure = undefined; return value;
    }, error => {
      // No stale snapshot masquerading as current, and no retry storm every 30s.
      this.failure = { at: this.now(), day: this.calendarDay(), error }; throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async query(): Promise<Snapshot> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query(`SET LOCAL statement_timeout='${reportStatementTimeoutMs}ms'`);
      await db.query("SET LOCAL lock_timeout='1s'");
      // Compilation/optimization of this multi-aggregate plan can consume the
      // short reporting budget itself. Scope to this read-only transaction only.
      await db.query('SET LOCAL jit=off');
      const clock = (await db.query(`SELECT to_regclass('olos_http.corporate_outbox') IS NOT NULL AS present,
        (transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS collection_date,
        ((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS start_at,
        (((transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS end_at`)).rows[0];
      const hasOutbox = clock.present === true;
      const relation = `${quote(this.destination.schema)}.${quote(this.destination.table)}`;
      const delivery = hasOutbox ? `CASE WHEN o.source_id IS NULL THEN 'not_queued'
        WHEN o.target_id<>r.target_id OR o.source_hash<>r.source_hash THEN 'inconsistent'
        WHEN o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL THEN 'confirmed'
        WHEN o.state='pending' AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL THEN 'pending'
        ELSE 'inconsistent' END` : "'unavailable'::text";
      // Aggregate equivalent day/ID/name/receipt groups before running regexes.
      // Names are used only in SQL; the original identification rule is applied
      // to every distinct identity, then unidentified identities collapse together.
      // Delivery is classified once per row. No per-call CTE materialization or
      // DISTINCT sort; only aggregate rows reach the process.
      const days = (await db.query<Day>(`WITH classified AS NOT MATERIALIZED (
        SELECT (d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          r.agent_id, btrim(d.nome_agente,$2) AS agent_name,
          r.created_at >= $5::timestamptz AND r.created_at < $6::timestamptz AS collected_today,
          d.internal_id_olos IS NOT NULL AS mapped,
          coalesce(btrim(d.cpf,$2)<>'',false) AS has_cpf,
          coalesce(btrim(d.email,$2)<>'',false) AS has_email, ${delivery} AS delivery
        FROM olos_http.records r LEFT JOIN ${relation} d ON d.internal_id_olos=r.target_id
        ${hasOutbox ? 'LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id' : ''}
        WHERE r.source_key=$1 AND r.target_table=$4
      ), per_identity AS (
        SELECT day, agent_id, agent_name, delivery, count(*) AS calls,
          count(*) FILTER (WHERE collected_today) AS collected_today,
          count(*) FILTER (WHERE has_cpf) AS with_cpf,
          count(*) FILTER (WHERE has_email) AS with_email,
          count(*) FILTER (WHERE NOT mapped) AS missing_mapping
        FROM classified GROUP BY day, agent_id, agent_name, delivery
      ), per_operator AS (
        SELECT day, CASE WHEN agent_id ~ '^[1-9][0-9]*$' AND agent_name<>''
          AND agent_name !~* $3 THEN agent_id END AS identified_agent, sum(calls) AS calls,
          sum(collected_today) AS collected_today,
          sum(with_cpf) AS with_cpf, sum(with_email) AS with_email,
          coalesce(sum(calls) FILTER (WHERE delivery='confirmed'),0) AS confirmed,
          coalesce(sum(calls) FILTER (WHERE delivery='pending'),0) AS pending,
          coalesce(sum(calls) FILTER (WHERE delivery='not_queued'),0) AS not_queued,
          coalesce(sum(calls) FILTER (WHERE delivery='inconsistent'),0) AS inconsistent,
          sum(missing_mapping) AS missing_mapping
        FROM per_identity GROUP BY day, identified_agent
      ) SELECT day::text,
        sum(calls)::text AS calls, sum(collected_today)::text AS collected_today,
        coalesce(sum(calls) FILTER (WHERE identified_agent IS NOT NULL),0)::text AS identified_calls,
        array_agg(identified_agent) FILTER (WHERE identified_agent IS NOT NULL) AS operator_ids,
        sum(with_cpf)::text AS with_cpf, sum(with_email)::text AS with_email,
        sum(confirmed)::text AS confirmed, sum(pending)::text AS pending,
        sum(not_queued)::text AS not_queued, sum(inconsistent)::text AS inconsistent,
        sum(missing_mapping)::text AS missing_mapping
      FROM per_operator GROUP BY day ORDER BY day`, [this.source, reportWhitespace, reportPlaceholder, relation, clock.start_at, clock.end_at])).rows;
      const meta = (await db.query(`SELECT count(*)::text AS failed_reads,
        transaction_timestamp() AS observed_at FROM olos_http.reads
        WHERE source_key=$1 AND error_code IS NOT NULL`, [this.source])).rows[0];
      return { days, ...meta, outbox_available: hasOutbox, collection_date: clock.collection_date };
    } catch (error) {
      if ((error as { code?: string })?.code === '57014') throw new WorkerError('REPORT_TIMEOUT');
      throw error;
    } finally { await db.query('ROLLBACK').catch(() => {}); db.release(); }
  }
}
