-- LOCAL ONLY. Manual, quiescent rollback of identity strategy, NOT data rollback.
-- Retain journals and original-ID delivery enforcement. Never restart old allocator code.
BEGIN;
SET LOCAL lock_timeout='1s';
DO $$ DECLARE source text; key text; BEGIN
 IF current_database()='madm' OR to_regclass('olos_http.identity_runs') IS NULL THEN
   RAISE EXCEPTION 'IDENTITY_LOCAL_DATABASE_REQUIRED';
 END IF;
 IF NOT pg_try_advisory_xact_lock(17320914,1) OR NOT pg_try_advisory_xact_lock(17320914,4) THEN RAISE EXCEPTION 'IDENTITY_CONSUMER_ACTIVE'; END IF;
 FOR source IN SELECT source_key FROM olos_http.corporate_control LOOP
  FOREACH key IN ARRAY ARRAY['olos-http:AttemptsRawData:'||source,'olos-http:history:'||source,'olos-admin:'||source] LOOP
   IF NOT pg_try_advisory_xact_lock(hashtextextended(key,0)) THEN RAISE EXCEPTION 'IDENTITY_CONSUMER_ACTIVE'; END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM olos_http.identity_runs WHERE state NOT IN ('cancelled','not_applied')) THEN
   RAISE EXCEPTION 'IDENTITY_ROLLBACK_REVIEW_REQUIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM olos_http.worker_settings WHERE enabled OR desired_state<>'STOPPED' OR runtime_state<>'STOPPED')
 OR EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE NOT paused OR blocked) THEN
   RAISE EXCEPTION 'IDENTITY_ROLLBACK_NOT_QUIESCENT';
 END IF;
END $$;
LOCK TABLE raw.olos_calls IN ACCESS EXCLUSIVE MODE;
ALTER TABLE raw.olos_calls ALTER COLUMN internal_id_olos SET GENERATED ALWAYS;
COMMIT;
