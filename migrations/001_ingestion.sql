-- Manual. Does not create or alter the corporate destination.
BEGIN;
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
COMMIT;
