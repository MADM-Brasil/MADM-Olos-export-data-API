-- LOCAL ONLY. No changes to historical IDs, frozen outbox, quarantine, receipts or sequences.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
SELECT pg_advisory_xact_lock(17320914,3);
ALTER TABLE olos_http.corporate_control ADD COLUMN IF NOT EXISTS id_allocator_required boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS olos_http.corporate_id_allocator (
  source_key text PRIMARY KEY,
  binding text NOT NULL,
  target_table text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  evidence_ref text NOT NULL CHECK(evidence_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),
  state text NOT NULL CHECK(state IN ('adopting','active')),
  contract_hash text,
  adopted_at timestamptz,
  CHECK((state='active')=(contract_hash IS NOT NULL AND adopted_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS olos_http.corporate_id_admissions (
  source_key text NOT NULL,
  source_id text NOT NULL,
  source_hash text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  mapped jsonb NOT NULL,
  mapped_hash text NOT NULL CHECK(mapped_hash ~ '^[0-9a-f]{64}$'),
  materialized boolean NOT NULL DEFAULT false,
  PRIMARY KEY(source_key,source_id),
  FOREIGN KEY(source_key) REFERENCES olos_http.corporate_id_allocator(source_key)
);
CREATE INDEX IF NOT EXISTS corporate_id_admissions_waiting ON olos_http.corporate_id_admissions(source_key,source_id) WHERE NOT materialized;
CREATE TABLE IF NOT EXISTS olos_http.corporate_id_assignments (
  source_key text NOT NULL,
  source_id text NOT NULL,
  target_id integer NOT NULL UNIQUE,
  source_hash text NOT NULL,
  binding text NOT NULL,
  token uuid,
  legacy boolean NOT NULL,
  PRIMARY KEY(source_key,source_id),
  FOREIGN KEY(source_key,source_id) REFERENCES olos_http.records(source_key,source_id),
  CHECK(legacy OR token IS NOT NULL)
);
COMMENT ON TABLE olos_http.corporate_id_admissions IS
  'Durable normalized capture awaiting authoritative MADM ID; contains personal data. No delivery receipt or ID until materialized. Preserve along with original raw read.';
-- Deferred fence also rejects a legacy binary that still tries to persist IDs from nextval.
CREATE OR REPLACE FUNCTION olos_http.require_corporate_id_assignment() RETURNS trigger LANGUAGE plpgsql AS $assignment$
BEGIN
  IF EXISTS(SELECT 1 FROM olos_http.corporate_control c WHERE c.singleton AND c.source_key=NEW.source_key AND c.id_allocator_required)
    AND NOT EXISTS(SELECT 1 FROM olos_http.corporate_id_assignments a JOIN olos_http.corporate_id_allocator c USING(source_key)
      WHERE a.source_key=NEW.source_key AND a.source_id=NEW.source_id AND a.target_id=NEW.target_id
        AND a.source_hash=NEW.source_hash AND a.binding=c.binding AND c.state='active') THEN
    RAISE EXCEPTION 'ALLOCATOR_ASSIGNMENT_REQUIRED';
  END IF;
  RETURN NEW;
END;
$assignment$;
DO $trigger$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='olos_http.records'::regclass AND tgname='corporate_id_assignment_required') THEN
    CREATE CONSTRAINT TRIGGER corporate_id_assignment_required AFTER INSERT OR UPDATE ON olos_http.records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION olos_http.require_corporate_id_assignment();
  END IF;
END $trigger$;
COMMIT;
