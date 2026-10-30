-- LOCAL DATABASE ONLY. Manual and idempotent. No corporate DDL, sequence or data changes.
BEGIN;
SELECT pg_advisory_xact_lock(17320914, 3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_key text NOT NULL,
  target_table text NOT NULL,
  binding text NOT NULL CHECK (binding ~ '^[0-9a-f]{64}$'),
  legacy_binding text,
  legacy_count bigint NOT NULL DEFAULT 0,
  ready boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT true,
  blocked boolean NOT NULL DEFAULT false,
  destination_shape jsonb,
  schema_hash text,
  generation bigint NOT NULL DEFAULT 0,
  confirmed_count bigint NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_code text,
  reconciled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
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
COMMENT ON TABLE olos_http.corporate_outbox IS 'Frozen delivery payload contains personal data; receipts and original capture must be preserved. Local queue admission is not corporate acknowledgement.';
COMMIT;
