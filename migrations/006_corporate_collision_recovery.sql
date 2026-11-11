-- LOCAL DATABASE ONLY. Append-only administrative evidence; never changes queue/call data.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
SELECT pg_advisory_xact_lock(17320914,3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_collision_recoveries (
  request_id uuid PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  binding text NOT NULL CHECK (binding ~ '^[0-9a-f]{64}$'),
  verification_digest text NOT NULL CHECK (verification_digest ~ '^[0-9a-f]{64}$'),
  evidence_ref text NOT NULL CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),
  previous_generation bigint NOT NULL,
  previous_code text NOT NULL CHECK (previous_code='INTERNAL_ID_COLLISION'),
  pending_count bigint NOT NULL CHECK (pending_count>=0),
  eligible_count bigint NOT NULL CHECK (eligible_count>=0 AND eligible_count<=pending_count),
  existing_count bigint NOT NULL CHECK (existing_count>=0 AND existing_count<=pending_count),
  schema_hash text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE olos_http.corporate_collision_recoveries IS
  'Administrative release of a revalidated INTERNAL_ID_COLLISION. IDs and proof hashes only; no payloads or personal values. Preserve evidence; no automatic retry.';
COMMIT;
