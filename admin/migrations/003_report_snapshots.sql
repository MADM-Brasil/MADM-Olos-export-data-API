-- Manual/local only. Never run automatically at startup. No operational tables altered.
BEGIN;
CREATE TABLE IF NOT EXISTS olos_http.report_snapshots (
  id uuid PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  contract_version integer NOT NULL CHECK(contract_version>0),
  contract_name text NOT NULL CHECK(contract_name='olos-admin-reports/v'||contract_version::text),
  timezone text NOT NULL CHECK(timezone='America/Sao_Paulo'),
  status text NOT NULL CHECK(status='published'),
  observed_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  collection_date date NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  validation jsonb NOT NULL CHECK(jsonb_typeof(validation)='object' AND octet_length(validation::text)<=4096),
  data_hash text NOT NULL CHECK(data_hash ~ '^[0-9a-f]{64}$'),
  CHECK(octet_length(data::text)<=16777216),
  CHECK(published_at>=observed_at)
);
CREATE INDEX IF NOT EXISTS report_snapshots_history ON olos_http.report_snapshots
  (source_key,target_table,contract_version,published_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS olos_http.report_snapshot_state (
  source_key text NOT NULL,
  target_table text NOT NULL,
  contract_version integer NOT NULL CHECK(contract_version>0),
  published_id uuid REFERENCES olos_http.report_snapshots(id),
  status text NOT NULL DEFAULT 'initializing' CHECK(status IN ('initializing','building','ready','error')),
  attempt_id uuid,
  attempted_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT '-infinity',
  failure_count smallint NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 3),
  last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  PRIMARY KEY(source_key,target_table,contract_version)
);
COMMENT ON TABLE olos_http.report_snapshots IS 'Versioned private analytical aggregates; no source payloads or contact values. Publication and pointer are atomic.';

-- Generation IDs are immutable. Readers can revalidate the pointer/hash without
-- repeatedly downloading an unchanged payload. Repairs publish a new generation.
CREATE OR REPLACE FUNCTION olos_http.reject_report_snapshot_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REPORT_SNAPSHOT_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS report_snapshot_immutable ON olos_http.report_snapshots;
CREATE TRIGGER report_snapshot_immutable BEFORE UPDATE ON olos_http.report_snapshots
FOR EACH ROW EXECUTE FUNCTION olos_http.reject_report_snapshot_update();
COMMIT;
