-- TEST ONLY: isolated database. Not a migration for an existing destination.
CREATE SCHEMA raw;
CREATE TABLE raw.olos_calls (
 internal_id_olos bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 olos_call_id text, data_ligacao timestamptz, telefone text, nome_agente text,
 id_campanha_olos text, nome_campanha_olos text, id_tabulacao_olos text, nome_tabulacao_olos text,
 cpf text, lead_id_origem text, tma_origem numeric, razao_desligamento text, email text,
 raw_olos_call_id text, telefone_match_key text
);
