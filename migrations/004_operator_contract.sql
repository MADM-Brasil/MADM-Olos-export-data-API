-- LOCAL ONLY, manual. No corporate DDL or modification of payloads/receipts.
BEGIN;
SELECT pg_advisory_xact_lock(17320914,3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_operator_contracts (
  source_key text PRIMARY KEY, binding text NOT NULL, target_table text NOT NULL,
  previous_schema_hash text NOT NULL, schema_hash text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS olos_http.corporate_operator_payloads (
  source_key text NOT NULL, source_id text NOT NULL, target_id integer NOT NULL,
  source_hash text NOT NULL, agent_id text,
  previous_payload jsonb NOT NULL, previous_hash text NOT NULL,
  payload jsonb NOT NULL, payload_hash text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_key,source_id),
  FOREIGN KEY(source_key,source_id) REFERENCES olos_http.records(source_key,source_id)
);
COMMIT;
