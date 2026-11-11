-- LOCAL ONLY. Retain migration 008 and its trigger, admissions, assignments and adoption evidence.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
SELECT pg_advisory_xact_lock(17320914,3);
ALTER TABLE olos_http.corporate_id_allocator DROP CONSTRAINT corporate_id_allocator_state_check;
ALTER TABLE olos_http.corporate_id_allocator ADD CONSTRAINT corporate_id_allocator_state_check
  CHECK(state IN ('adopting','active','reverting','legacy'));
CREATE TABLE IF NOT EXISTS olos_http.corporate_id_reversions (
  request_id uuid PRIMARY KEY,
  source_key text NOT NULL UNIQUE REFERENCES olos_http.corporate_id_allocator(source_key),
  target_table text NOT NULL,
  binding text NOT NULL,
  adoption_request_id uuid NOT NULL UNIQUE,
  sequence_name text NOT NULL,
  evidence_ref text NOT NULL CHECK(evidence_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),
  state text NOT NULL CHECK(state IN ('materializing','completed')),
  initial_manifest jsonb NOT NULL CHECK(jsonb_typeof(initial_manifest)='array'),
  initial_digest text NOT NULL CHECK(initial_digest ~ '^[0-9a-f]{64}$'),
  initial_count bigint NOT NULL CHECK(initial_count>=0),
  materialized_count bigint NOT NULL DEFAULT 0 CHECK(materialized_count>=0),
  batch_count integer NOT NULL DEFAULT 0 CHECK(batch_count>=0),
  previous_allocator_state text NOT NULL DEFAULT 'adopting' CHECK(previous_allocator_state='adopting'),
  previous_id_allocator_required boolean NOT NULL DEFAULT true CHECK(previous_id_allocator_required),
  previous_generation bigint NOT NULL,
  previous_code text,
  previous_blocked boolean NOT NULL,
  previous_confirmed_count bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  validated_at timestamptz,
  validation_digest text CHECK(validation_digest IS NULL OR validation_digest ~ '^[0-9a-f]{64}$'),
  CHECK((validated_at IS NULL)=(validation_digest IS NULL)),
  CHECK((state='completed')=(completed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS olos_http.corporate_id_reversion_batches (
  request_id uuid NOT NULL REFERENCES olos_http.corporate_id_reversions(request_id),
  batch_no integer NOT NULL,
  members jsonb NOT NULL CHECK(jsonb_typeof(members)='array'),
  member_count integer NOT NULL CHECK(member_count>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,batch_no),
  CHECK(jsonb_array_length(members)=member_count)
);
COMMENT ON TABLE olos_http.corporate_id_reversions IS
  'Explicit reversal of an unadopted allocator preparation. IDs/hash manifest only. Original admissions and adoption remain intact; no automated resume or remote write.';
COMMIT;
