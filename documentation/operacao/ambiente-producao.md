# Ambiente de produção auditado

[Operação](README.md) / Produção

## Referência temporal

**Última auditoria de configuração:** 24/11/2026. Estes valores descrevem o ambiente **na data da coleta**, não uma garantia perpétua.

| Item | Valor observado |
|---|---|
| Orquestração | Dokploy + Docker |
| Container Admin | `olos-export-data-madmolosexportdataapi-vqrnw6-admin-1` |
| Imagem Admin | `olos-madm-admin-optimized:20261119-enqueue-bulk-v1` |
| Container PostgreSQL | `olos-export-data-madmolosexportdataapi-vqrnw6-postgres-1` |
| Imagem do banco | `postgres:16-bookworm` |
| Banco local / usuário operacional | `olos_exportdata` / `olos_app` (observado em verificações anteriores) |
| Origem | `olos-production` |
| Escrita corporativa habilitada | `OLOS_CORPORATE_WRITE_ENABLED=true` |
| Recuperação contínua do scheduler | `OLOS_SCHEDULER_CONTINUOUS_RECOVERY=true` |
| Atualizador de snapshots locais | `OLOS_LOCAL_REPORT_UPDATER_ENABLED=false` |

## Implicações

- **Escrita corporativa habilitada** não dispensa a verificação de `ready`, `paused` e `blocked`.
- **Atualizador local desabilitado** não significa que a tela de relatórios corporativos esteja desabilitada. São fluxos distintos.
- **Imagem de rollback preservada:** `olos-madm-admin-optimized:20261119-map-once-v1` foi inspecionada na auditoria de deploy de 19/11; verificar sua disponibilidade antes de uma futura alteração.
- Intervalo do scheduler confirmado em verificações anteriores: **60.000 ms**, sujeito a alterações autorizadas no painel.

## Controle de configuração

Não publicar valores de `DATABASE_URL`, `OLOS_CORPORATE_DATABASE_URL`, chaves `ADMIN_ENCRYPTION_KEY`, segredos OLOS ou conteúdo integral de `docker inspect`. Registrar somente nomes de parâmetros, valores não secretos aprovados e data da observação.
