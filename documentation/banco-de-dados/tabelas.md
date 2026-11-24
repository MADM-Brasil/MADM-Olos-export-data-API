# Tabelas, campos e estados

[Início](../README.md) / Banco de dados

| Tabela | Papel | Campos principais |
|---|---|---|
| `olos_http.reads` | Intenções e respostas de leitura | `id`, `source_key`, `spec`, `state`, `response_body`, `processed_count`, `received_count`, `request_ms`, `error_code` |
| `olos_http.records` | Identidade e metadados do registro originário | `source_key`, `source_id`, `target_id`, `source_hash`, `agent_id`, `campaign_id`, `disposition_id`, `created_at` |
| `olos_http.corporate_outbox` | Fila de entrega e recibo | `source_key`, `source_id`, `target_id`, `payload`, `payload_hash`, `state`, `remote_raw_id`, `confirmed_at`, `delivery_policy_code` |
| `olos_http.corporate_control` | Estado global da entrega | `ready`, `paused`, `blocked`, `failure_count`, `confirmed_count`, `next_attempt_at`, `last_code` |
| `olos_http.worker_settings` | Estado durável do agendamento | `interval_ms`, `desired_state`, `runtime_state`, `last_error`, `updated_by` |
| `olos_http.admin_credentials` | Configuração administrativa protegida | `revision`, `encrypted_payload`, `updated_at`, `last_test_ok`, `last_test_code` |
| `olos_http.admin_audit` | Trilha de ações | `id`, `source_key`, `actor`, `action`, `occurred_at`, `metadata` |
| `olos_http.report_snapshots` | Agregados versionados e imutáveis | `id`, `contract_version`, `observed_at`, `data`, `data_hash`, `validation` |
| `olos_http.report_snapshot_state` | Ponteiro e estado de publicação | `source_key`, `target_table`, `contract_version`, `published_id`, `status`, `last_error` |

## Restrições especialmente relevantes

**`reads.state`:** `reading`, `received`, `done`, `resolved`.
**`corporate_outbox.state`:** `pending`, `confirmed`, `skipped`, considerando a migration complementar `003`.
**`worker_settings.desired_state`:** `RUNNING`, `PAUSED`, `STOPPED`.
**`worker_settings.runtime_state`:** `RUNNING`, `PAUSING`, `PAUSED`, `STOPPING`, `STOPPED`, `ERROR`.
**`report_snapshot_state.status`:** `initializing`, `building`, `ready`, `error`.

## Sensibilidade dos dados

`reads.response_body` e `corporate_outbox.payload` podem conter dados pessoais. Não incluir seus conteúdos em tickets, docs públicas ou relatórios técnicos destinados a terceiros. A documentação de esquema deve limitar-se a metadados, contratos e exemplos sintéticos.

## Atenção às migrations

Os arquivos são históricos incrementais. Por exemplo, `002_corporate_delivery.sql` não representa sozinho o estado final da outbox: `003`, `004` e `005` alteram regras ou fazem reclassificações. Verificar o esquema efetivo antes de qualquer operação de manutenção.
