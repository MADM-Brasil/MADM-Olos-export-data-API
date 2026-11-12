-- MADM ONLY. DBA-reviewed adoption prerequisite. Does not update historical calls or existing sequences.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $check$ BEGIN
  IF current_database()<>'madm' OR current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'CORPORATE_DATABASE_CONTRACT_INVALID';
  END IF;
END $check$;
LOCK TABLE raw.olos_calls IN SHARE ROW EXCLUSIVE MODE;
CREATE SCHEMA IF NOT EXISTS olos_delivery_ids;
REVOKE ALL ON SCHEMA olos_delivery_ids FROM PUBLIC;
CREATE TABLE IF NOT EXISTS olos_delivery_ids.counter (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  next_candidate bigint NOT NULL CHECK(next_candidate BETWEEN 1 AND 2147483648)
);
CREATE TABLE IF NOT EXISTS olos_delivery_ids.registry (
  internal_id integer PRIMARY KEY,
  state text NOT NULL CHECK(state IN ('reserved','used')),
  owner_role name,
  binding text,
  source_id text,
  source_hash text,
  request_id uuid UNIQUE,
  token uuid UNIQUE,
  used_raw_id bigint,
  UNIQUE(owner_role,binding,source_id),
  CHECK(state='used' OR (owner_role IS NOT NULL AND binding IS NOT NULL AND source_id IS NOT NULL
    AND source_hash IS NOT NULL AND token IS NOT NULL))
);
DO $bootstrap$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM olos_delivery_ids.counter) THEN
    INSERT INTO olos_delivery_ids.registry(internal_id,state,used_raw_id)
      SELECT internal_id_olos,'used',raw_olos_call_id FROM raw.olos_calls WHERE internal_id_olos IS NOT NULL;
    INSERT INTO olos_delivery_ids.counter VALUES(true,1);
  ELSIF EXISTS(SELECT 1 FROM raw.olos_calls d LEFT JOIN olos_delivery_ids.registry r ON r.internal_id=d.internal_id_olos
    WHERE d.internal_id_olos IS NOT NULL AND (r.state IS DISTINCT FROM 'used' OR r.used_raw_id IS DISTINCT FROM d.raw_olos_call_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P3105', MESSAGE='ALLOCATOR_REGISTRY_DIVERGES';
  END IF;
END $bootstrap$;
CREATE OR REPLACE FUNCTION olos_delivery_ids.reserve(p_binding text,p_requests jsonb,p_legacy boolean)
RETURNS TABLE(id integer,reservation_token uuid,reserved_source_id text,reserved_source_hash text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $reserve$
DECLARE
  item jsonb;
  occupied olos_delivery_ids.registry%ROWTYPE;
  candidate bigint;
  chosen integer;
  new_token uuid;
  affected integer;
BEGIN
  IF p_binding !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_requests)<>'array'
    OR jsonb_array_length(p_requests)>2000 OR p_binding IS NULL OR p_requests IS NULL OR p_legacy IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P3106', MESSAGE='ALLOCATOR_REQUEST_INVALID';
  END IF;
  SELECT c.next_candidate INTO STRICT candidate FROM olos_delivery_ids.counter c WHERE c.singleton FOR UPDATE;
  IF candidate<1 OR candidate>2147483648 THEN RAISE EXCEPTION USING ERRCODE='P3105', MESSAGE='ALLOCATOR_REGISTRY_DIVERGES'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_requests) LOOP
    reserved_source_id:=item->>'source_id'; reserved_source_hash:=item->>'source_hash';
    IF item->>'source_id' IS NULL OR item->>'source_hash' IS NULL THEN RAISE EXCEPTION USING ERRCODE='P3106', MESSAGE='ALLOCATOR_REQUEST_INVALID'; END IF;
    SELECT r.* INTO occupied FROM olos_delivery_ids.registry r
      WHERE r.owner_role=session_user AND r.binding=p_binding AND r.source_id=item->>'source_id';
    IF FOUND THEN
      IF occupied.source_hash<>item->>'source_hash'
        OR (p_legacy AND occupied.internal_id<>(item->>'id')::integer)
        OR (NOT p_legacy AND occupied.request_id IS DISTINCT FROM (item->>'request_id')::uuid) THEN
        RAISE EXCEPTION USING ERRCODE='P3102', MESSAGE='ALLOCATOR_REQUEST_CONFLICT';
      END IF;
      id:=occupied.internal_id; reservation_token:=occupied.token; RETURN NEXT; CONTINUE;
    END IF;
    IF p_legacy THEN
      chosen:=(item->>'id')::integer;
      IF chosen IS NULL THEN RAISE EXCEPTION USING ERRCODE='P3106', MESSAGE='ALLOCATOR_REQUEST_INVALID'; END IF;
      SELECT r.* INTO occupied FROM olos_delivery_ids.registry r WHERE r.internal_id=chosen;
      IF FOUND THEN
        IF occupied.state<>'used' THEN RAISE EXCEPTION USING ERRCODE='P3104', MESSAGE='ALLOCATOR_LEGACY_ID_RESERVED'; END IF;
        id:=chosen; reservation_token:=NULL; RETURN NEXT; CONTINUE;
      END IF;
    ELSIF item->>'request_id' IS NULL THEN RAISE EXCEPTION USING ERRCODE='P3106', MESSAGE='ALLOCATOR_REQUEST_INVALID';
    END IF;
    LOOP
      IF NOT p_legacy THEN
        IF candidate>2147483647 THEN RAISE EXCEPTION USING ERRCODE='P3101', MESSAGE='ALLOCATOR_INT32_EXHAUSTED'; END IF;
        chosen:=candidate::integer; candidate:=candidate+1;
      END IF;
      new_token:=gen_random_uuid();
      INSERT INTO olos_delivery_ids.registry(internal_id,state,owner_role,binding,source_id,source_hash,request_id,token)
        VALUES(chosen,'reserved',session_user,p_binding,item->>'source_id',item->>'source_hash',
          CASE WHEN p_legacy THEN NULL ELSE (item->>'request_id')::uuid END,new_token)
        ON CONFLICT(internal_id) DO NOTHING;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected=1 THEN
        IF EXISTS(SELECT 1 FROM raw.olos_calls d WHERE d.internal_id_olos=chosen) THEN RAISE EXCEPTION USING ERRCODE='P3105', MESSAGE='ALLOCATOR_REGISTRY_DIVERGES'; END IF;
        EXIT;
      END IF;
      IF p_legacy THEN
        SELECT r.* INTO STRICT occupied FROM olos_delivery_ids.registry r WHERE r.internal_id=chosen;
        IF occupied.state<>'used' THEN RAISE EXCEPTION USING ERRCODE='P3104', MESSAGE='ALLOCATOR_LEGACY_ID_RESERVED'; END IF;
        new_token:=NULL; EXIT;
      END IF;
      -- Find the next actual registry gap using indexes, rather than looping
      -- once per historical ID. The counter lock serializes allocators; the
      -- registry PK still arbitrates concurrent external corporate writers.
      SELECT coalesce((SELECT r.internal_id::bigint+1 FROM olos_delivery_ids.registry r
        WHERE r.internal_id>=chosen AND NOT EXISTS(SELECT 1 FROM olos_delivery_ids.registry n
          WHERE n.internal_id=r.internal_id::bigint+1) ORDER BY r.internal_id LIMIT 1),2147483648) INTO candidate;
    END LOOP;
    id:=chosen; reservation_token:=new_token; RETURN NEXT;
  END LOOP;
  UPDATE olos_delivery_ids.counter SET next_candidate=candidate WHERE singleton;
END;
$reserve$;
CREATE OR REPLACE FUNCTION olos_delivery_ids.guard_internal_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $guard$
DECLARE
  occupied olos_delivery_ids.registry%ROWTYPE;
  affected integer;
BEGIN
  IF NEW.internal_id_olos IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.internal_id_olos IS NOT DISTINCT FROM OLD.internal_id_olos THEN RETURN NEW; END IF;
  INSERT INTO olos_delivery_ids.registry(internal_id,state,used_raw_id)
    VALUES(NEW.internal_id_olos,'used',NEW.raw_olos_call_id) ON CONFLICT(internal_id) DO NOTHING;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN RETURN NEW; END IF;
  SELECT r.* INTO STRICT occupied FROM olos_delivery_ids.registry r WHERE r.internal_id=NEW.internal_id_olos FOR UPDATE;
  IF occupied.state<>'reserved' OR occupied.owner_role<>session_user
    OR occupied.token::text IS DISTINCT FROM current_setting('olos_delivery_ids.token',true) THEN
    RAISE EXCEPTION USING ERRCODE='P3103', MESSAGE='ALLOCATOR_ID_NOT_OWNED';
  END IF;
  UPDATE olos_delivery_ids.registry SET state='used',used_raw_id=NEW.raw_olos_call_id WHERE internal_id=NEW.internal_id_olos;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON ALL TABLES IN SCHEMA olos_delivery_ids FROM PUBLIC;
REVOKE ALL ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION olos_delivery_ids.guard_internal_id() FROM PUBLIC;
CREATE OR REPLACE TRIGGER trg_olos_calls_reserve_internal_id
  BEFORE INSERT OR UPDATE OF internal_id_olos ON raw.olos_calls
  FOR EACH ROW EXECUTE FUNCTION olos_delivery_ids.guard_internal_id();
ALTER TABLE raw.olos_calls ENABLE ALWAYS TRIGGER trg_olos_calls_reserve_internal_id;
COMMIT;
-- DBA: GRANT USAGE ON SCHEMA olos_delivery_ids TO the_existing_delivery_role;
-- DBA: GRANT EXECUTE ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) TO the_existing_delivery_role;
