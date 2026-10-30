import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { type Config } from './config.js';
import { type ReadSpec, rows } from './api.js';
import { columns, type Cache, type MappedRecord, mapRecord } from './mapping.js';
import { WorkerError } from './errors.js';
import { assertSchema, quote } from './schema.js';
import { lockSource } from './source-lock.js';
import { CorporateDelivery } from './corporate-delivery/delivery.js';
import { assertNoDirectOwnership } from './corporate-sync/ownership.js';

type Read = { id: string; spec: ReadSpec; state: string; response_body: string | null; processed_count: number; request_ms: number | null };
export class Store {
  readonly pool: pg.Pool;
  client: pg.PoolClient | undefined;
  private sequence = '';
  private alive = false;
  readonly target: string;
  readonly delivery: CorporateDelivery | undefined;
  constructor(readonly cfg: Config, private readonly onDisconnect: () => void = () => {}) {
    this.target = `${quote(cfg.schema)}.${quote(cfg.table)}`;
    this.pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: cfg.poolMax,
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000,
      application_name: 'olos-exportdata-v3-http' });
    this.pool.on('error', () => { this.alive = false; this.onDisconnect(); });
    if (cfg.corporateDelivery && cfg.poolMax < 2) throw new WorkerError('CORPORATE_LOCAL_POOL_REQUIRES_TWO_CONNECTIONS');
    this.delivery = cfg.corporateDelivery ? new CorporateDelivery(cfg.corporateDelivery, cfg.sourceKey, this.target, this.pool,
      () => this.alive, () => { this.alive = false; this.onDisconnect(); }) : undefined;
  }
  async open() {
    this.client = await this.pool.connect();
    this.client.on('error', () => { this.alive = false; this.onDisconnect(); });
    await lockSource(this.client, this.cfg.sourceKey);
    this.alive = true;
    if (this.delivery) await this.delivery.open(this.client);
    else await assertNoDirectOwnership(this.client);
    const schema = await assertSchema(this.client, this.cfg.schema, this.cfg.table);
    this.sequence = schema.sequence!;
    for (const table of ['olos_http.reads', 'olos_http.records']) {
      for (const privilege of ['SELECT','INSERT','UPDATE']) {
        if (!(await this.client.query('SELECT has_table_privilege($1,$2) AS ok',[table,privilege])).rows[0].ok) throw new WorkerError('CONTROL_PRIVILEGE_REQUIRED');
      }
    }
    await this.client.query("SET TIME ZONE 'UTC'");
    const mismatch = await this.client.query('SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND target_table<>$2 LIMIT 1', [this.cfg.sourceKey, this.target]);
    if (mismatch.rowCount) throw new WorkerError('SOURCE_DESTINATION_BINDING_CHANGED');
    const untracked = await this.client.query(`SELECT 1 FROM ${this.target} d WHERE NOT EXISTS
      (SELECT 1 FROM olos_http.records r WHERE r.target_table=$1 AND r.target_id=d.internal_id_olos) LIMIT 1`, [this.target]);
    if (untracked.rowCount) throw new WorkerError('EXISTING_DESTINATION_REQUIRES_BASELINE');
  }
  private db() {
    if (!this.client || !this.alive) throw new WorkerError('DATABASE_SESSION_LOST');
    return this.client;
  }
  async ping() { await this.db().query('SELECT 1'); }
  async captureReady() { await this.delivery?.captureReady(this.db()); }
  async reconcileCorporate() {
    if (!this.delivery) throw new WorkerError('CORPORATE_MODE_REQUIRED');
    return this.delivery.reconcile(this.db(), this.sequence);
  }
  async unresolved() {
    return (await this.db().query<Read>("SELECT id,spec,state,response_body,processed_count,request_ms FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received') ORDER BY started_at", [this.cfg.sourceKey])).rows;
  }
  async beginRead(spec: ReadSpec, recovery = false) {
    await this.captureReady();
    const pending = await this.unresolved();
    if (pending.some(r => r.state === 'received') || (!recovery && pending.length)) throw new WorkerError('RECOVERY_REQUIRED');
    const id = randomUUID();
    await this.db().query('INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES ($1,$2,$3,$4)', [id, this.cfg.sourceKey, this.target, JSON.stringify(spec)]);
    return id;
  }
  async validateRecoveryRead(parentId: string, spec: ReadSpec) {
    if (spec.kind !== 'reread') throw new WorkerError('RECOVERY_SPEC_REQUIRED');

    // Limites autorizados para a recuperação de 28/10/2026.
    // Remover esta restrição específica após concluir a homologação.
    const authorizedParent = '5ec94595-11a0-469b-9e1e-c4c801e0479f';
    const authorizedDate = '2026-10-28';
    const authorizedStart = 46671511n;
    const authorizedEnd = 46800030n;

    if (parentId !== authorizedParent ||
        spec.date !== authorizedDate ||
        BigInt(spec.start) < authorizedStart ||
        BigInt(spec.end) > authorizedEnd) {
      throw new WorkerError('RECOVERY_OUTSIDE_AUTHORIZED_RANGE');
    }

    const pending = await this.unresolved();
    const original = pending.find(r => r.id === parentId);

    if (!original || original.state !== 'reading' ||
        original.spec.kind !== 'current') {
      throw new WorkerError('ORIGINAL_READ_NOT_FOUND');
    }

    if (pending.some(r => r.state === 'reading' && r.id !== parentId)) {
      throw new WorkerError('RECOVERY_REQUIRED');
    }

    const previous = await this.db().query(
      "SELECT spec FROM olos_http.reads WHERE source_key=$1 AND target_table=$2 AND spec->>'kind'='reread'",
      [this.cfg.sourceKey, this.target]
    );

    for (const row of previous.rows) {
      const other = row.spec;
      if (other.date !== spec.date) continue;

      if (BigInt(spec.start) <= BigInt(other.end) &&
          BigInt(spec.end) >= BigInt(other.start)) {
        throw new WorkerError('RECOVERY_RANGE_OVERLAP');
      }
    }

  }

  async beginRecoveryRead(parentId: string, spec: ReadSpec) {
    await this.captureReady();
    await this.validateRecoveryRead(parentId, spec);
    const id = randomUUID();
    await this.db().query(
      'INSERT INTO olos_http.reads(id,source_key,target_table,spec) VALUES ($1,$2,$3,$4)',
      [id, this.cfg.sourceKey, this.target, JSON.stringify(spec)]
    );
    return id;
  }

  async stage(id: string, body: string, requestMs: number) {
    const result = await this.db().query("UPDATE olos_http.reads SET response_body=$2,state='received',request_ms=$3 WHERE id=$1 AND source_key=$4 AND state='reading'", [id, body, requestMs, this.cfg.sourceKey]);
    if (result.rowCount !== 1) throw new WorkerError('READ_STATE_CONFLICT');
  }
  async markError(id: string, code: string) {
    await this.db().query('UPDATE olos_http.reads SET error_code=$2 WHERE id=$1 AND source_key=$3', [id, code, this.cfg.sourceKey]);
  }
  async rejected(id: string, code: string) {
    await this.db().query("UPDATE olos_http.reads SET state='resolved',finished_at=clock_timestamp(),error_code=$2,resolution='HTTP explicit rejection; no successful response' WHERE id=$1 AND source_key=$3 AND state='reading'", [id, code, this.cfg.sourceKey]);
  }
  async drain(cache: Cache) {
    const total: { received: number; inserted: number; updated: number; duplicates: number; queued?: number } =
      { received: 0, inserted: 0, updated: 0, duplicates: 0, ...(this.delivery ? { queued: 0 } : {}) };
    for (const read of await this.unresolved()) {
      if (read.state !== 'received') continue;
      const data = rows(read.response_body!);
      total.received += data.length;
      // Validate the whole response before writing any target rows. Raw response is already durable.
      for (const row of data) {
        const mapped = mapRecord(row, cache, this.cfg.sourceTimeZone, !!this.delivery);
        if (read.spec.kind === 'reread' && (BigInt(mapped.source_id) < BigInt(read.spec.start) || BigInt(mapped.source_id) > BigInt(read.spec.end))) throw new WorkerError('RECOVERY_RESPONSE_OUTSIDE_RANGE');
      }
      for (let offset = read.processed_count; offset < data.length; offset += this.cfg.batchSize) {
        const mapped = data.slice(offset, offset + this.cfg.batchSize)
          .map(row => mapRecord(row, cache, this.cfg.sourceTimeZone, !!this.delivery));

        const baseline = this.cfg.ingestionBaseline;

        const batch = baseline
          ? mapped.filter(row =>
              row.data_ligacao !== null &&
              Date.parse(row.data_ligacao) >= Date.parse(baseline))
          : mapped;

        const result = await this.persist(
          read.id,
          batch,
          offset + mapped.length,
          data.length
        );
        total.inserted += result.inserted; total.updated += result.updated; total.duplicates += result.duplicates;
        if ('queued' in result && result.queued !== undefined) total.queued = (total.queued ?? 0) + result.queued;
      }
      await this.db().query("UPDATE olos_http.reads SET state='done',finished_at=clock_timestamp(),received_count=$2 WHERE id=$1 AND source_key=$3 AND processed_count=$2", [read.id, data.length, this.cfg.sourceKey]);
    }
    return total;
  }
  private async persist(readId: string, input: MappedRecord[], processed: number, received: number) {
    const db = this.db();
    const unique = new Map<string, MappedRecord>();
    for (const row of input) {
      if (unique.has(row.source_id) && unique.get(row.source_id)!.source_hash !== row.source_hash) throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
      unique.set(row.source_id, row);
    }
    const batch = [...unique.values()];

    if (this.delivery) {
      await db.query('BEGIN');
      try {
        const result = await this.delivery.enqueue(db, this.sequence, batch);
        await db.query('UPDATE olos_http.reads SET processed_count=$2,received_count=$3 WHERE id=$1', [readId, processed, received]);
        await db.query('COMMIT');
        // Queued locally is not a corporate INSERT or acknowledgement.
        return { inserted: 0, updated: 0, queued: result.queued, duplicates: input.length - result.queued };
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    }

    if (batch.length === 0) {
      await db.query('BEGIN');
      try {
        await db.query(
          'UPDATE olos_http.reads SET processed_count=$2,received_count=$3 WHERE id=$1',
          [readId, processed, received]
        );
        await db.query('COMMIT');
        return { inserted: 0, updated: 0, duplicates: 0 };
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }

    await db.query('BEGIN');
    try {
      // Prevent a concurrent destination writer/sequence collision from being mistaken for our own row.
      await db.query(`LOCK TABLE ${this.target} IN SHARE ROW EXCLUSIVE MODE`);
      const previous = (await db.query('SELECT source_id,target_id,source_hash,target_table FROM olos_http.records WHERE source_key=$1 AND source_id=ANY($2::text[])', [this.cfg.sourceKey, batch.map(r => r.source_id)])).rows;
      const existing = new Map(previous.map(r => [r.source_id as string, r]));
      for (const row of batch) {
        const prev = existing.get(row.source_id);
        if (prev && (prev.source_hash !== row.source_hash || prev.target_table !== this.target)) throw new WorkerError('SOURCE_ID_CONTENT_CONFLICT');
      }
      const inserted = batch.filter(r => !existing.has(r.source_id)).length;
      const markers = (await db.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,campaign_id,disposition_id)
        SELECT $1,x.source_id,$2,nextval($3::regclass),x.source_hash,x.agent_id,x.campaign_id,x.disposition_id
        FROM jsonb_to_recordset($4::jsonb) AS x(source_id text,source_hash text,agent_id text,campaign_id text,disposition_id text)
        WHERE NOT EXISTS (SELECT 1 FROM olos_http.records r WHERE r.source_key=$1 AND r.source_id=x.source_id)
        RETURNING source_id,target_id`, [this.cfg.sourceKey, this.target, this.sequence, JSON.stringify(batch)])).rows;
      for (const row of markers) existing.set(row.source_id, row);
      const payload = batch.map(row => ({ ...row, internal_id_olos: existing.get(row.source_id)!.target_id }));
      const occupied = new Set((await db.query(`SELECT internal_id_olos FROM ${this.target} WHERE internal_id_olos=ANY($1::bigint[])`, [payload.map(r => r.internal_id_olos)])).rows.map(r => r.internal_id_olos));
      if (markers.some(r => occupied.has(r.target_id)) || previous.some(r => !occupied.has(r.target_id))) throw new WorkerError('DESTINATION_ID_CONFLICT');
      const names = columns.map(quote).join(',');
      const declarations = columns.map(c => `${quote(c)} ${c === 'data_ligacao' ? 'timestamptz' : c === 'tma_origem' ? 'numeric' : c === 'raw_olos_call_id' ? 'text' : 'text'}`).join(',');
      // Pending fields are literal NULL: compatible with a nullable legacy bigint raw_olos_call_id or integer tma.
      const selections = columns.map(c => c === 'raw_olos_call_id' ? 'NULL' : quote(c)).join(',');
      const result = await db.query(`INSERT INTO ${this.target} AS d (internal_id_olos,${names}) OVERRIDING SYSTEM VALUE
        SELECT internal_id_olos,${selections} FROM jsonb_to_recordset($1::jsonb) AS x(internal_id_olos bigint,${declarations})
        ON CONFLICT (internal_id_olos) DO UPDATE SET
          nome_agente=COALESCE(EXCLUDED.nome_agente,d.nome_agente),
          nome_campanha_olos=COALESCE(EXCLUDED.nome_campanha_olos,d.nome_campanha_olos),
          nome_tabulacao_olos=COALESCE(EXCLUDED.nome_tabulacao_olos,d.nome_tabulacao_olos),
          tma_origem=COALESCE(d.tma_origem,EXCLUDED.tma_origem)
        WHERE (EXCLUDED.nome_agente IS NOT NULL AND d.nome_agente IS DISTINCT FROM EXCLUDED.nome_agente)
          OR (EXCLUDED.nome_campanha_olos IS NOT NULL AND d.nome_campanha_olos IS DISTINCT FROM EXCLUDED.nome_campanha_olos)
          OR (EXCLUDED.nome_tabulacao_olos IS NOT NULL AND d.nome_tabulacao_olos IS DISTINCT FROM EXCLUDED.nome_tabulacao_olos)
          OR (d.tma_origem IS NULL AND EXCLUDED.tma_origem IS NOT NULL)`, [JSON.stringify(payload)]);
      await db.query('UPDATE olos_http.reads SET processed_count=$2,received_count=$3 WHERE id=$1', [readId, processed, received]);
      await db.query('COMMIT');
      return { inserted, updated: (result.rowCount ?? 0) - inserted, duplicates: input.length - inserted };
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  }
  async reconcileNames(cache: Cache) {
    if (this.delivery) return 0; // Frozen corporate calls are never rewritten by reference-cache refreshes.
    let updated = 0;
    const db = this.db();
    for (const [refs, refColumn, destColumn] of [[cache.users,'agent_id','nome_agente'],[cache.campaigns,'campaign_id','nome_campanha_olos'],[cache.dispositions,'disposition_id','nome_tabulacao_olos']] as const) {
      const entries = [...refs].map(([id, name]) => ({ id, name }));
      for (let offset = 0; offset < entries.length; offset += this.cfg.batchSize) {
        const result = await db.query(`UPDATE ${this.target} d SET ${quote(destColumn)}=x.name FROM olos_http.records r,
          jsonb_to_recordset($1::jsonb) AS x(id text,name text) WHERE r.source_key=$2 AND r.target_table=$3
          AND r.${refColumn}=x.id AND d.internal_id_olos=r.target_id AND d.${quote(destColumn)} IS DISTINCT FROM x.name`, [JSON.stringify(entries.slice(offset,offset+this.cfg.batchSize)), this.cfg.sourceKey, this.target]);
        updated += result.rowCount ?? 0;
      }
    }
    return updated;
  }
  async resolve(id: string, evidence: string) {
    if (evidence.trim().length < 10) throw new WorkerError('RECONCILIATION_EVIDENCE_REQUIRED');
    const result = await this.db().query("UPDATE olos_http.reads SET state='resolved',resolution=$3,finished_at=clock_timestamp() WHERE id=$1 AND source_key=$2 AND state='reading'", [id,this.cfg.sourceKey,evidence]);
    if (result.rowCount !== 1) throw new WorkerError('UNRESOLVED_READ_NOT_FOUND');
  }
  async close() {
    try { await this.delivery?.close(); }
    finally {
      this.alive = false;
      if (this.client) { this.client.release(true); this.client = undefined; }
      await this.pool.end();
    }
  }
}
