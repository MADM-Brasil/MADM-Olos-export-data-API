-- LOCAL DATABASE ONLY. New administrative ledgers; no change to outbox, calls or ID sequences.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
SELECT pg_advisory_xact_lock(17320914,3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_collision_quarantine_runs (
  request_id uuid PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  binding text NOT NULL CHECK (binding ~ '^[0-9a-f]{64}$'),
  verification_digest text NOT NULL CHECK (verification_digest ~ '^[0-9a-f]{64}$'),
  evidence_ref text NOT NULL CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),
  previous_generation bigint NOT NULL,
  previous_code text NOT NULL CHECK (previous_code='INTERNAL_ID_COLLISION'),
  pending_count bigint NOT NULL CHECK (pending_count>=0),
  member_count integer NOT NULL CHECK (member_count>0 AND member_count<=pending_count),
  schema_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id,source_key)
);
CREATE TABLE IF NOT EXISTS olos_http.corporate_collision_quarantine (
  source_key text NOT NULL,
  source_id text NOT NULL,
  target_id integer NOT NULL UNIQUE,
  source_hash text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL,
  code text NOT NULL CHECK (code='INTERNAL_ID_COLLISION'),
  remote_ids bigint[] NOT NULL CHECK (cardinality(remote_ids)>0),
  fields text[] NOT NULL CHECK (cardinality(fields)>0 AND fields <@ ARRAY[
    'internal_id_olos','olos_call_id','data_ligacao','telefone','nome_agente','id_campanha_olos',
    'nome_campanha_olos','id_tabulacao_olos','nome_tabulacao_olos','cpf','lead_id_origem',
    'tma_origem','razao_desligamento','email']::text[]),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(source_key,source_id),
  FOREIGN KEY(request_id,source_key) REFERENCES olos_http.corporate_collision_quarantine_runs(request_id,source_key),
  FOREIGN KEY(source_key,source_id) REFERENCES olos_http.corporate_outbox(source_key,source_id)
);
CREATE INDEX IF NOT EXISTS corporate_collision_quarantine_request
  ON olos_http.corporate_collision_quarantine(request_id);
COMMENT ON TABLE olos_http.corporate_collision_quarantine IS
  'Explicit immutable-by-procedure exclusion of confirmed ID collisions. Outbox remains pending; original payloads, hashes, records, IDs and receipts are preserved. No automatic release or deletion.';
-- Preserve formal isolation and its evidence; removing a quarantine requires a separate reviewed procedure.
CREATE OR REPLACE FUNCTION olos_http.preserve_corporate_quarantine() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CORPORATE_QUARANTINE_IMMUTABLE';
END;
$function$;
CREATE OR REPLACE TRIGGER corporate_quarantine_preserve
  BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.corporate_collision_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION olos_http.preserve_corporate_quarantine();
CREATE OR REPLACE TRIGGER corporate_quarantine_preserve
  BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.corporate_collision_quarantine_runs
  FOR EACH STATEMENT EXECUTE FUNCTION olos_http.preserve_corporate_quarantine();
COMMIT;
