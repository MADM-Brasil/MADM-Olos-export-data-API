-- LOCAL ONLY. Manual prerequisite; never execute against MADM.
-- Identity adoption is performed by identity-main after scoped preflight/authorization.
BEGIN;
SELECT pg_advisory_xact_lock(17320914,3);
DO $$ BEGIN
 IF current_database()='madm' OR to_regclass('olos_http.corporate_control') IS NULL THEN
   RAISE EXCEPTION 'IDENTITY_LOCAL_DATABASE_REQUIRED';
 END IF;
END $$;
CREATE TABLE olos_http.identity_contract (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 adopted boolean NOT NULL DEFAULT false
);
INSERT INTO olos_http.identity_contract VALUES(true,false);
CREATE TABLE olos_http.identity_plans (
 id uuid PRIMARY KEY,
 manifest jsonb NOT NULL,
 hash text NOT NULL CHECK(hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE olos_http.identity_runs (
 id uuid PRIMARY KEY REFERENCES olos_http.identity_plans(id),
 state text NOT NULL CHECK(state IN ('planned','intent','completed','not_applied','cancelled')),
 duration_ms integer,
 finished_at timestamptz
);
CREATE UNIQUE INDEX identity_one_open ON olos_http.identity_runs((true)) WHERE state IN ('planned','intent');
CREATE TABLE olos_http.identity_events (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 id uuid NOT NULL REFERENCES olos_http.identity_plans(id),
 event text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION olos_http.identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IDENTITY_JOURNAL_IMMUTABLE'; END $$;
CREATE TRIGGER identity_plan_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.identity_plans
 FOR EACH STATEMENT EXECUTE FUNCTION olos_http.identity_immutable();
CREATE TRIGGER identity_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON olos_http.identity_events
 FOR EACH STATEMENT EXECUTE FUNCTION olos_http.identity_immutable();
COMMENT ON TABLE olos_http.identity_plans IS 'Private immutable before/after evidence. Contains personal data; restrict access. No corporate DDL.';
COMMIT;
