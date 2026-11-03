-- LOCAL ONLY. Manual prerequisite; never applied by the CLI or against MADM.
BEGIN;
SELECT pg_advisory_xact_lock(17320914,3);
DO $$ BEGIN
 IF current_database()='madm' OR to_regclass('olos_http.corporate_drain_runs') IS NULL THEN
  RAISE EXCEPTION 'GAP_LOCAL_DATABASE_REQUIRED';
 END IF;
END $$;
CREATE TABLE olos_http.history_gap_plans (
 id uuid PRIMARY KEY, manifest jsonb NOT NULL,
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE olos_http.history_gap_children (
 read_id uuid PRIMARY KEY REFERENCES olos_http.reads(id),
 plan_id uuid NOT NULL REFERENCES olos_http.history_gap_plans(id),
 block integer NOT NULL CHECK(block BETWEEN 1 AND 40),
 UNIQUE(plan_id,block)
);
CREATE TABLE olos_http.history_gap_responses (
 read_id uuid PRIMARY KEY REFERENCES olos_http.history_gap_children(read_id),
 body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes>0)
);
CREATE TABLE olos_http.history_gap_members (
 source_key text NOT NULL, source_id text NOT NULL,
 read_id uuid NOT NULL REFERENCES olos_http.history_gap_responses(read_id),
 target_id text NOT NULL, source_hash text NOT NULL, payload_hash text NOT NULL,
 PRIMARY KEY(source_key,source_id),
 FOREIGN KEY(source_key,source_id) REFERENCES olos_http.corporate_outbox(source_key,source_id)
);
CREATE INDEX history_gap_members_read ON olos_http.history_gap_members(read_id);
CREATE FUNCTION olos_http.history_gap_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GAP_JOURNAL_IMMUTABLE'; END $$;
CREATE TRIGGER gap_plans_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.history_gap_plans
 FOR EACH STATEMENT EXECUTE FUNCTION olos_http.history_gap_immutable();
CREATE TRIGGER gap_children_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.history_gap_children
 FOR EACH STATEMENT EXECUTE FUNCTION olos_http.history_gap_immutable();
CREATE TRIGGER gap_responses_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.history_gap_responses
 FOR EACH STATEMENT EXECUTE FUNCTION olos_http.history_gap_immutable();
CREATE TRIGGER gap_members_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.history_gap_members
 FOR EACH STATEMENT EXECUTE FUNCTION olos_http.history_gap_immutable();
COMMIT;
