# Auditoria — 28/10/2026

O diretório `/home/madm/madm/export-data-v3-api` começou vazio e sem `.git`, `.env`, dependências, documentos ou AGENTS.md aplicável. Não havia DATABASE_URL no ambiente. Não foi iniciada configuração de Git.

O projeto antigo `/home/madm/worker-olos-export-data` foi consultado somente para documentação, estrutura do destino e decisões de integridade. Nenhum arquivo, container ou dado do projeto antigo foi modificado. Não foram copiados segredos, implementação SQL/TDS, spool, filas, capturas ou mecanismos de autorização desse projeto.

## Esquema efetivamente observado

Uma transação `BEGIN READ ONLY`, `statement_timeout=10s`, consultas em `information_schema.columns`/`pg_constraint` e `ROLLBACK` foi executada no PostgreSQL **local**, container `olos-worker-postgres`, banco `olos_worker`. Não foram lidas linhas de chamadas. Esse banco é referência local e **não está confirmado como destino corporativo desta integração**.

| Coluna | Tipo observado | NULL |
|---|---|---|
| internal_id_olos | bigint, PK, sem default/identity | não |
| olos_call_id | text | sim |
| data_ligacao | timestamp sem fuso | sim |
| telefone | text | sim |
| telefone_match_key | text | sim |
| nome_agente | text | sim |
| id_campanha_olos | text | sim |
| nome_campanha_olos | text | sim |
| id_tabulacao_olos | text | sim |
| nome_tabulacao_olos | text | sim |
| cpf | text | sim |
| email | text | sim |
| lead_id_origem | text | sim |
| tma_origem | integer | sim |
| razao_desligamento | text | sim |
| raw_olos_call_id | bigint | sim |

Constraint observada: `PRIMARY KEY (internal_id_olos)`. Não é correto aplicar o schema sugerido no PRD por cima desse destino. A falta de geração de ID e a semântica de timestamp bloqueiam seu uso pelo novo worker. Não foi criada sequence, nem alterado tipo/constraint, nem reaproveitado o mapeamento antigo de ID de origem para ID interno.

O novo comando `inspect-schema` inclui também índices, triggers, RLS, sequence e permissões. O esquema corporativo deverá ser inspecionado por esse comando quando sua conexão for indicada. A migration entregue cria somente controle em `olos_http`, posterior à auditoria local; a única tabela de chamadas criada durante os testes é descartável e está em `test/fixture.sql`.

## Documentação OLOS encontrada

`/home/madm/worker-olos-export-data/docs/reference/olos-exportdata-v3.pdf` tem 33 páginas. A extração local identificou métodos `usp_ExportData_*`, incluindo CurrentDay, PreviousDays, LogReadData e ReReadData. Não foram encontrados `/api/auth`, `refresh_token`, `available-tables` ou os caminhos HTTP informados no PRD. Portanto, esse documento **não é prova do contrato HTTP**, da atomicidade da leitura HTTP ou da retenção e completude da releitura HTTP.

Buscas públicas por `WebApiExportData`/`ExportDataV3` não localizaram manual HTTP oficial utilizável. A implementação usa o contrato dado pelo usuário, sem extrapolar garantias de SQL Server. O catálogo HTTP possui adaptação explícita e bloqueia envelopes não reconhecidos. As garantias SQL de UPSERT/transação e advisory lock foram conferidas na [documentação de INSERT](https://www.postgresql.org/docs/current/sql-insert.html) e de [locks](https://www.postgresql.org/docs/17/explicit-locking.html).

## Plano de homologação real (não executado)

1. Identificar o destino corporativo e obter metadados atuais, privilégios do runtime, regra de geração de ID e baseline do histórico existente. Não iniciar consumo se algum campo obrigatório não tiver origem confirmada.
2. Coordenar exclusividade com o worker antigo e todos os consumidores externos. Não basta o lock do novo serviço.
3. Obter documentação HTTP oficial/Swagger e exemplos sanitizados de auth, catálogo, tabela estática, dados transacionais e erros. Confirmar se 401/429 rejeitam sem avançar consumo e se o corpo é array direto.
4. Sob autorização específica, capturar amostras entre dias/partições e verificar unicidade e estabilidade de AttemptsRawDataID; CallId não será chave de dedup. Confirmar PK usada por re-read-data e inclusividade dos limites.
5. Confirmar fuso/formato de StartDate e da data de exportação. Não atribuir significado a raw_olos_call_id, tma, CPF, email ou razão de desligamento sem definição do destino.
6. Comparar contagem, IDs, datas, telefones como texto e nomes em um `once` autorizado. Simular falhas somente em homologação: rede após início da leitura, PG após resposta, queda antes/depois de commit e retorno com replay idempotente.
7. Atravessar várias expirações reais de token, incluindo rotação de refresh e revogação. Confirmar desempenho de refresh e ausência de 401 recorrentes.
8. Confirmar retenção, completude, atribuição por consumidor e conclusão remota para LogReadData/ReReadData. Validar recuperação de uma tentativa cujo corpo nunca chegou, sem inferir faixa por contagem global ou repetir a leitura corrente.
9. Medir volume por resposta, memória/RSS, CPU, duração de requisição/persistência, contenção do destino e atraso upstream. Testar backlog e virada de dia com PreviousDays. Fixar limites e procedimento/agenda operacional de backfill.
10. Definir retenção de respostas, backup conjunto de destino/marcadores, alertas de encerramento e processo para resolver pendências com evidência. Só então ativar polling contínuo.
