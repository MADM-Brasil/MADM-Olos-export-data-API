-- TEST ONLY: isolated database. Not a migration for an existing destination.
CREATE SCHEMA raw;
CREATE TABLE raw.olos_calls (
 internal_id_olos bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 olos_call_id text, data_ligacao timestamptz, telefone text, nome_agente text,
 id_campanha_olos text, nome_campanha_olos text, id_tabulacao_olos text, nome_tabulacao_olos text,
 cpf text, lead_id_origem text, tma_origem numeric, razao_desligamento text, email text,
 raw_olos_call_id text, telefone_match_key text
);

-- Report-specific disposable tables, mirroring relevant production constraints.
CREATE SCHEMA olos_http;
CREATE TABLE olos_http.reads (
  id uuid PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  spec jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  state text NOT NULL DEFAULT 'reading' CHECK (state IN ('reading','received','done','resolved')),
  response_body text,
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  received_count integer,
  request_ms integer,
  error_code text,
  resolution text,
  CHECK (state NOT IN ('received','done') OR response_body IS NOT NULL),
  CHECK (state <> 'resolved' OR resolution IS NOT NULL)
);
CREATE INDEX reads_pending ON olos_http.reads(source_key, started_at) WHERE state IN ('reading','received');
CREATE TABLE olos_http.records (
  source_key text NOT NULL,
  source_id text NOT NULL,
  target_table text NOT NULL,
  target_id bigint NOT NULL,
  source_hash text NOT NULL,
  agent_id text,
  campaign_id text,
  disposition_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_key, source_id),
  UNIQUE (target_table, target_id)
);
CREATE TABLE IF NOT EXISTS olos_http.corporate_outbox (
  source_key text NOT NULL,
  source_id text NOT NULL,
  target_id integer NOT NULL UNIQUE,
  source_hash text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed')),
  origin text NOT NULL CHECK (origin IN ('capture','legacy_receipt','legacy_backlog')),
  remote_raw_id bigint,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_key,source_id),
  FOREIGN KEY(source_key,source_id) REFERENCES olos_http.records(source_key,source_id),
  CHECK ((state='confirmed') = (confirmed_at IS NOT NULL AND remote_raw_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS corporate_outbox_pending ON olos_http.corporate_outbox(target_id) WHERE state='pending';
