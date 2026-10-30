# Relatório de implementação e validação — 30/10/2026

Implementado serviço independente para entrega incremental de novas chamadas do PostgreSQL local ao corporativo, com projeção congelada, controle/recibos locais, exclusividade, replay idempotente, preflight de schema, autorização explícita, política TMA e tratamento de falhas. **Nenhuma conexão a banco real foi executada.** DDL/DML/GRANT dos testes ocorreu exclusivamente em PostgreSQL descartável.

## Arquivos criados

| Arquivo | Finalidade |
| --- | --- |
| `src/corporate-sync/cli.ts` | comandos próprios e tratamento de sinais |
| `src/corporate-sync/config.ts` | configuração independente, confirmação e vínculo persistente |
| `src/corporate-sync/database.ts` | conexões próprias, TLS, lock e migration local |
| `src/corporate-sync/errors.ts` | classificação de erros e logs sem dados sensíveis |
| `src/corporate-sync/mapping.ts` | whitelist de campos, identidade composta, TMA e validação |
| `src/corporate-sync/schema.ts` | inspeção e bloqueio de incompatibilidades |
| `src/corporate-sync/worker.ts` | lotes, diagnóstico, transações, replay e retentativas |
| `migrations/corporate-sync/001_control.sql` | controle/checkpoint e recibos exclusivamente locais |
| `Dockerfile.corporate-sync` | imagem independente, usuário não root e comando padrão check |
| `compose.corporate-sync.yaml` | serviço standalone opcional para Dokploy |
| `tsconfig.corporate-sync.json` | build restrito ao módulo |
| `test/corporate-sync.fixture.ts` | dados/schema sintéticos |
| `test/corporate-sync.test.ts` | testes unitários e bloqueio da CLI |
| `test/corporate-sync.integration.ts` | testes PostgreSQL e injeção de falhas |
| `scripts/test-corporate-sync.sh` | ambiente descartável isolado, com limpeza automática |
| `docs/corporate-sync/README.md` | contrato, configuração, homologação, operação e rollback |
| `docs/corporate-sync/environment.example` | configuração sem credenciais reais e desabilitada |
| `docs/corporate-sync/audit-source.sql` | auditoria agregada local opcional, não executada em banco real |
| `docs/corporate-sync/validation.md` | este relatório |

## Resultados

| Verificação | Resultado |
| --- | --- |
| `tsc --noEmit` | passou, inclusive em Node 24 |
| `tsc -p tsconfig.build.json` | passou |
| `tsc -p tsconfig.corporate-sync.json` | passou |
| `bash scripts/test-corporate-sync.sh` | **37/37 passaram**, sem skips; Node 24, PostgreSQL 16 |
| `npm test` em container sem rede externa | **98/98 passaram**, sem skips |
| `docker build -f Dockerfile.corporate-sync -t olos-corporate-sync:local-test .` | passou; imagem apenas local |
| validação do Compose com ambiente de exemplo, sem resolução de env_file | passou |
| imagem executada em `once`, sem confirmação, com `--network none` | saída esperada 1: `WRITE_NOT_AUTHORIZED` |
| SHA-256 de `src/config.ts` antes/depois | idêntico |
| comparação binária do diff rastreado antes/depois | idêntico |
| whitespace dos arquivos novos | sem ocorrências |

O total específico inclui 12 testes unitários/CLI, 24 cenários PostgreSQL e o teste contêiner desses cenários. A suíte geral inclui os testes unitários do módulo; não somar os dois totais como testes distintos.

A imagem Node mínima não tinha OpenSSL, o que inicialmente impediu o teste legado de TLS (96/97 na primeira execução, antes da inclusão do teste adicional da CLI). A execução final usou uma imagem temporária de ferramentas baseada em Node 24, com OpenSSL e bibliotecas copiados de `postgres:16-bookworm` e `OPENSSL_CONF=/etc/ssl/openssl.cnf`; então os 98 testes passaram. Nenhum teste legado nem código operacional foi alterado para resolver essa dependência do ambiente.

O `git diff --check` global ainda aponta a linha em branco preexistente no fim de `src/config.ts`. Essa alteração foi preservada, conforme solicitado; o diff binário comprova que não foi alterada durante a implementação.

## Cobertura de consistência

- Migration local repetível e ausência de controles no destino.
- Check/dry-run sem escrita, inclusive com bancos configurados como READ ONLY e sem migration instalada.
- Lotes limitados, IDs atrasados abaixo do último checkpoint e CallId repetido em identidades diferentes.
- Preservação de microssegundos, `internal_id_olos`, `raw_olos_call_id` existente e `kommo_*` existente.
- Falha após COMMIT remoto e antes de qualquer recibo; replay do lote original mesmo após mutação da origem.
- COMMIT remoto incerto simulado, retry limitado e reconhecimento exato da chamada já gravada.
- Rollback após INSERTs remotos e rollback local depois da preparação dos recibos/checkpoint.
- Interrupção antes/depois do COMMIT e backoff interrompível.
- Colisões de PK, payload divergente, identidade em outro ID e duplicatas no lote.
- Rejeição de frações por padrão, conversões confirmadas, limites de integer/bigint e identidade incompleta.
- Timestamp sem fuso bloqueado até confirmação; conversão explícita e preservação de precisão.
- Schema incompatível, defaults/identity, índices únicos, extras obrigatórios, triggers e RLS bloqueados.
- Exclusividade local, duas inicializações concorrentes, vínculo imutável da configuração e destino igual à origem.
- Papel sintético de destino apenas com SELECT/INSERT, sem UPDATE/DDL.
- CLI sem autorização falha antes de conectar e não expõe credenciais/erro bruto.

## Pendências para homologação/ativação real

1. Confirmar a política de TMA; a contagem de 11.406 fracionários veio do pedido e não foi revalidada. `reject` continuará bloqueando esses registros.
2. Confirmar a identidade lógica composta e tratar registros incompletos ou conflitantes sem remapear IDs automaticamente.
3. Confirmar o schema atual, semântica/fuso do timestamp, TLS, permissões já disponíveis e endpoints reais. Defaults/triggers/índices adicionais podem bloquear o preflight e exigem revisão; esta implementação não os altera.
4. Validar o contrato de INSERT de novas chamadas: alterações/enriquecimentos depois de congelar a projeção não são propagados. Não há atualização de chamadas corporativas existentes.
5. Medir volume, custo do anti-join local e da consulta de identidade no corporativo, locks, concorrência com outros escritores e estratégia coordenada de backup/restauração. A suíte usa dados sintéticos e não comprova desempenho/correção do ambiente real.
6. Autorizar explicitamente aplicação da migration local, conexões reais de diagnóstico e, separadamente, ativação de escrita. A entrega deixa tudo desabilitado e não executou essas etapas.

Não houve commit, push, publicação, deploy, mudança no Compose operacional, reinício de serviço operacional, alteração do Billing, alteração de autenticação OLOS, `AttemptsRawData`, `DynamicScheduler`, `Store` ou `src/config.ts`.
