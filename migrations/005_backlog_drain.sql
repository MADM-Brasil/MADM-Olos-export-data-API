-- LOCAL DATABASE ONLY. Manual prerequisite. Never run against MADM.
-- Independent journal: the existing three-record exception and journal stay unchanged.
BEGIN;
SELECT pg_advisory_xact_lock(17320914,3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_drain_runs (
  run_id uuid PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  binding text NOT NULL,
  schema_hash text NOT NULL,
  history_snapshot jsonb NOT NULL,
  limits jsonb NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  selected_count integer NOT NULL CHECK (selected_count BETWEEN 1 AND 10000),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','running','completed','stopped','failed','reconciled')),
  last_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS corporate_drain_one_open
  ON olos_http.corporate_drain_runs ((true)) WHERE state IN ('planned','running','failed');
CREATE TABLE IF NOT EXISTS olos_http.corporate_drain_batches (
  run_id uuid NOT NULL REFERENCES olos_http.corporate_drain_runs(run_id),
  batch_no integer NOT NULL CHECK (batch_no BETWEEN 1 AND 100),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence) BETWEEN 1 AND 1000),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','intent','acknowledged','reconciled')),
  outcome jsonb,
  confirmed_count integer NOT NULL DEFAULT 0 CHECK (confirmed_count BETWEEN 0 AND 1000),
  existing_count integer CHECK (existing_count BETWEEN 0 AND 1000),
  duration_ms integer CHECK (duration_ms >= 0),
  intent_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY(run_id,batch_no),
  CHECK ((state IN ('acknowledged','reconciled')) = (outcome IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK (state <> 'intent' OR intent_at IS NOT NULL)
);
COMMENT ON TABLE olos_http.corporate_drain_runs IS
  'Bounded v1 backlog authorization and unchanged interrupted-history evidence. Retain all runs.';
COMMENT ON TABLE olos_http.corporate_drain_batches IS
  'Frozen identities/hashes and durable intent before remote COMMIT; intent requires explicit reconciliation. No payload copies.';
COMMIT;
