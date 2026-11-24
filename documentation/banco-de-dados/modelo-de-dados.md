# Modelo de dados e relacionamentos

[Início](../README.md) / Banco de dados

## Banco local

A infraestrutura auditada utiliza **PostgreSQL 16**, schema `olos_http`. As migrations foram projetadas para **aplicação manual** e não devem ser aplicadas automaticamente em inicialização produtiva.

```mermaid
erDiagram
  RECORDS ||--o| CORPORATE_OUTBOX : "source_key/source_id"
  WORKER_SETTINGS ||--o| ADMIN_CREDENTIALS : "source_key"
  REPORT_SNAPSHOTS |o--o{ REPORT_SNAPSHOT_STATE : "published_id"
  READS {
    uuid id PK
    text source_key
    text state
    jsonb spec
    text response_body
    integer processed_count
  }
  RECORDS {
    text source_key PK
    text source_id PK
    bigint target_id
    text source_hash
  }
  CORPORATE_OUTBOX {
    text source_key PK
    text source_id PK
    integer target_id UK
    jsonb payload
    text state
  }
  CORPORATE_CONTROL {
    boolean singleton PK
    boolean ready
    boolean paused
    boolean blocked
  }
  WORKER_SETTINGS {
    text source_key PK
    text desired_state
    text runtime_state
    integer interval_ms
  }
  ADMIN_CREDENTIALS {
    text source_key PK
    integer revision
    text encrypted_payload
  }
  ADMIN_AUDIT {
    bigint id PK
    text actor
    text action
  }
  REPORT_SNAPSHOTS {
    uuid id PK
    text data_hash
    jsonb data
  }
  REPORT_SNAPSHOT_STATE {
    text source_key PK
    text target_table PK
    integer contract_version PK
    uuid published_id FK
  }
```

## Relações formais

- `corporate_outbox(source_key,source_id)` referencia `records(source_key,source_id)`.
- `admin_credentials.source_key` referencia `worker_settings.source_key`.
- `report_snapshot_state.published_id` referencia `report_snapshots.id`.
- `records(source_key,source_id)` é chave composta; `(target_table,target_id)` possui restrição de unicidade.

## Integridade

`reads` restringe estados a `reading`, `received`, `done`, `resolved`, exige `response_body` para `received` e `done`, e `resolution` para `resolved`. A outbox exige hash SHA-256 hexadecimal e recibo consistente para `confirmed`. Os snapshots incluem validação de estrutura, hash e trigger que impede updates nos dados já publicados.

## Limite do desenho

Este ERD mostra **chaves estrangeiras explicitamente encontradas nas migrations**. Relações apenas lógicas, sem FK, não são exibidas como relacionamentos físicos.

**Próximo:** [Tabela a tabela](tabelas.md).
