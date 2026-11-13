-- LOCAL ONLY. Explicit one-time cutover prerequisite; never remaps a call or a receipt.
-- Stop capture and delivery before installation. Requires 008..011 and a prepared
-- allocator or a completed, validated legacy reversion. No v1 active upgrade here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(17320914,5);
SELECT pg_advisory_xact_lock(17320914,6);
LOCK TABLE olos_http.corporate_control,olos_http.corporate_id_allocator IN SHARE ROW EXCLUSIVE MODE;
DO $precondition$ BEGIN
 IF EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE NOT paused OR id_allocator_generation IS NOT NULL)
   OR EXISTS(SELECT 1 FROM olos_http.corporate_id_allocator WHERE state NOT IN ('legacy','adopting') OR contract_hash IS NOT NULL)
   OR EXISTS(SELECT 1 FROM olos_http.corporate_id_assignments)
   OR EXISTS(SELECT 1 FROM olos_http.corporate_allocator_readoptions WHERE state<>'aborted') THEN
  RAISE EXCEPTION 'ALLOCATOR_AUTHORITY_CUTOVER_NOT_READY';
 END IF;
 IF EXISTS(SELECT 1 FROM olos_http.corporate_control c LEFT JOIN olos_http.corporate_id_allocator a USING(source_key)
   WHERE c.singleton AND a.source_key IS NULL) THEN RAISE EXCEPTION 'ALLOCATOR_PREPARATION_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM olos_http.corporate_id_allocator a WHERE a.state='legacy' AND NOT EXISTS(
   SELECT 1 FROM olos_http.corporate_id_reversions r WHERE r.source_key=a.source_key AND r.adoption_request_id=a.request_id
    AND r.binding=a.binding AND r.target_table=a.target_table AND r.state='completed' AND r.validated_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'READOPTION_REVERSAL_UNVERIFIED';
 END IF;
END;
$precondition$;
CREATE TABLE olos_http.corporate_authority_contract (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=2)
);
INSERT INTO olos_http.corporate_authority_contract VALUES(true,2);
CREATE FUNCTION olos_http.guard_corporate_authority() RETURNS trigger LANGUAGE plpgsql AS $authority$
DECLARE c record; BEGIN
 PERFORM pg_advisory_xact_lock_shared(17320914,5);
 IF TG_TABLE_NAME='corporate_id_allocator' THEN
  IF NEW.state='reverting' OR (OLD.state='active' AND NEW.state<>'active') THEN
   RAISE EXCEPTION 'ALLOCATOR_LEGACY_GENERATION_FORBIDDEN';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO c FROM olos_http.corporate_control WHERE singleton;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='olos_calls' THEN
  IF c.target_table::regclass=TG_RELID AND (TG_OP='INSERT' OR NEW.internal_id_olos IS DISTINCT FROM OLD.internal_id_olos) THEN
   RAISE EXCEPTION 'ALLOCATOR_LEGACY_GENERATION_FORBIDDEN';
  END IF;
 ELSIF NEW.source_key=c.source_key AND (NOT c.id_allocator_required OR NOT EXISTS(
   SELECT 1 FROM olos_http.corporate_id_allocator a WHERE a.source_key=c.source_key AND a.state='active')) THEN
  RAISE EXCEPTION 'ALLOCATOR_ASSIGNMENT_REQUIRED';
 END IF;
 RETURN NEW;
END;
$authority$;
CREATE TRIGGER corporate_authority_only BEFORE INSERT ON olos_http.records
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority();
CREATE TRIGGER corporate_authority_only BEFORE INSERT OR UPDATE OF internal_id_olos ON raw.olos_calls
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority();
CREATE TRIGGER corporate_authority_only BEFORE UPDATE ON olos_http.corporate_id_allocator
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_corporate_authority();
ALTER TABLE olos_http.records ENABLE ALWAYS TRIGGER corporate_authority_only;
ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER corporate_authority_only;
ALTER TABLE olos_http.corporate_id_allocator ENABLE ALWAYS TRIGGER corporate_authority_only;
COMMIT;
