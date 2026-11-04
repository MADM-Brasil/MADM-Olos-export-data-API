-- LOCAL ONLY. Run with psql -X -v ON_ERROR_STOP=1, outside a transaction.
-- Supply finite statement_timeout and lock_timeout explicitly in this DDL
-- session (e.g. PGOPTIONS). No runtime timeout is changed by this migration.
DO $$ DECLARE source text; key text; BEGIN
  IF current_database()='madm' OR to_regclass('olos_http.corporate_outbox') IS NULL
    OR to_regclass('olos_http.history_gap_plans') IS NULL THEN
    RAISE EXCEPTION 'DRAIN_INDEX_LOCAL_DATABASE_REQUIRED';
  END IF;
  IF current_setting('statement_timeout')='0' OR current_setting('lock_timeout')='0' THEN
    RAISE EXCEPTION 'DRAIN_INDEX_EXPLICIT_DDL_TIMEOUTS_REQUIRED';
  END IF;
  IF NOT pg_try_advisory_lock(17320914,4) THEN RAISE EXCEPTION 'CORPORATE_DELIVERY_BUSY'; END IF;
  FOR source IN SELECT source_key FROM olos_http.corporate_control WHERE singleton LOOP
    FOREACH key IN ARRAY ARRAY['olos-http:AttemptsRawData:'||source,'olos-http:history:'||source,'olos-admin:'||source] LOOP
      IF NOT pg_try_advisory_lock(hashtextextended(key,0)) THEN RAISE EXCEPTION 'DRAIN_INDEX_CONSUMER_ACTIVE'; END IF;
    END LOOP;
  END LOOP;
  -- Recheck maintenance state after acquiring the same session fences as the app.
  IF EXISTS(SELECT 1 FROM olos_http.worker_settings WHERE enabled OR desired_state<>'STOPPED' OR runtime_state<>'STOPPED')
    OR NOT EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE singleton AND ready AND paused AND NOT blocked)
    OR EXISTS(SELECT 1 FROM olos_http.corporate_drain_runs WHERE state IN ('planned','running','failed'))
    OR EXISTS(SELECT 1 FROM olos_http.corporate_selective_commits WHERE state='unresolved') THEN
    RAISE EXCEPTION 'DRAIN_INDEX_MAINTENANCE_REQUIRED';
  END IF;
END $$;
-- statement-breakpoint
-- Deliberately no IF NOT EXISTS: a failed concurrent build can leave an INVALID
-- index; silently skipping it would give a false success. Review before retry.
CREATE INDEX CONCURRENTLY records_identified_operator_order
  ON olos_http.records (source_key,target_id)
  WHERE agent_id ~ '^[1-9][0-9]*$';
-- statement-breakpoint
ANALYZE olos_http.records;
-- statement-breakpoint
ANALYZE olos_http.corporate_outbox;
-- statement-breakpoint
DO $$ DECLARE source text; key text; BEGIN
  FOR source IN SELECT source_key FROM olos_http.corporate_control WHERE singleton LOOP
    FOREACH key IN ARRAY ARRAY['olos-http:AttemptsRawData:'||source,'olos-http:history:'||source,'olos-admin:'||source] LOOP
      PERFORM pg_advisory_unlock(hashtextextended(key,0));
    END LOOP;
  END LOOP;
  PERFORM pg_advisory_unlock(17320914,4);
END $$;
