-- LOCAL DATABASE ONLY. Manual prerequisite for selective delivery/reconciliation.
-- Never run against MADM. Does not alter existing receipts or the general queue.
BEGIN;
SELECT pg_advisory_xact_lock(17320914,3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_selective_commits (
  attempt_id uuid PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  binding text NOT NULL,
  schema_hash text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence) BETWEEN 1 AND 3),
  state text NOT NULL DEFAULT 'unresolved' CHECK (state IN ('unresolved','acknowledged','reconciled')),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((state='unresolved' AND resolved_at IS NULL AND outcome IS NULL) OR
         (state<>'unresolved' AND resolved_at IS NOT NULL AND outcome IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS corporate_selective_one_unresolved
  ON olos_http.corporate_selective_commits ((true)) WHERE state='unresolved';
COMMENT ON TABLE olos_http.corporate_selective_commits IS
  'Durable selective COMMIT intent and authorized reconciliation evidence. Preserve resolved attempts; no remote payload or corporate DDL.';
COMMIT;
