-- LOCAL ONLY. Expansive activation protocol; apply after 010. No historical IDs or payloads rewritten.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(17320914,3);
CREATE TABLE IF NOT EXISTS olos_http.corporate_readoption_schema (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL CHECK(version=1)
);
INSERT INTO olos_http.corporate_readoption_schema VALUES(true,1) ON CONFLICT DO NOTHING;
ALTER TABLE olos_http.corporate_allocator_readoptions
 ADD COLUMN IF NOT EXISTS previous_adoption_id uuid REFERENCES olos_http.corporate_id_allocator(request_id),
 ADD COLUMN IF NOT EXISTS predecessor_digest text,
 ADD COLUMN IF NOT EXISTS predecessor_snapshot jsonb,
 ADD COLUMN IF NOT EXISTS quarantine_manifest jsonb,
 ADD COLUMN IF NOT EXISTS remote_contract_hash text,
 ADD COLUMN IF NOT EXISTS remote_schema_hash text,
 ADD COLUMN IF NOT EXISTS registration_cursor bigint,
 ADD COLUMN IF NOT EXISTS registration_end bigint,
 ADD COLUMN IF NOT EXISTS registration_digest text,
 ADD COLUMN IF NOT EXISTS registered_count bigint NOT NULL DEFAULT 0 CHECK(registered_count>=0),
 ADD COLUMN IF NOT EXISTS batch_count integer NOT NULL DEFAULT 0 CHECK(batch_count>=0),
 ADD COLUMN IF NOT EXISTS barrier_at timestamptz,
 ADD COLUMN IF NOT EXISTS activated_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_error text CHECK(last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
 ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
-- Replace only the draft's state checks. Preserve every existing request and its validation evidence.
DO $checks$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='olos_http.corporate_allocator_readoptions'::regclass
  AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%state%' AND conname<>'readoption_activation_invariants') LOOP
  IF NOT EXISTS(SELECT 1 FROM (VALUES
   ('corporate_allocator_readoptions_state_check',$known$CHECK ((state = ANY (ARRAY['prepared'::text, 'validating'::text, 'ready'::text, 'aborted'::text])))$known$),
   ('corporate_allocator_readoptions_check',$known$CHECK ((((state = 'ready'::text) AND (validated_at IS NOT NULL) AND (validation_digest IS NOT NULL)) OR ((state <> 'ready'::text) AND (validated_at IS NULL) AND (validation_digest IS NULL))))$known$),
   ('readoption_state_check',$known$CHECK ((state = ANY (ARRAY['prepared'::text, 'validating'::text, 'ready'::text, 'activating'::text, 'active'::text, 'aborted'::text])))$known$),
   ('readoption_validation_check',$known$CHECK ((((state = ANY (ARRAY['ready'::text, 'activating'::text, 'active'::text])) AND (validated_at IS NOT NULL) AND (validation_digest IS NOT NULL)) OR ((state = ANY (ARRAY['prepared'::text, 'validating'::text, 'aborted'::text])) AND ((validated_at IS NULL) = (validation_digest IS NULL)))))$known$)
  ) AS reviewed(name,definition) WHERE reviewed.name=c.conname AND reviewed.definition=c.definition) THEN
   RAISE EXCEPTION 'READOPTION_LOCAL_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE format('ALTER TABLE olos_http.corporate_allocator_readoptions DROP CONSTRAINT %I',c.conname);
 END LOOP;
 ALTER TABLE olos_http.corporate_allocator_readoptions ADD CONSTRAINT readoption_state_check
  CHECK(state IN ('prepared','validating','ready','activating','active','aborted'));
 ALTER TABLE olos_http.corporate_allocator_readoptions ADD CONSTRAINT readoption_validation_check CHECK(
  (state IN ('ready','activating','active') AND validated_at IS NOT NULL AND validation_digest IS NOT NULL)
  OR (state IN ('prepared','validating','aborted') AND (validated_at IS NULL)=(validation_digest IS NULL)));
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='olos_http.corporate_allocator_readoptions'::regclass AND conname='readoption_activation_invariants') THEN
  ALTER TABLE olos_http.corporate_allocator_readoptions ADD CONSTRAINT readoption_activation_invariants CHECK(
   (state NOT IN ('activating','active') OR (previous_adoption_id IS NOT NULL AND predecessor_digest ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(quarantine_manifest)='array' AND remote_contract_hash ~ '^[0-9a-f]{64}$'
    AND remote_schema_hash ~ '^[0-9a-f]{64}$' AND registration_digest ~ '^[0-9a-f]{64}$' AND barrier_at IS NOT NULL))
   AND ((state='active')=(activated_at IS NOT NULL)));
 END IF;
END $checks$;
DROP INDEX olos_http.corporate_allocator_readoption_one_open;
CREATE UNIQUE INDEX corporate_allocator_readoption_one_open ON olos_http.corporate_allocator_readoptions(source_key)
 WHERE state IN ('prepared','validating','ready','activating','active');
ALTER TABLE olos_http.corporate_control ADD COLUMN IF NOT EXISTS id_allocator_generation uuid;
DO $fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='olos_http.corporate_control'::regclass AND conname='corporate_control_readoption_fk') THEN
  ALTER TABLE olos_http.corporate_control ADD CONSTRAINT corporate_control_readoption_fk
   FOREIGN KEY(source_key,id_allocator_generation) REFERENCES olos_http.corporate_allocator_readoptions(source_key,request_id);
 END IF;
END $fk$;
ALTER TABLE olos_http.corporate_collision_quarantine_runs ADD COLUMN IF NOT EXISTS readoption_request_id uuid
 REFERENCES olos_http.corporate_allocator_readoptions(request_id);
CREATE TABLE IF NOT EXISTS olos_http.corporate_readoption_batches (
 request_id uuid NOT NULL REFERENCES olos_http.corporate_allocator_readoptions(request_id),
 batch_no integer NOT NULL CHECK(batch_no>0),
 first_id bigint NOT NULL, last_id bigint NOT NULL, member_count integer NOT NULL CHECK(member_count>0),
 members jsonb NOT NULL CHECK(jsonb_typeof(members)='array' AND jsonb_array_length(members)=member_count),
 chain_hash text NOT NULL CHECK(chain_hash ~ '^[0-9a-f]{64}$'),
 quarantine_digest text NOT NULL CHECK(quarantine_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,batch_no), CHECK(first_id<=last_id)
);
ALTER TABLE olos_http.corporate_id_admissions ADD COLUMN IF NOT EXISTS allocator_generation uuid
 REFERENCES olos_http.corporate_allocator_readoptions(request_id);
ALTER TABLE olos_http.corporate_id_assignments ADD COLUMN IF NOT EXISTS allocator_generation uuid
 REFERENCES olos_http.corporate_allocator_readoptions(request_id);
DO $generation_keys$ DECLARE t text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='olos_http.corporate_id_allocator'::regclass AND conname='corporate_allocator_source_request_unique') THEN
  ALTER TABLE olos_http.corporate_id_allocator ADD CONSTRAINT corporate_allocator_source_request_unique UNIQUE(source_key,request_id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='olos_http.corporate_allocator_readoptions'::regclass AND conname='readoption_previous_adoption_fk') THEN
  ALTER TABLE olos_http.corporate_allocator_readoptions ADD CONSTRAINT readoption_previous_adoption_fk FOREIGN KEY(source_key,previous_adoption_id)
   REFERENCES olos_http.corporate_id_allocator(source_key,request_id);
 END IF;
 FOREACH t IN ARRAY ARRAY['corporate_id_admissions','corporate_id_assignments'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('olos_http.'||t)::regclass AND conname=t||'_generation_fk') THEN
   EXECUTE format('ALTER TABLE olos_http.%I ADD CONSTRAINT %I FOREIGN KEY(source_key,allocator_generation) REFERENCES olos_http.corporate_allocator_readoptions(source_key,request_id)',t,t||'_generation_fk');
  END IF;
 END LOOP;
END $generation_keys$;
-- The fence row is independent of delivery's control-row lock, so a slow
-- corporate INSERT cannot delay capture. Its version changes only with authority.
CREATE TABLE IF NOT EXISTS olos_http.corporate_allocation_fence (
 source_key text PRIMARY KEY,binding text NOT NULL,target_table text NOT NULL,
 required boolean NOT NULL,generation_id uuid,epoch bigint NOT NULL DEFAULT 0 CHECK(epoch>=0),
 FOREIGN KEY(source_key,generation_id) REFERENCES olos_http.corporate_allocator_readoptions(source_key,request_id)
);
INSERT INTO olos_http.corporate_allocation_fence(source_key,binding,target_table,required,generation_id)
 SELECT source_key,binding,target_table,id_allocator_required,id_allocator_generation FROM olos_http.corporate_control WHERE singleton ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION olos_http.guard_readoption_fence() RETURNS trigger LANGUAGE plpgsql AS $fence_row$
BEGIN
 IF TG_OP='DELETE' OR OLD.generation_id IS NOT NULL THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_IRREVERSIBLE' USING ERRCODE='55000'; END IF;
 IF NEW.epoch<>OLD.epoch+1 THEN RAISE EXCEPTION 'READOPTION_LOCAL_CONTRACT_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $fence_row$;
CREATE OR REPLACE TRIGGER corporate_readoption_fence BEFORE UPDATE OR DELETE ON olos_http.corporate_allocation_fence
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_readoption_fence();
ALTER TABLE olos_http.corporate_allocation_fence ENABLE ALWAYS TRIGGER corporate_readoption_fence;
CREATE OR REPLACE FUNCTION olos_http.check_readoption_fence() RETURNS trigger LANGUAGE plpgsql AS $fence_check$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM olos_http.corporate_allocation_fence f JOIN olos_http.corporate_control c ON c.singleton AND c.source_key=f.source_key
   WHERE f.source_key=NEW.source_key AND f.binding=c.binding AND f.target_table=c.target_table
    AND f.required=c.id_allocator_required AND f.generation_id IS NOT DISTINCT FROM c.id_allocator_generation) THEN
  RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $fence_check$;
DO $fence_trigger$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='olos_http.corporate_allocation_fence'::regclass AND tgname='corporate_readoption_fence_consistency') THEN
  CREATE CONSTRAINT TRIGGER corporate_readoption_fence_consistency AFTER INSERT OR UPDATE ON olos_http.corporate_allocation_fence
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION olos_http.check_readoption_fence();
 END IF;
END $fence_trigger$;
ALTER TABLE olos_http.corporate_allocation_fence ENABLE ALWAYS TRIGGER corporate_readoption_fence_consistency;
CREATE OR REPLACE FUNCTION olos_http.stamp_readoption_generation() RETURNS trigger LANGUAGE plpgsql AS $stamp$
DECLARE c record; s text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(17320914,5);
 PERFORM 1 FROM olos_http.corporate_allocation_fence WHERE source_key=NEW.source_key FOR SHARE;
 IF NOT FOUND AND EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE singleton AND source_key=NEW.source_key) THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO c FROM olos_http.corporate_control WHERE singleton AND source_key=NEW.source_key;
 IF c.id_allocator_generation IS NULL THEN RETURN NEW; END IF;
 SELECT state INTO s FROM olos_http.corporate_allocator_readoptions WHERE request_id=c.id_allocator_generation;
 IF NEW.allocator_generation IS NOT NULL AND NEW.allocator_generation<>c.id_allocator_generation THEN
  RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='corporate_id_assignments' THEN
  IF (s='activating' AND NOT NEW.legacy) OR (s='active' AND NEW.legacy) OR s NOT IN ('activating','active') THEN
   RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 NEW.allocator_generation:=c.id_allocator_generation;
 RETURN NEW;
END $stamp$;
CREATE OR REPLACE TRIGGER corporate_readoption_generation BEFORE INSERT ON olos_http.corporate_id_admissions
 FOR EACH ROW EXECUTE FUNCTION olos_http.stamp_readoption_generation();
CREATE OR REPLACE TRIGGER corporate_readoption_generation BEFORE INSERT ON olos_http.corporate_id_assignments
 FOR EACH ROW EXECUTE FUNCTION olos_http.stamp_readoption_generation();
ALTER TABLE olos_http.corporate_id_admissions ENABLE ALWAYS TRIGGER corporate_readoption_generation;
ALTER TABLE olos_http.corporate_id_assignments ENABLE ALWAYS TRIGGER corporate_readoption_generation;
CREATE OR REPLACE FUNCTION olos_http.guard_readoption_record_fence() RETURNS trigger LANGUAGE plpgsql AS $fence$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(17320914,5);
 -- Lock the current row: an old REPEATABLE READ snapshot must serialize-fail,
 -- not observe a pre-barrier false flag. The lock is held until writer COMMIT.
 PERFORM 1 FROM olos_http.corporate_allocation_fence WHERE source_key=NEW.source_key FOR SHARE;
 IF NOT FOUND AND EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE singleton AND source_key=NEW.source_key) THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $fence$;
CREATE OR REPLACE TRIGGER corporate_readoption_record_fence BEFORE INSERT OR UPDATE ON olos_http.records
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_readoption_record_fence();
CREATE OR REPLACE FUNCTION olos_http.guard_readoption_local_raw() RETURNS trigger LANGUAGE plpgsql AS $raw$
DECLARE c record; BEGIN
 PERFORM pg_advisory_xact_lock_shared(17320914,5);
 PERFORM 1 FROM olos_http.corporate_allocation_fence WHERE source_key=(SELECT source_key FROM olos_http.corporate_control WHERE singleton) FOR SHARE;
 IF NOT FOUND AND EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE singleton) THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO c FROM olos_http.corporate_control WHERE singleton;
 IF c.id_allocator_required
  AND c.target_table::regclass=TG_RELID AND (TG_OP='INSERT' OR NEW.internal_id_olos IS DISTINCT FROM OLD.internal_id_olos) THEN
  RAISE EXCEPTION 'ALLOCATOR_LEGACY_GENERATION_FORBIDDEN' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $raw$;
CREATE OR REPLACE TRIGGER corporate_readoption_local_raw BEFORE INSERT OR UPDATE OF internal_id_olos ON raw.olos_calls
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_readoption_local_raw();
CREATE OR REPLACE FUNCTION olos_http.guard_readoption_control() RETURNS trigger LANGUAGE plpgsql AS $control$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.id_allocator_generation IS NOT NULL THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_IRREVERSIBLE' USING ERRCODE='55000'; END IF;
  RAISE EXCEPTION 'READOPTION_CONTROL_INVALID' USING ERRCODE='55000';
 END IF;
 IF OLD.id_allocator_generation IS NOT NULL AND (NEW.id_allocator_generation IS DISTINCT FROM OLD.id_allocator_generation
   OR NOT NEW.id_allocator_required OR NEW.source_key<>OLD.source_key OR NEW.binding<>OLD.binding OR NEW.target_table<>OLD.target_table) THEN
  RAISE EXCEPTION 'READOPTION_AUTHORITY_IRREVERSIBLE' USING ERRCODE='55000';
 END IF;
 IF NEW.id_allocator_generation IS NOT NULL AND NOT NEW.id_allocator_required THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_IRREVERSIBLE' USING ERRCODE='55000'; END IF;
 IF NEW.id_allocator_generation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM olos_http.corporate_allocator_readoptions r
  WHERE r.request_id=NEW.id_allocator_generation AND r.source_key=NEW.source_key AND r.binding=NEW.binding
    AND r.target_table=NEW.target_table AND r.state IN ('activating','active')) THEN
  RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF (NEW.source_key,NEW.binding,NEW.target_table,NEW.id_allocator_required,NEW.id_allocator_generation) IS DISTINCT FROM
    (OLD.source_key,OLD.binding,OLD.target_table,OLD.id_allocator_required,OLD.id_allocator_generation) THEN
  PERFORM pg_advisory_xact_lock(17320914,5);
  UPDATE olos_http.corporate_allocation_fence SET source_key=NEW.source_key,binding=NEW.binding,target_table=NEW.target_table,
   required=NEW.id_allocator_required,generation_id=NEW.id_allocator_generation,epoch=epoch+1 WHERE source_key=OLD.source_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $control$;
CREATE OR REPLACE TRIGGER corporate_readoption_control BEFORE UPDATE OR DELETE ON olos_http.corporate_control
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_readoption_control();
CREATE OR REPLACE FUNCTION olos_http.guard_readoption_request() RETURNS trigger LANGUAGE plpgsql AS $request$
DECLARE n bigint; total bigint; tail record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'READOPTION_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW.request_id<>OLD.request_id OR NEW.source_key<>OLD.source_key OR NEW.previous_reversion_id<>OLD.previous_reversion_id
  OR NEW.binding<>OLD.binding OR NEW.target_table<>OLD.target_table OR NEW.evidence_ref<>OLD.evidence_ref OR NEW.created_at<>OLD.created_at
  OR (OLD.previous_adoption_id IS NOT NULL AND NEW.previous_adoption_id IS DISTINCT FROM OLD.previous_adoption_id)
  OR (OLD.validation_digest IS NOT NULL AND (NEW.validation_digest IS DISTINCT FROM OLD.validation_digest OR NEW.validated_at IS DISTINCT FROM OLD.validated_at))
  OR (OLD.predecessor_digest IS NOT NULL AND (NEW.predecessor_digest IS DISTINCT FROM OLD.predecessor_digest
    OR NEW.predecessor_snapshot IS DISTINCT FROM OLD.predecessor_snapshot OR NEW.quarantine_manifest IS DISTINCT FROM OLD.quarantine_manifest OR NEW.remote_contract_hash IS DISTINCT FROM OLD.remote_contract_hash
    OR NEW.remote_schema_hash IS DISTINCT FROM OLD.remote_schema_hash))
  OR (OLD.barrier_at IS NOT NULL AND (NEW.barrier_at IS DISTINCT FROM OLD.barrier_at OR NEW.registration_end IS DISTINCT FROM OLD.registration_end))
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
  RAISE EXCEPTION 'READOPTION_EVIDENCE_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF OLD.barrier_at IS NOT NULL THEN
  SELECT count(*),coalesce(sum(member_count),0) INTO n,total FROM olos_http.corporate_readoption_batches WHERE request_id=OLD.request_id;
  SELECT batch_no,last_id,chain_hash INTO tail FROM olos_http.corporate_readoption_batches WHERE request_id=OLD.request_id ORDER BY batch_no DESC LIMIT 1;
  IF NEW.batch_count<>n OR NEW.registered_count<>total OR (n=0 AND (NEW.registration_cursor IS NOT NULL OR NEW.registration_digest IS DISTINCT FROM OLD.registration_digest))
   OR (n>0 AND (NEW.batch_count<>tail.batch_no OR NEW.registration_cursor IS DISTINCT FROM tail.last_id OR NEW.registration_digest IS DISTINCT FROM tail.chain_hash)) THEN
   RAISE EXCEPTION 'READOPTION_REGISTRATION_CHANGED' USING ERRCODE='55000';
  END IF;
 END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='prepared' AND NEW.state IN ('validating','aborted'))
   OR (OLD.state='validating' AND NEW.state IN ('ready','aborted')) OR (OLD.state='ready' AND NEW.state IN ('activating','aborted'))
   OR (OLD.state='activating' AND NEW.state='active')) THEN
  RAISE EXCEPTION 'READOPTION_TRANSITION_INVALID' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $request$;
CREATE OR REPLACE TRIGGER corporate_readoption_request BEFORE UPDATE OR DELETE ON olos_http.corporate_allocator_readoptions
 FOR EACH ROW EXECUTE FUNCTION olos_http.guard_readoption_request();
CREATE OR REPLACE FUNCTION olos_http.guard_readoption_history() RETURNS trigger LANGUAGE plpgsql AS $history$
DECLARE c record; s text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(17320914,5);
 PERFORM 1 FROM olos_http.corporate_allocation_fence WHERE source_key=(SELECT source_key FROM olos_http.corporate_control WHERE singleton) FOR SHARE;
 IF NOT FOUND AND EXISTS(SELECT 1 FROM olos_http.corporate_control WHERE singleton) THEN RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO c FROM olos_http.corporate_control WHERE singleton;
 IF c.id_allocator_generation IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF to_jsonb(OLD)->>'source_key' IS NOT NULL AND to_jsonb(OLD)->>'source_key'<>c.source_key THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 SELECT state INTO s FROM olos_http.corporate_allocator_readoptions WHERE request_id=c.id_allocator_generation;
 IF TG_TABLE_NAME='records' THEN
  IF TG_OP='DELETE' OR s='activating' THEN RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000'; END IF;
  IF (NEW.source_key,NEW.source_id,NEW.target_table,NEW.target_id,NEW.source_hash) IS DISTINCT FROM
     (OLD.source_key,OLD.source_id,OLD.target_table,OLD.target_id,OLD.source_hash) THEN RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000'; END IF;
 ELSIF TG_TABLE_NAME='corporate_id_allocator' THEN
  IF TG_OP='DELETE' OR (NEW.source_key,NEW.request_id,NEW.evidence_ref,NEW.binding,NEW.target_table) IS DISTINCT FROM
    (OLD.source_key,OLD.request_id,OLD.evidence_ref,OLD.binding,OLD.target_table) OR (OLD.state='active' AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000'; END IF;
  IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM olos_http.corporate_allocator_readoptions r WHERE r.request_id=c.id_allocator_generation
    AND r.state='active' AND r.remote_contract_hash=NEW.contract_hash AND r.activated_at=NEW.adopted_at) THEN
   RAISE EXCEPTION 'READOPTION_AUTHORITY_EVIDENCE_CHANGED' USING ERRCODE='55000'; END IF;
 ELSIF TG_TABLE_NAME='corporate_id_admissions' THEN
  IF TG_OP='DELETE' OR (NEW.source_key,NEW.source_id,NEW.source_hash,NEW.request_id,NEW.mapped,NEW.mapped_hash,NEW.allocator_generation) IS DISTINCT FROM
    (OLD.source_key,OLD.source_id,OLD.source_hash,OLD.request_id,OLD.mapped,OLD.mapped_hash,OLD.allocator_generation) OR (OLD.materialized AND NOT NEW.materialized)
    OR (NEW.materialized IS DISTINCT FROM OLD.materialized AND s<>'active') THEN
   RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000'; END IF;
 ELSIF TG_TABLE_NAME='corporate_outbox' THEN
  IF TG_OP='DELETE' OR s='activating' THEN RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000'; END IF;
  IF (NEW.source_key,NEW.source_id,NEW.target_id,NEW.source_hash,NEW.payload,NEW.payload_hash,NEW.origin,NEW.created_at) IS DISTINCT FROM
     (OLD.source_key,OLD.source_id,OLD.target_id,OLD.source_hash,OLD.payload,OLD.payload_hash,OLD.origin,OLD.created_at) THEN RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000'; END IF;
 ELSE RAISE EXCEPTION 'READOPTION_HISTORY_FROZEN' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $history$;
DO $history_triggers$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['records','corporate_outbox','corporate_id_allocator','corporate_id_admissions','corporate_id_assignments','corporate_id_reversions','corporate_id_reversion_batches','corporate_collision_quarantine','corporate_collision_quarantine_runs','corporate_readoption_batches'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER corporate_readoption_history BEFORE UPDATE OR DELETE ON olos_http.%I FOR EACH ROW EXECUTE FUNCTION olos_http.guard_readoption_history()',t);
  EXECUTE format('ALTER TABLE olos_http.%I ENABLE ALWAYS TRIGGER corporate_readoption_history',t);
 END LOOP;
END $history_triggers$;
ALTER TABLE olos_http.records ENABLE ALWAYS TRIGGER corporate_readoption_record_fence;
ALTER TABLE olos_http.records ENABLE ALWAYS TRIGGER corporate_id_assignment_required;
ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER corporate_readoption_local_raw;
ALTER TABLE olos_http.corporate_control ENABLE ALWAYS TRIGGER corporate_readoption_control;
ALTER TABLE olos_http.corporate_allocator_readoptions ENABLE ALWAYS TRIGGER corporate_readoption_request;
COMMENT ON COLUMN olos_http.corporate_control.id_allocator_generation IS 'Monotonic corporate authority latch. Never reset to legacy; original adoption/reversion UUIDs remain unchanged.';
COMMIT;
