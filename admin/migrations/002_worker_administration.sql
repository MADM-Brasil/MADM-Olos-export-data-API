-- Manual and idempotent. Requires existing olos_http schema. Never executed at startup.
BEGIN;
CREATE TABLE IF NOT EXISTS olos_http.worker_settings (
  source_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  interval_ms integer NOT NULL CHECK (interval_ms BETWEEN 60000 AND 3600000),
  desired_state text NOT NULL DEFAULT 'STOPPED' CHECK (desired_state IN ('RUNNING','PAUSED','STOPPED')),
  runtime_state text NOT NULL DEFAULT 'STOPPED' CHECK (runtime_state IN ('RUNNING','PAUSING','PAUSED','STOPPING','STOPPED','ERROR')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CHECK (enabled = (desired_state = 'RUNNING'))
);
CREATE TABLE IF NOT EXISTS olos_http.admin_credentials (
  source_key text PRIMARY KEY REFERENCES olos_http.worker_settings(source_key),
  revision integer NOT NULL CHECK (revision > 0),
  encrypted_payload text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_code text,
  last_test_ms integer
);
CREATE TABLE IF NOT EXISTS olos_http.admin_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS admin_audit_source_time ON olos_http.admin_audit(source_key, occurred_at DESC);
COMMIT;
