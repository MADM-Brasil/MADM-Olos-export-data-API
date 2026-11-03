import { createHash } from 'node:crypto';
import { identityColumns, mapRow, projection, type Shape } from '../corporate-sync/mapping.js';
import type { DeliveryConfig } from './config.js';
import { SyncError } from '../corporate-sync/errors.js';
import { deliveryDigest, hasOperator, mapDeliveryRow, operatorId } from './payload.js';
import { uniqueIdentities } from './contract.js';

export interface ConfirmedOperatorProof {
  source_id: string; target_id: string; source_hash: string; payload_hash: string;
  payload: Record<string, unknown>; agent_id: string | null;
  state: string; remote_raw_id: string; confirmed_at: unknown;
}
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// Offline SQL proposal ONLY: no DB client, file writes, CLI registration or automatic
// execution. A DBA must first quarantine the exact manifest locally and authorize
// a separate execution/reconciliation window; see the operator runbook.
export function operatorComplementProposal(entries: ConfirmedOperatorProof[], shape: Shape,
  functions: { trigger_body: string; normalizer_body: string }, cfg: DeliveryConfig) {
  if (!entries.length || entries.length > 3 || new Set(entries.map(e => e.source_id)).size !== entries.length ||
    !shape.has('id_operador_olos') || cfg.connection.writeEnabled) throw new SyncError('OPERATOR_COMPLEMENT_SCOPE_INVALID');
  const expected = entries.map(e => {
    if (e.state !== 'confirmed' || !e.confirmed_at || !/^[1-9][0-9]{0,18}$/.test(e.remote_raw_id) ||
      !/^[1-9][0-9]{0,18}$/.test(e.source_id) || !/^[a-f0-9]{64}$/.test(e.source_hash)) throw new SyncError('OPERATOR_CONFIRMED_PROOF_REQUIRED');
    const full = mapDeliveryRow(e.payload, shape, cfg.connection);
    if (deliveryDigest(full) !== e.payload_hash || full.internal_id_olos !== e.target_id) throw new SyncError('CORPORATE_PAYLOAD_CHANGED');
    if (hasOperator(full) && full.id_operador_olos !== operatorId(e.agent_id)) throw new SyncError('OPERATOR_REVISION_DIVERGES');
    return { source_id: e.source_id, target_id: e.target_id, source_hash: e.source_hash,
      original_payload_hash: e.payload_hash, remote_raw_id: e.remote_raw_id,
      payload: mapRow(full, shape, cfg.connection), agent_id: operatorId(e.agent_id) };
  });
  uniqueIdentities(expected.map(e => e.payload));
  const manifest = { binding: cfg.binding, expected, shape: [...shape.values()], functions };
  const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const authorization = `AUTHORIZE_EXPORTDATA_OPERATOR_COMPLEMENT:${hash}`;
  const p = projection(shape, 'd', false, cfg.connection);
  // data_ligacao needs the same canonical projection as every existing receipt.
  const logicalIdentity = identityColumns.map(name => `x.${name} IS NOT DISTINCT FROM e.payload->>${literal(name)}`).join(' AND ');
  const trigger = 'CREATE TRIGGER trg_olos_calls_normalizar_telefone BEFORE INSERT OR UPDATE OF telefone, telefone_match_key ON raw.olos_calls FOR EACH ROW EXECUTE FUNCTION raw.fn_olos_calls_normalizar_telefone()';
  const sql = `-- REVIEWED PROPOSAL ONLY. Manifest SHA-256: ${hash}
-- First preserve this manifest and set the LOCAL quarantine described in the runbook.
-- Then separately authorize the CORPORATE session with olos.operator_complement_authorization.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL timezone='UTC';
SET LOCAL standard_conforming_strings=on;
CREATE TEMP TABLE operator_expected_manifest(data jsonb) ON COMMIT DROP;
INSERT INTO operator_expected_manifest VALUES (${literal(JSON.stringify(manifest))}::jsonb);
DO $operator_complement$
DECLARE
  manifest jsonb; actual_shape jsonb; e record; actual jsonb; operator_value text;
BEGIN
  IF current_setting('olos.operator_complement_authorization',true) IS DISTINCT FROM ${literal(authorization)} THEN
    RAISE EXCEPTION 'OPERATOR_COMPLEMENT_NOT_AUTHORIZED';
  END IF;
  IF current_database()<>'madm' OR current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'CORPORATE_DATABASE_CONTRACT_INVALID';
  END IF;
  IF NOT pg_try_advisory_xact_lock(17320914,5) THEN RAISE EXCEPTION 'SELECTIVE_REMOTE_TRANSACTION_ACTIVE'; END IF;
  LOCK TABLE raw.olos_calls IN ROW EXCLUSIVE MODE;
  SELECT data INTO STRICT manifest FROM operator_expected_manifest;
  SELECT jsonb_agg(to_jsonb(c)-'ordinal_position' ORDER BY ordinal_position) INTO actual_shape FROM (
    SELECT ordinal_position,column_name AS name,udt_name AS type,is_nullable='YES' AS nullable,
      character_maximum_length AS length,datetime_precision AS precision,column_default AS default_value,
      is_identity,is_generated,domain_name FROM information_schema.columns
    WHERE table_schema='raw' AND table_name='olos_calls') c;
  IF actual_shape IS DISTINCT FROM manifest->'shape' OR
    pg_get_functiondef('raw.fn_olos_calls_normalizar_telefone()'::regprocedure) IS DISTINCT FROM manifest->'functions'->>'trigger_body' OR
    pg_get_functiondef('core.gerar_telefone_match_key(text)'::regprocedure) IS DISTINCT FROM manifest->'functions'->>'normalizer_body' OR
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='raw.olos_calls'::regclass AND NOT tgisinternal)<>1 OR
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='raw.olos_calls'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND pg_get_triggerdef(oid)=${literal(trigger)}) OR
    EXISTS(SELECT 1 FROM pg_class WHERE oid='raw.olos_calls'::regclass AND (relrowsecurity OR relforcerowsecurity)) OR
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='raw.olos_calls'::regclass) THEN
    RAISE EXCEPTION 'OPERATOR_COMPLEMENT_SCHEMA_CHANGED';
  END IF;
  FOR e IN SELECT * FROM jsonb_to_recordset(manifest->'expected')
    AS x(source_id text,target_id text,remote_raw_id text,payload jsonb,agent_id text) LOOP
    PERFORM 1 FROM raw.olos_calls WHERE raw_olos_call_id=e.remote_raw_id::bigint
      AND internal_id_olos=e.target_id::integer FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'OPERATOR_CONFIRMED_PROOF_MISSING'; END IF;
    SELECT to_jsonb(x) INTO actual FROM (SELECT ${p.sql} FROM raw.olos_calls d WHERE d.raw_olos_call_id=e.remote_raw_id::bigint) x;
    IF actual IS DISTINCT FROM e.payload THEN RAISE EXCEPTION 'EXISTING_CALL_DIVERGES'; END IF;
    IF (SELECT count(*) FROM (SELECT ${p.sql} FROM raw.olos_calls d) x WHERE ${logicalIdentity})<>1 THEN
      RAISE EXCEPTION 'DUPLICATE_LOGICAL_IDENTITY';
    END IF;
    SELECT id_operador_olos INTO operator_value FROM raw.olos_calls WHERE raw_olos_call_id=e.remote_raw_id::bigint;
    IF operator_value IS NOT NULL AND operator_value IS DISTINCT FROM e.agent_id THEN RAISE EXCEPTION 'EXISTING_OPERATOR_DIVERGES'; END IF;
  END LOOP;
  FOR e IN SELECT * FROM jsonb_to_recordset(manifest->'expected')
    AS x(target_id text,remote_raw_id text,agent_id text) LOOP
    UPDATE raw.olos_calls SET id_operador_olos=e.agent_id
    WHERE raw_olos_call_id=e.remote_raw_id::bigint AND internal_id_olos=e.target_id::integer
      AND id_operador_olos IS NULL AND id_operador_olos IS DISTINCT FROM e.agent_id;
  END LOOP;
END
$operator_complement$;
COMMIT;
`;
  return { manifest, hash, authorization, sql };
}
