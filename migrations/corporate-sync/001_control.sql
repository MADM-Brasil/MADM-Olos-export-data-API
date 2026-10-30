-- LOCAL SOURCE ONLY. Does not alter raw.olos_calls or existing modules.
BEGIN;
SELECT pg_advisory_xact_lock(17320914, 2);
CREATE SCHEMA IF NOT EXISTS corporate_sync;
CREATE TABLE IF NOT EXISTS corporate_sync.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  binding text NOT NULL CHECK (binding ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_confirmed_id bigint,
  confirmed_count bigint NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
  pending jsonb CHECK (pending IS NULL OR jsonb_typeof(pending) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corporate_sync.receipts (
  internal_id_olos bigint PRIMARY KEY,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE corporate_sync.control IS 'Local corporate-sync checkpoint and durable pending batch. Pending payload contains personal data; restrict access and backups.';
COMMENT ON TABLE corporate_sync.receipts IS 'Local acknowledgements written only after confirmed destination commit; IDs, not call IDs, track incremental delivery.';
COMMIT;
