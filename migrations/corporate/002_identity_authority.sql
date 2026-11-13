-- MADM ONLY. Self-contained one-time install with namespace absence as a precondition.
-- Not a live v1 upgrade. Do not install 001 first on a new MADM.
-- Stop/inventory all writers. Duplicate complete identities remain ambiguous;
-- existing authorities block installation. Historical calls and raw IDs are never edited.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
LOCK TABLE raw.olos_calls IN SHARE ROW EXCLUSIVE MODE;
DO $namespace$ BEGIN
 IF to_regnamespace('olos_delivery_ids') IS NOT NULL THEN
  RAISE EXCEPTION 'ALLOCATOR_EXISTING_AUTHORITY_REQUIRES_RECONCILIATION';
 END IF;
END;
$namespace$;
CREATE SCHEMA olos_delivery_ids;
REVOKE ALL ON SCHEMA olos_delivery_ids FROM PUBLIC;
CREATE TABLE olos_delivery_ids.counter (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 next_candidate bigint NOT NULL CHECK(next_candidate BETWEEN 1 AND 2147483648)
);
CREATE TABLE olos_delivery_ids.registry (
 internal_id integer PRIMARY KEY,state text NOT NULL CHECK(state IN ('reserved','used')),
 owner_role name,binding text,source_id text,source_hash text,request_id uuid UNIQUE,token uuid UNIQUE,used_raw_id bigint,
 UNIQUE(owner_role,binding,source_id),
 CHECK(state='used' OR (owner_role IS NOT NULL AND binding IS NOT NULL AND source_id IS NOT NULL AND source_hash IS NOT NULL AND token IS NOT NULL))
);
LOCK TABLE olos_delivery_ids.registry,olos_delivery_ids.counter IN ACCESS EXCLUSIVE MODE;
DO $precondition$ BEGIN
 IF current_database()<>'madm' OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'CORPORATE_DATABASE_CONTRACT_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation
   WHERE a.attrelid='raw.olos_calls'::regclass AND a.attname IN ('olos_call_id','telefone','id_campanha_olos')
    AND NOT c.collisdeterministic) THEN
  RAISE EXCEPTION 'ALLOCATOR_IDENTITY_COLLATION_UNSUPPORTED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM olos_delivery_ids.counter) THEN
  INSERT INTO olos_delivery_ids.registry(internal_id,state,used_raw_id)
   SELECT internal_id_olos,'used',raw_olos_call_id FROM raw.olos_calls WHERE internal_id_olos IS NOT NULL;
  INSERT INTO olos_delivery_ids.counter VALUES(true,1);
 END IF;
 IF EXISTS(SELECT 1 FROM olos_delivery_ids.registry WHERE state<>'used' OR binding IS NOT NULL OR token IS NOT NULL)
   OR EXISTS(SELECT 1 FROM raw.olos_calls d LEFT JOIN olos_delivery_ids.registry r ON r.internal_id=d.internal_id_olos
     WHERE d.internal_id_olos IS NOT NULL AND (r.used_raw_id IS DISTINCT FROM d.raw_olos_call_id OR r.state IS DISTINCT FROM 'used')) THEN
  RAISE EXCEPTION 'ALLOCATOR_V1_RESERVATIONS_REQUIRE_RECONCILIATION'; END IF;
END;
$precondition$;
-- Canonical identity uses the destination's exact SQL types and UTC for timestamptz.
-- NULL/incomplete historical identities cannot equal a valid delivery identity.
CREATE FUNCTION olos_delivery_ids.call_identity(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $identity$
DECLARE r raw.olos_calls%ROWTYPE; BEGIN
 SELECT * INTO r FROM jsonb_populate_record(NULL::raw.olos_calls,p_payload);
 IF r.olos_call_id IS NULL OR r.data_ligacao IS NULL OR r.telefone IS NULL OR r.id_campanha_olos IS NULL
   OR btrim(r.olos_call_id)='' OR btrim(r.telefone)='' OR btrim(r.id_campanha_olos)='' THEN RETURN NULL; END IF;
 RETURN jsonb_build_array(r.olos_call_id,r.data_ligacao,r.telefone,r.id_campanha_olos);
END;
$identity$;
CREATE TABLE olos_delivery_ids.identities (
 identity_hash text PRIMARY KEY CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
 identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='array' AND jsonb_array_length(identity)=4),
 internal_id integer UNIQUE REFERENCES olos_delivery_ids.registry(internal_id),
 used_raw_id bigint UNIQUE,
 source_key text,
 source_id text,
 ambiguous_raw_ids bigint[],
 UNIQUE(source_key,source_id),
 CHECK((source_key IS NULL)=(source_id IS NULL)),
 CHECK(internal_id IS NOT NULL OR used_raw_id IS NOT NULL OR coalesce(cardinality(ambiguous_raw_ids),0)>1),
 CHECK(ambiguous_raw_ids IS NULL OR (cardinality(ambiguous_raw_ids)>1 AND internal_id IS NULL
   AND used_raw_id IS NULL AND source_key IS NULL AND source_id IS NULL))
);
WITH historical AS (
 SELECT k.identity,array_agg(d.internal_id_olos ORDER BY d.raw_olos_call_id) AS internal_ids,
   array_agg(d.raw_olos_call_id ORDER BY d.raw_olos_call_id) AS raw_ids
 FROM raw.olos_calls d CROSS JOIN LATERAL (SELECT olos_delivery_ids.call_identity(to_jsonb(d)) AS identity) k
 WHERE k.identity IS NOT NULL GROUP BY k.identity
)
INSERT INTO olos_delivery_ids.identities(identity_hash,identity,internal_id,used_raw_id,ambiguous_raw_ids)
 SELECT encode(sha256(convert_to(identity::text,'UTF8')),'hex'),identity,
   CASE WHEN cardinality(raw_ids)=1 THEN internal_ids[1] END,
   CASE WHEN cardinality(raw_ids)=1 THEN raw_ids[1] END,
   CASE WHEN cardinality(raw_ids)>1 THEN raw_ids END
 FROM historical;
-- Every non-NULL internal ID is already occupied in registry, including all
-- members of ambiguous groups. No member is selected as their owner. NULL-ID
-- members remain identifiable by raw ID. Ambiguity is durable, never auto-cleared.
CREATE FUNCTION olos_delivery_ids.assert_unambiguous(p_payloads jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $unambiguous$
BEGIN
 IF p_payloads IS NULL OR jsonb_typeof(p_payloads)<>'array' OR jsonb_array_length(p_payloads)>2000 THEN
  RAISE EXCEPTION USING ERRCODE='P3106',MESSAGE='ALLOCATOR_REQUEST_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payloads) p
   JOIN olos_delivery_ids.identities i ON i.identity_hash=
     encode(sha256(convert_to(olos_delivery_ids.call_identity(p.value)::text,'UTF8')),'hex')
   WHERE i.ambiguous_raw_ids IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='P3110',MESSAGE='AMBIGUOUS_LOGICAL_IDENTITY'; END IF;
END;
$unambiguous$;
CREATE OR REPLACE FUNCTION olos_delivery_ids.reserve(p_binding text,p_requests jsonb,p_legacy boolean)
RETURNS TABLE(id integer,reservation_token uuid,reserved_source_id text,reserved_source_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $reserve$
DECLARE item jsonb; occupied olos_delivery_ids.registry%ROWTYPE;
 claim olos_delivery_ids.identities%ROWTYPE; k jsonb; h text;
 candidate bigint; chosen integer; new_token uuid; affected integer;
BEGIN
 IF p_binding IS NULL OR p_binding !~ '^[0-9a-f]{64}$' OR p_requests IS NULL OR jsonb_typeof(p_requests)<>'array'
   OR jsonb_array_length(p_requests)>2000 OR p_legacy IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P3106',MESSAGE='ALLOCATOR_REQUEST_INVALID'; END IF;
 SELECT next_candidate INTO STRICT candidate FROM olos_delivery_ids.counter WHERE singleton FOR UPDATE;
 FOR item IN SELECT value FROM jsonb_array_elements(p_requests) LOOP
  reserved_source_id:=item->>'source_id';reserved_source_hash:=item->>'source_hash';
  k:=olos_delivery_ids.call_identity(item->'payload');
  IF k IS NULL OR coalesce(item->>'source_key','')='' OR coalesce(reserved_source_id,'')=''
    OR reserved_source_hash IS NULL OR reserved_source_hash !~ '^[0-9a-f]{64}$'
    OR (NOT p_legacy AND item->>'request_id' IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='P3106',MESSAGE='ALLOCATOR_REQUEST_INVALID'; END IF;
  h:=encode(sha256(convert_to(k::text,'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM olos_delivery_ids.identities WHERE identity_hash=h AND ambiguous_raw_ids IS NOT NULL) THEN
   RAISE EXCEPTION USING ERRCODE='P3110',MESSAGE='AMBIGUOUS_LOGICAL_IDENTITY'; END IF;
  SELECT * INTO claim FROM olos_delivery_ids.identities WHERE source_key=item->>'source_key' AND source_id=reserved_source_id;
  IF FOUND THEN
   SELECT * INTO STRICT occupied FROM olos_delivery_ids.registry WHERE internal_id=claim.internal_id;
   IF claim.identity IS DISTINCT FROM k OR occupied.source_hash IS DISTINCT FROM reserved_source_hash OR occupied.binding IS DISTINCT FROM p_binding
     OR occupied.owner_role IS DISTINCT FROM session_user OR (p_legacy AND occupied.internal_id IS DISTINCT FROM (item->>'id')::integer)
     OR (NOT p_legacy AND occupied.request_id IS DISTINCT FROM (item->>'request_id')::uuid) THEN
    RAISE EXCEPTION USING ERRCODE='P3102',MESSAGE='ALLOCATOR_REQUEST_CONFLICT'; END IF;
   id:=occupied.internal_id;reservation_token:=occupied.token;RETURN NEXT;CONTINUE;
  END IF;
  -- Frozen quarantine registration is an isolation record, never ownership of
  -- somebody else's ID. It creates neither a reservation nor an identity claim.
  IF p_legacy AND item->>'isolated'='true' THEN
   chosen:=(item->>'id')::integer;
   SELECT * INTO occupied FROM olos_delivery_ids.registry WHERE internal_id=chosen;
   IF NOT FOUND OR occupied.state<>'used' THEN
    RAISE EXCEPTION USING ERRCODE='P3105',MESSAGE='ALLOCATOR_REGISTRY_DIVERGES'; END IF;
   id:=chosen;reservation_token:=NULL;RETURN NEXT;CONTINUE;
  END IF;
  SELECT * INTO claim FROM olos_delivery_ids.identities WHERE identity_hash=h;
  IF FOUND THEN
   IF claim.identity<>k THEN RAISE EXCEPTION USING ERRCODE='P3105',MESSAGE='ALLOCATOR_REGISTRY_DIVERGES'; END IF;
   IF NOT p_legacy OR claim.internal_id IS DISTINCT FROM (item->>'id')::integer THEN
    RAISE EXCEPTION USING ERRCODE='P3107',MESSAGE='LOGICAL_CALL_AT_DIFFERENT_ID'; END IF;
   SELECT * INTO STRICT occupied FROM olos_delivery_ids.registry WHERE internal_id=claim.internal_id;
   IF occupied.state<>'used' OR occupied.used_raw_id IS DISTINCT FROM claim.used_raw_id THEN
    RAISE EXCEPTION USING ERRCODE='P3104',MESSAGE='ALLOCATOR_LEGACY_ID_RESERVED'; END IF;
   id:=claim.internal_id;reservation_token:=NULL;RETURN NEXT;CONTINUE;
  END IF;
  IF p_legacy THEN
   chosen:=(item->>'id')::integer;
   IF chosen IS NULL THEN RAISE EXCEPTION USING ERRCODE='P3106',MESSAGE='ALLOCATOR_REQUEST_INVALID'; END IF;
   IF EXISTS(SELECT 1 FROM olos_delivery_ids.registry WHERE internal_id=chosen) THEN
    RAISE EXCEPTION USING ERRCODE='P3109',MESSAGE='INTERNAL_ID_COLLISION'; END IF;
  END IF;
  LOOP
   IF NOT p_legacy THEN
    IF candidate>2147483647 THEN RAISE EXCEPTION USING ERRCODE='P3101',MESSAGE='ALLOCATOR_INT32_EXHAUSTED'; END IF;
    chosen:=candidate::integer;candidate:=candidate+1;
   END IF;
   new_token:=gen_random_uuid();
   INSERT INTO olos_delivery_ids.registry(internal_id,state,owner_role,binding,source_id,source_hash,request_id,token)
    VALUES(chosen,'reserved',session_user,p_binding,reserved_source_id,reserved_source_hash,
      CASE WHEN p_legacy THEN NULL ELSE (item->>'request_id')::uuid END,new_token)
    ON CONFLICT(internal_id) DO NOTHING;
   GET DIAGNOSTICS affected=ROW_COUNT;
   IF affected=1 THEN
    IF EXISTS(SELECT 1 FROM raw.olos_calls WHERE internal_id_olos=chosen) THEN
     RAISE EXCEPTION USING ERRCODE='P3105',MESSAGE='ALLOCATOR_REGISTRY_DIVERGES'; END IF;
    EXIT;
   END IF;
   IF p_legacy THEN RAISE EXCEPTION USING ERRCODE='P3109',MESSAGE='INTERNAL_ID_COLLISION'; END IF;
   SELECT coalesce((SELECT r.internal_id::bigint+1 FROM olos_delivery_ids.registry r
    WHERE r.internal_id>=chosen AND NOT EXISTS(SELECT 1 FROM olos_delivery_ids.registry n WHERE n.internal_id=r.internal_id::bigint+1)
    ORDER BY r.internal_id LIMIT 1),2147483648) INTO candidate;
  END LOOP;
  INSERT INTO olos_delivery_ids.identities(identity_hash,identity,internal_id,source_key,source_id)
   VALUES(h,k,chosen,item->>'source_key',reserved_source_id);
  id:=chosen;reservation_token:=new_token;RETURN NEXT;
 END LOOP;
 UPDATE olos_delivery_ids.counter SET next_candidate=candidate WHERE singleton;
END;
$reserve$;
CREATE OR REPLACE FUNCTION olos_delivery_ids.guard_internal_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $guard$
DECLARE occupied olos_delivery_ids.registry%ROWTYPE; claim olos_delivery_ids.identities%ROWTYPE;
 k jsonb;h text;owned boolean:=false;affected integer;
BEGIN
 k:=olos_delivery_ids.call_identity(to_jsonb(NEW));
 IF TG_OP='UPDATE' THEN
  IF NEW.internal_id_olos IS DISTINCT FROM OLD.internal_id_olos OR NEW.raw_olos_call_id IS DISTINCT FROM OLD.raw_olos_call_id
    OR k IS DISTINCT FROM olos_delivery_ids.call_identity(to_jsonb(OLD)) THEN
   RAISE EXCEPTION USING ERRCODE='P3108',MESSAGE='ALLOCATOR_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 -- Same lock order as reserve(), including explicit-ID writers and COPY.
 PERFORM 1 FROM olos_delivery_ids.counter WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P3105',MESSAGE='ALLOCATOR_REGISTRY_DIVERGES'; END IF;
 IF k IS NOT NULL THEN
  h:=encode(sha256(convert_to(k::text,'UTF8')),'hex');
  SELECT * INTO claim FROM olos_delivery_ids.identities WHERE identity_hash=h;
  IF claim.ambiguous_raw_ids IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='P3110',MESSAGE='AMBIGUOUS_LOGICAL_IDENTITY'; END IF;
 END IF;
 IF NEW.internal_id_olos IS NOT NULL THEN
  INSERT INTO olos_delivery_ids.registry(internal_id,state,used_raw_id)
   VALUES(NEW.internal_id_olos,'used',NEW.raw_olos_call_id) ON CONFLICT(internal_id) DO NOTHING;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=0 THEN
   SELECT * INTO STRICT occupied FROM olos_delivery_ids.registry WHERE internal_id=NEW.internal_id_olos;
   IF occupied.state<>'reserved' OR occupied.owner_role<>session_user OR k IS NULL
    OR occupied.token::text IS DISTINCT FROM current_setting('olos_delivery_ids.token',true) THEN
    RAISE EXCEPTION USING ERRCODE='P3103',MESSAGE='ALLOCATOR_ID_NOT_OWNED'; END IF;
   owned:=true;
  END IF;
 END IF;
 IF k IS NOT NULL THEN
  IF claim.identity_hash IS NOT NULL THEN
   IF claim.identity<>k OR NOT owned OR claim.internal_id IS DISTINCT FROM NEW.internal_id_olos OR claim.used_raw_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P3107',MESSAGE='LOGICAL_CALL_AT_DIFFERENT_ID'; END IF;
   UPDATE olos_delivery_ids.identities SET used_raw_id=NEW.raw_olos_call_id WHERE identity_hash=h;
  ELSIF owned THEN RAISE EXCEPTION USING ERRCODE='P3103',MESSAGE='ALLOCATOR_ID_NOT_OWNED';
  ELSE
   INSERT INTO olos_delivery_ids.identities(identity_hash,identity,internal_id,used_raw_id)
    VALUES(h,k,NEW.internal_id_olos,NEW.raw_olos_call_id);
  END IF;
 END IF;
 IF owned THEN UPDATE olos_delivery_ids.registry SET state='used',used_raw_id=NEW.raw_olos_call_id WHERE internal_id=NEW.internal_id_olos; END IF;
 RETURN NEW;
END;
$guard$;
REVOKE ALL ON ALL TABLES IN SCHEMA olos_delivery_ids FROM PUBLIC;
REVOKE ALL ON FUNCTION olos_delivery_ids.call_identity(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION olos_delivery_ids.guard_internal_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION olos_delivery_ids.assert_unambiguous(jsonb) FROM PUBLIC;
CREATE OR REPLACE TRIGGER trg_olos_calls_reserve_internal_id BEFORE INSERT OR UPDATE ON raw.olos_calls
 FOR EACH ROW EXECUTE FUNCTION olos_delivery_ids.guard_internal_id();
ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER trg_olos_calls_reserve_internal_id;
COMMIT;
-- DBA: GRANT USAGE ON SCHEMA olos_delivery_ids TO the_existing_delivery_role;
-- DBA: GRANT EXECUTE ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) TO the_existing_delivery_role;
-- DBA: GRANT EXECUTE ON FUNCTION olos_delivery_ids.assert_unambiguous(jsonb) TO the_existing_delivery_role;
-- Writers need no table
-- privileges on registry/counter/identities and must not own or bypass guards.
