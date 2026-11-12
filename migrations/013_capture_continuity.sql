-- Local authorization ledger only; never changes reads, recovery evidence or corporate data.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE olos_http.capture_continuity (
 authorization_id uuid PRIMARY KEY,
 source_key text NOT NULL CHECK(source_key='olos-production'),
 parent_id uuid NOT NULL REFERENCES olos_http.reads(id) CHECK(parent_id='2523225a-a46d-407a-ad5a-d1ff771e576e'),
 target_table text NOT NULL,
 binding text NOT NULL CHECK(binding ~ '^[a-f0-9]{64}$'),
 parent_hash text NOT NULL CHECK(parent_hash ~ '^[a-f0-9]{64}$'),
 consent jsonb NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at>approved_at)
);
CREATE UNIQUE INDEX capture_continuity_active_source ON olos_http.capture_continuity(source_key) WHERE revoked_at IS NULL;
CREATE FUNCTION olos_http.guard_capture_continuity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CONTINUITY_AUDIT_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'CONTINUITY_AUDIT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_continuity_immutable BEFORE UPDATE OR DELETE ON olos_http.capture_continuity
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_capture_continuity();
COMMIT;
