-- LOCAL ONLY. Forward transition from installed 014, never a corporate migration.
-- Stop the scheduler and delivery; backup first. No historical data is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(17320914,5);
SELECT pg_advisory_xact_lock(17320914,6);
LOCK TABLE olos_http.corporate_control,olos_http.corporate_id_allocator IN SHARE ROW EXCLUSIVE MODE;
DO $preconditions$ DECLARE definition_hash text; BEGIN
 IF (SELECT count(*) FROM olos_http.corporate_authority_contract WHERE singleton AND version=2)<>1
   OR (SELECT count(*) FROM olos_http.corporate_readoption_schema WHERE singleton AND version=1)<>1
   OR (SELECT count(*) FROM olos_http.corporate_control WHERE singleton AND ready AND paused
     AND NOT id_allocator_required AND id_allocator_generation IS NULL)<>1
   OR EXISTS(SELECT 1 FROM olos_http.corporate_id_allocator a WHERE state<>'legacy' OR contract_hash IS NOT NULL OR adopted_at IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM olos_http.corporate_id_reversions r WHERE r.source_key=a.source_key AND r.adoption_request_id=a.request_id
       AND r.binding=a.binding AND r.target_table=a.target_table AND r.state='completed' AND r.validated_at IS NOT NULL))
   OR NOT EXISTS(SELECT 1 FROM olos_http.corporate_control c JOIN olos_http.corporate_id_allocator a USING(source_key)
     WHERE c.binding=a.binding AND c.target_table=a.target_table)
   OR EXISTS(SELECT 1 FROM olos_http.corporate_id_assignments)
   OR EXISTS(SELECT 1 FROM olos_http.corporate_allocator_readoptions WHERE state<>'aborted')
   OR EXISTS(SELECT 1 FROM olos_http.corporate_id_admissions WHERE NOT materialized)
   OR NOT EXISTS(SELECT 1 FROM olos_http.corporate_allocation_fence f JOIN olos_http.corporate_control c USING(source_key,binding,target_table)
     WHERE NOT f.required AND f.generation_id IS NULL)
 THEN RAISE EXCEPTION 'LEGACY_RECOVERY_TRANSITION_NOT_READY'; END IF;
 SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO definition_hash FROM pg_proc
  WHERE oid=to_regprocedure('olos_http.guard_corporate_authority()') AND NOT prosecdef AND proconfig IS NULL AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql');
 IF definition_hash IS NULL OR definition_hash NOT IN ('63016c4f2656cfd14034be40268920221a66da87f9f117733fb1461227e97145','2c92451ad083c6134bb65700ad0fe134fda6e3e1beb83970d956aa1e1378ba2d') THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_LOCAL_CONTRACT_CHANGED'; END IF;
 IF (definition_hash='63016c4f2656cfd14034be40268920221a66da87f9f117733fb1461227e97145') IS DISTINCT FROM (to_regclass('olos_http.corporate_legacy_recovery') IS NULL) THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_LOCAL_CONTRACT_CHANGED'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='A'
   AND tgname='corporate_authority_only' AND tgfoid='olos_http.guard_corporate_authority()'::regprocedure
   AND pg_get_triggerdef(oid) IN (
    'CREATE TRIGGER corporate_authority_only BEFORE INSERT ON olos_http.records FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority()',
    'CREATE TRIGGER corporate_authority_only BEFORE INSERT OR UPDATE OF internal_id_olos ON raw.olos_calls FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority()',
    'CREATE TRIGGER corporate_authority_only BEFORE UPDATE ON olos_http.corporate_id_allocator FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority()'))<>3 THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_LOCAL_CONTRACT_CHANGED'; END IF;
END;
$preconditions$;
CREATE TABLE IF NOT EXISTS olos_http.corporate_legacy_recovery (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1),
 source_key text NOT NULL,binding text NOT NULL,target_table text NOT NULL,
 previous_control jsonb NOT NULL,previous_allocator jsonb NOT NULL,
 previous_function_hash text NOT NULL,installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO olos_http.corporate_legacy_recovery(singleton,version,source_key,binding,target_table,previous_control,previous_allocator,previous_function_hash)
 SELECT true,1,c.source_key,c.binding,c.target_table,to_jsonb(c),to_jsonb(a),'63016c4f2656cfd14034be40268920221a66da87f9f117733fb1461227e97145'
 FROM olos_http.corporate_control c JOIN olos_http.corporate_id_allocator a USING(source_key) ON CONFLICT(singleton) DO NOTHING;
DO $binding$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM olos_http.corporate_legacy_recovery r JOIN olos_http.corporate_control c USING(source_key,binding,target_table)
   WHERE r.singleton AND r.version=1 AND r.previous_function_hash='63016c4f2656cfd14034be40268920221a66da87f9f117733fb1461227e97145') THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_BINDING_CHANGED'; END IF;
END;
$binding$;
ALTER TABLE olos_http.corporate_control ADD COLUMN IF NOT EXISTS delivery_uncertain_ids text[];
-- Preserve the 014 triggers and ALWAYS mode; replace only their reviewed policy.
CREATE OR REPLACE FUNCTION olos_http.guard_corporate_authority() RETURNS trigger LANGUAGE plpgsql AS $authority$
DECLARE c record; BEGIN
 PERFORM pg_advisory_xact_lock_shared(17320914,5);
 SELECT * INTO c FROM olos_http.corporate_control WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_RECOVERY_BINDING_CHANGED'; END IF;
 IF TG_TABLE_NAME='corporate_control' THEN
  IF TG_OP='DELETE' OR NEW.id_allocator_required OR NEW.id_allocator_generation IS NOT NULL
    OR (NEW.source_key,NEW.binding,NEW.target_table) IS DISTINCT FROM (OLD.source_key,OLD.binding,OLD.target_table) THEN
   RAISE EXCEPTION 'LEGACY_RECOVERY_AUTHORITY_FROZEN'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM olos_http.corporate_legacy_recovery r WHERE r.singleton AND r.version=1
   AND r.source_key=c.source_key AND r.binding=c.binding AND r.target_table=c.target_table)
   OR c.id_allocator_required OR c.id_allocator_generation IS NOT NULL THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_BINDING_CHANGED'; END IF;
 IF TG_TABLE_NAME='corporate_id_allocator' THEN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'LEGACY_RECOVERY_AUTHORITY_FROZEN'; END IF;
 ELSIF TG_TABLE_NAME='olos_calls' THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_LOCAL_RAW_FORBIDDEN';
 ELSE
  IF NEW.source_key<>c.source_key OR NOT EXISTS(SELECT 1 FROM olos_http.corporate_id_allocator
      WHERE source_key=c.source_key AND state='legacy' AND contract_hash IS NULL AND adopted_at IS NULL)
    OR current_setting('olos_http.checked_legacy_candidate',true)::jsonb IS DISTINCT FROM
      jsonb_build_array(NEW.source_key,NEW.source_id,NEW.target_id::text) THEN
   RAISE EXCEPTION 'LEGACY_RECOVERY_CHECKED_CANDIDATE_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END;
$authority$;
CREATE OR REPLACE TRIGGER corporate_legacy_recovery_control BEFORE UPDATE OR DELETE ON olos_http.corporate_control
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority();
ALTER TABLE olos_http.corporate_control ENABLE ALWAYS TRIGGER corporate_legacy_recovery_control;
CREATE OR REPLACE FUNCTION olos_http.guard_legacy_recovery_evidence() RETURNS trigger LANGUAGE plpgsql AS $evidence$
BEGIN RAISE EXCEPTION 'LEGACY_RECOVERY_EVIDENCE_IMMUTABLE'; END;
$evidence$;
CREATE OR REPLACE TRIGGER corporate_legacy_recovery_immutable BEFORE UPDATE OR DELETE ON olos_http.corporate_legacy_recovery
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_legacy_recovery_evidence();
ALTER TABLE olos_http.corporate_legacy_recovery ENABLE ALWAYS TRIGGER corporate_legacy_recovery_immutable;
CREATE OR REPLACE FUNCTION olos_http.guard_legacy_recovery_mapping() RETURNS trigger LANGUAGE plpgsql AS $mapping$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LEGACY_RECOVERY_MAPPING_IMMUTABLE'; END IF;
 IF (NEW.source_key,NEW.source_id,NEW.target_id,NEW.source_hash) IS DISTINCT FROM
    (OLD.source_key,OLD.source_id,OLD.target_id,OLD.source_hash) THEN
  RAISE EXCEPTION 'LEGACY_RECOVERY_MAPPING_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='records' THEN
  IF NEW.target_table<>OLD.target_table THEN RAISE EXCEPTION 'LEGACY_RECOVERY_MAPPING_IMMUTABLE'; END IF;
 ELSE
  IF (NEW.payload,NEW.payload_hash,NEW.origin,NEW.created_at) IS DISTINCT FROM
     (OLD.payload,OLD.payload_hash,OLD.origin,OLD.created_at) OR (OLD.state='confirmed' AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'LEGACY_RECOVERY_MAPPING_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END;
$mapping$;
CREATE OR REPLACE TRIGGER corporate_legacy_mapping BEFORE UPDATE OR DELETE ON olos_http.records
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_legacy_recovery_mapping();
CREATE OR REPLACE TRIGGER corporate_legacy_mapping BEFORE UPDATE OR DELETE ON olos_http.corporate_outbox
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_legacy_recovery_mapping();
ALTER TABLE olos_http.records ENABLE ALWAYS TRIGGER corporate_legacy_mapping;
ALTER TABLE olos_http.corporate_outbox ENABLE ALWAYS TRIGGER corporate_legacy_mapping;
COMMIT;
