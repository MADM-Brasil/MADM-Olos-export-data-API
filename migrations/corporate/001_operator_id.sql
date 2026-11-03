-- PROPOSAL: MADM CORPORATE DATABASE ONLY, explicit DBA review/execution required.
-- No runtime invokes this file. Keep delivery paused and all schedulers stopped.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
  IF current_database() <> 'madm' THEN RAISE EXCEPTION 'CORPORATE_DATABASE_REQUIRED'; END IF;
  IF to_regclass('raw.olos_calls') IS NULL THEN RAISE EXCEPTION 'CORPORATE_TABLE_REQUIRED'; END IF;
END
$guard$;
ALTER TABLE raw.olos_calls ADD COLUMN IF NOT EXISTS id_operador_olos text;
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='raw' AND table_name='olos_calls'
    AND column_name='id_operador_olos' AND udt_name='text' AND is_nullable='YES' AND column_default IS NULL
    AND is_identity='NO' AND is_generated='NEVER' AND domain_name IS NULL) THEN
    RAISE EXCEPTION 'OPERATOR_COLUMN_INCOMPATIBLE';
  END IF;
END
$guard$;
COMMENT ON COLUMN raw.olos_calls.id_operador_olos IS
  'Original OLOS AgentId, lossless text. 0 is retained as 0; NULL means absent/null source. Independent of call IDs and nome_agente.';
COMMIT;
