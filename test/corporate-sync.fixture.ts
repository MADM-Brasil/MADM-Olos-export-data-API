import { config, identityContract, writeAuthorization, type Config } from '../src/corporate-sync/config.js';
import { columns, type Row, type Shape } from '../src/corporate-sync/mapping.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return config('once', {
    CORPORATE_SYNC_SOURCE_URL: 'postgresql://postgres@127.0.0.1/corporate_sync_test_source',
    CORPORATE_SYNC_DESTINATION_URL: 'postgresql://postgres@127.0.0.1/corporate_sync_test_destination',
    CORPORATE_SYNC_SOURCE_TLS: 'false', CORPORATE_SYNC_DESTINATION_TLS: 'false',
    CORPORATE_SYNC_ENABLED: 'true', CORPORATE_SYNC_WRITE_CONFIRMATION: writeAuthorization,
    CORPORATE_SYNC_IDENTITY_CONFIRMATION: identityContract,
    CORPORATE_SYNC_TMA_POLICY: 'reject', CORPORATE_SYNC_TMA_CONFIRMATION: 'CONFIRM_TMA_reject',
    CORPORATE_SYNC_BATCH_SIZE: '2', CORPORATE_SYNC_BACKOFF_MS: '1',
    CORPORATE_SYNC_TIMEOUT_MS: '2000', ...overrides,
  });
}
export function shape(): Shape {
  return new Map(columns.map(name => [name, { name, type: name === 'internal_id_olos' ? 'int8' : name === 'tma_origem' ? 'int4' : name === 'data_ligacao' ? 'timestamptz' : 'text', nullable: name !== 'internal_id_olos', length: null, precision: name === 'data_ligacao' ? 6 : null }]));
}
export function row(id = '1'): Row {
  return { internal_id_olos: id, olos_call_id: 'reused-call-id', data_ligacao: '2026-01-01T12:00:00.123456Z',
    telefone: 'synthetic-phone', nome_agente: 'Synthetic Agent', id_campanha_olos: '7', nome_campanha_olos: null,
    id_tabulacao_olos: '3', nome_tabulacao_olos: null, cpf: null, lead_id_origem: null, tma_origem: '10',
    razao_desligamento: null, email: null };
}
export function fixture(source: boolean): string {
  if (source) return `CREATE SCHEMA raw; CREATE TABLE raw.olos_calls (
    internal_id_olos bigint PRIMARY KEY,
    olos_call_id text, data_ligacao timestamptz,
    telefone text, nome_agente text,
    id_campanha_olos text, nome_campanha_olos text,
    id_tabulacao_olos text, nome_tabulacao_olos text,
    cpf text, lead_id_origem text,
    tma_origem numeric, razao_desligamento text,
    email text, telefone_match_key text,
    raw_olos_call_id bigint, kommo_id bigint, kommo_status_processamento text
  );`;

  return `
    CREATE SCHEMA raw;
    CREATE SCHEMA core;

    CREATE FUNCTION core.gerar_telefone_match_key(p_telefone text)
    RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
    DECLARE
      v_raw text;
      v_digits text;
      v_has_plus boolean;
    BEGIN
      v_raw := btrim(coalesce(p_telefone, ''));
      v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');

      IF v_digits LIKE '0055%' THEN
        v_digits := regexp_replace(v_digits, '^0055', '55');
      ELSE
        v_digits := regexp_replace(v_digits, '^0+', '');
      END IF;

      IF v_digits = '' THEN RETURN NULL; END IF;

      v_has_plus := left(v_raw, 1) = '+';

      IF NOT v_has_plus AND length(v_digits) IN (10, 11) THEN
        v_digits := '55' || v_digits;
      END IF;

      IF left(v_digits, 2) = '55'
         AND length(v_digits) IN (12, 13) THEN
        RETURN '55' || substring(v_digits FROM 3 FOR 2)
                    || right(v_digits, 8);
      END IF;

      IF length(v_digits) >= 8 THEN
        RETURN v_digits;
      END IF;

      RETURN NULL;
    END;
    $fn$;

    CREATE TABLE raw.olos_calls (
      internal_id_olos integer,
      olos_call_id text,
      data_ligacao timestamptz,
      telefone text,
      nome_agente text,
      id_campanha_olos text,
      nome_campanha_olos text,
      id_tabulacao_olos text,
      nome_tabulacao_olos text,
      cpf varchar,
      lead_id_origem varchar,
      tma_origem integer,
      razao_desligamento varchar,
      email varchar,

      raw_olos_call_id bigint GENERATED ALWAYS AS IDENTITY,
      telefone_match_key text,
      arquivo_origem text,
      lote_carga text,
      data_carga timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      kommo_event_hash text,
      kommo_event_hash_processado text,
      kommo_status_processamento text,
      kommo_lead_id_encontrado bigint,
      kommo_match_origem text,
      kommo_tentativas integer NOT NULL DEFAULT 0,
      kommo_processado_em timestamptz,
      kommo_erro text,
      kommo_pipeline_id_atual bigint,
      kommo_status_id_atual bigint,
      kommo_batch_id text,
      kommo_reservado_em timestamptz,

      CONSTRAINT pk_raw_olos_calls PRIMARY KEY (raw_olos_call_id)
    );

    CREATE UNIQUE INDEX ux_raw_olos_calls_internal_id
      ON raw.olos_calls (internal_id_olos)
      WHERE (internal_id_olos IS NOT NULL);

    CREATE FUNCTION raw.fn_olos_calls_normalizar_telefone()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.telefone_match_key :=
        core.gerar_telefone_match_key(NEW.telefone);
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER trg_olos_calls_normalizar_telefone
      BEFORE INSERT OR UPDATE OF telefone, telefone_match_key
      ON raw.olos_calls
      FOR EACH ROW
      EXECUTE FUNCTION raw.fn_olos_calls_normalizar_telefone();
  `;
}
