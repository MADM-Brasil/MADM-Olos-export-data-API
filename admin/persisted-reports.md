# Relatórios: snapshots persistidos (contrato v1)

Implementação local, com PostgreSQL descartável. Nenhuma ação em produção. O histórico da tentativa SQL anterior está em [reports-performance.md](reports-performance.md).

## Arquitetura e exatidão

`AdminReports` atende `/api/reports` e `/api/today` exclusivamente pelo ponteiro de um snapshot publicado. Não possui fallback histórico, nem inicia atualizações por filtro. Sem publicação válida responde `503 REPORT_INITIALIZING`, com estado `INITIALIZING` e `Retry-After: 30`.

`ReportUpdater`, iniciado apenas no modo Admin web, tem timer e conexão próprios, independentes do scheduler de ingestão. Uma trava consultiva de sessão por `source_key` coordena instâncias, destinos e versões. Requer conexão PostgreSQL direta ou pool em modo sessão; pooling em modo transação é incompatível. A agregação histórica existente foi transferida sem mudança de classificação, não substituída por outra arquitetura de contadores.

Cada geração usa uma transação `REPEATABLE READ`: coleta agregados e erros, valida, insere geração imutável, troca ponteiro e retém a geração anterior no mesmo COMMIT. Não publica resultados parciais. `observed_at` é o início da transação; `published_at` é o horário da inserção dentro dela, visível somente após COMMIT. SHA-256 canônico, metadados, contrato, calendário, partições de contagem e limites são revalidados pelo leitor. Hash verifica consistência, não constitui assinatura contra um administrador do banco.

Fontes e definições preservadas:

| Indicador | Fonte / regra |
| --- | --- |
| Calls | Linhas de `olos_http.records` para source/destino; identidade `(source_key, source_id)` |
| Dia da chamada | `raw.olos_calls.data_ligacao`, no destino configurado, calendário `America/Sao_Paulo` |
| Identificadas / operadores | ID textual positivo canônico e nome identificado, com regex/whitespace anteriores; união exata dos IDs nos dias do período, nunca soma de distintos |
| Confirmed / pending / inconsistent / not_queued | Junção da outbox por source/source_id; mesmas regras de hash, mapping, estado, remote ID e confirmed_at do SQL anterior. `skipped` mantém a classificação anterior, não vira pending nem confirmed |
| Missing mapping / undated | Ausência da junção / data da chamada nula; grupo sem data entra no histórico global e não em períodos datados |
| Failed reads | `olos_http.reads`, mesma source e `error_code IS NOT NULL`, sem filtro temporal novo |
| Today | `records.created_at`, primeira persistência local, no dia de Brasília observado; não substitui a data da chamada |

Ausência da outbox mantém métricas corporativas `null`. Os cálculos usam strings decimais e `BigInt`. IDs internos de operadores ficam privados, sem exposição na API; não são persistidos nome, CPF, telefone, e-mail, payload ou recibos integrais. Recomputa-se todo o conjunto periodicamente para incorporar backfills, confirmações tardias, recibos e mappings alterados, sem invalidadores nos caminhos de ingestão/entrega.

## Esquema e recuperação

Migração manual [003_report_snapshots.sql](migrations/003_report_snapshots.sql), transacional e reaplicável, cria somente:

- `olos_http.report_snapshots`: UUID, source/destino, versão/contrato/timezone/status, horários, data de coleta, JSONB de agregados diários/globais e IDs internos, validação e hash; índice de retenção; payload até 16 MiB.
- `olos_http.report_snapshot_state`: chave source/destino/versão, FK da publicação, estado da atualização, tentativa, próxima execução, falhas e código de erro.
- Trigger que rejeita UPDATE de gerações publicadas. Correções sempre publicam outro UUID.

O leitor consulta o ponteiro a cada segundo e baixa o JSONB somente quando muda o UUID; reinícios recuperam a publicação do banco. Mantém duas gerações por source/destino/versão. Versões diferentes nunca são consumidas implicitamente e não são apagadas pela retenção de outra versão. Sua remoção futura exige decisão explícita.

Tentativas persistidas usam esperas de 30 s, 60 s e cooldown de 300 s, no máximo três tentativas por ciclo de falhas. Uma intenção persistida também impõe espera após queda do processo. Falha antes do COMMIT reverte a geração; perda da confirmação do COMMIT gera `REPORT_COMMIT_UNKNOWN` e não reescreve estado nem repete publicação cegamente: a próxima passagem verifica o ponteiro durável. Queda da conexão encerra a posse física; outro atualizador só entra quando PostgreSQL liberar a trava. Shutdown cancela apenas a conexão analítica e aguarda sua finalização.

## Orçamentos e atualização

| Controle | Política |
| --- | --- |
| Atualização | A cada 240 s desde a observação; antecipada na virada de Brasília |
| Frescor | READY até 300 s; STALE explícito entre 300 e 900 s; acima de 900 s, `503 REPORT_SNAPSHOT_STALE` |
| Today após meia-noite | Recusa geração do dia anterior, mesmo com idade menor que 900 s |
| Conexões | Leitor max 1 + atualizador max 1, separados do pool operacional; conexão limitada a 1 s |
| HTTP | Statement e watchdog de 5 s; falhas de conexão podem somar até aproximadamente 6 s. Meta saudável p95 <500 ms, máximo <1 s |
| Atualizador | Statement 30 s, watchdog total após checkout 40 s, lock 1 s, idle transaction 35 s |
| Recursos SQL | Somente SET LOCAL: work_mem 16 MiB por operação, hash multiplier 2, até 1 worker paralelo, JIT off, temp_file_limit 768 MiB por backend |
| Metas analíticas | Atualização <20 s; escrita temporária <1.536 MiB; RSS do serviço analítico de teste <256 MiB |
| Concorrência | Lote sintético de 500 registros: p95 <250 ms e incremento <100 ms sobre referência sem atualização |

`work_mem` não é limite de memória total do PostgreSQL: aplica-se por nó/worker. A quota temporária é por backend, não por todo o servidor. Com um worker, há até dois backends por cálculo. A aplicação não altera limites globais. O papel precisa de permissão para `SET temp_file_limit`; ausência produz `REPORT_RESOURCE_LIMIT_REQUIRED` e conserva a última geração. Eventos sanitizados informam source anonimizada, UUID, duração, tamanho, dias, erro e retentativa. Metadados HTTP incluem idade, versão, estado e erro/próxima tentativa do atualizador.

## Evidência local e reprodução

Node 24.16.0, PostgreSQL 16.15 descartável, shared_buffers 128 MiB; 2.000.000 records, 1.910.290 outbox, 786.460 destinos, 365 dias e 1.000 operadores. Dados explicitamente sintéticos. Cache frio significa reinício do PostgreSQL e do leitor; cache do sistema operacional não foi descartado.

| Medida | Resultado |
| --- | --- |
| HTTP p95 / máximo | 25,39 / 183,81 ms |
| Atualizações completas | 4,64 / 4,64 / 4,57 s; 4,80 s no serviço isolado com tráfego HTTP |
| Escrita temporária do plano histórico | 881,11 MiB; 6,03 s com instrumentação EXPLAIN |
| Leitura por chave, EXPLAIN | 0,045 ms; zero blocos temporários (não representa toda a latência HTTP) |
| Lotes de 500, p95 de 4 amostras | 29,81 ms sem cálculo / 42,71 ms concorrentes; diferença 12,90 ms |
| RSS serviço / driver | 203,54 / 338,23 MiB; medidos separadamente |
| Requisições no serviço isolado | 835 durante 20 s; zero agregações históricas no caminho HTTP |

Planos e amostras estão em [evidence/persisted-reports](evidence/persisted-reports/). Preservou-se o experimento de 4 MiB/lote 500: duas atualizações de aproximadamente 27 s reprovaram a meta; a única mudança final de orçamento SQL foi work_mem LOCAL de 16 MiB. Não se aumentou o timeout HTTP. A consulta histórica permanece cara; sua remoção do caminho HTTP é a correção estrutural.

O RSS medido inclui dependências do Admin, leitor e atualizador; não mede o pico combinado com um worker real de ingestão. A carga concorrente simula transações de ingestão, não OLOS real. Quatro lotes não caracterizam saturação sustentada. Cardinalidade extrema de operadores, armazenamento diferente, cache físico frio e muitas origens ativas exigem homologação adicional. Snapshot acima do limite de payload é recusado, conservando a publicação anterior até sua idade máxima.

Com Node 24 no PATH:

```sh
npm test -- --test-concurrency=1
bash scripts/test-admin-reports.sh
bash scripts/test-admin.sh
npm run test:admin-ui
npm run build
npm run typecheck:admin
REPORT_SNAPSHOT_PERF=1 REPORT_PERF_EVIDENCE=admin/evidence/persisted-reports bash scripts/test-admin-reports.sh
```

Fixtures preservam o SQL antigo somente como oráculo de teste. Equivalência integral validada para 1/7/15/30/366 dias, também após backfill/recibos/confirmações tardias; testes incluem COMMIT incerto, desligamento, duas instâncias, perda de conexão, retenção, migração/down/up, precisão acima de MAX_SAFE_INTEGER e ausência de privilégios de acesso às fontes no leitor. `REPORT_PERF=1` continua reproduzindo a tentativa SQL anterior reprovada; não é o benchmark desta arquitetura.

Resultado final: 121 unitários, 14 PostgreSQL do oráculo, 18 PostgreSQL de snapshots, 16 administrativos, 17 UI e 3 verificações do benchmark aprovados; build e TypeScript administrativo aprovados. A suíte corporativa/Store terminou com 73 aprovados e 8 falhas (sete subtestes + agregadora). Nomes e primeiro diagnóstico de cada falha são iguais ao registro local da auditoria do commit-base `f54cbef`; os 17 diagnósticos TypeScript globais também são idênticos, todos no teste corporativo. A comparação usou os logs de base preservados, não uma nova execução do commit-base. [validation.json](evidence/persisted-reports/validation.json) discrimina as pendências. Nenhuma aprovação integral da suíte é declarada.

## Arquivos desta implementação

- Produção: `src/admin/report-snapshot.ts`, `report-updater.ts`, `reports.ts`, `repository.ts`, `main.ts`, `server.ts`, `events.ts`.
- Schema: `admin/migrations/003_report_snapshots.sql`, `admin/migrations/rollback/003_report_snapshots.sql`.
- Testes/runner: `test/admin-report-snapshots.test.ts`, `admin-report-snapshots.database.ts`, `admin-report-snapshots.performance.ts`, `admin-reports.test.ts`, `admin-reports.database.ts`, `admin.test.ts`; `test/fixtures/admin-reports-legacy.ts`, `report-http.ts`, `report-memory.ts`; `scripts/test-admin-reports.sh`.
- Documentação/evidência: este arquivo, nota histórica em `admin/reports-performance.md`, `admin/evidence/persisted-reports/{summary,validation,refresh-estimated,refresh-executed,persistent-read-executed,experiment-4mb-500rows}.json`.

As alterações e fixtures da investigação SQL anterior (`test/admin-reports.performance.ts`, fixtures SQL e `admin/evidence/reports-p0/`) foram preservadas. Frontend, consumo OLOS, Autonomous Recovery, scheduler, ingestão, Corporate Delivery, dependências e migrações operacionais não foram modificados.

## Publicação e rollback (procedimento; não executado)

1. Homologar a mesma versão PostgreSQL e modo de conexão, armazenamento, cardinalidade, permissões e orçamento de duas conexões extras. Revisar a migração incremental e registrar backup/versão anterior do código. Não executar automaticamente todas as migrações sem revisar as anteriores.
2. Aplicar somente a migração 003 antes do novo código. Papel leitor: USAGE em olos_http + SELECT nas duas tabelas. Papel atualizador: SELECT nas fontes já usadas, SELECT/INSERT/DELETE em snapshots, SELECT/INSERT/UPDATE em state, USAGE nos schemas. Não conceder UPDATE nos snapshots. O Admin atual usa o papel já configurado, com pools independentes.
3. DBA concede `GRANT SET ON PARAMETER temp_file_limit TO <papel_da_aplicacao>` quando necessário (testado com papel sem superusuário em PostgreSQL 16). Não tornar a aplicação superusuária. Confirmar quota e permissões antes de iniciar.
4. Publicar código de forma controlada e reiniciar preservando desired_state. Aguardar primeira geração; até lá 503 de inicialização é esperado. Verificar READY, idade, tempos/recursos, equivalência amostral, progresso de ingestão e entrega, sem comandos à OLOS. Autorizar expansão somente com as metas observadas no ambiente de homologação.
5. Rollback de código: parar novos atualizadores e retornar à versão anterior. Código compatível com contrato v1 recupera a última publicação; código anterior à feature ignora as novas tabelas e volta ao risco conhecido da consulta síncrona/503. Manter as tabelas é a opção preferencial.
6. Se remoção de schema for realmente necessária, parar todos os leitores/atualizadores novos antes de aplicar manualmente [rollback/003_report_snapshots.sql](migrations/rollback/003_report_snapshots.sql). Remove somente dados analíticos derivados. Não altera records, reads, raw, outbox, recibos ou configurações do scheduler.

Veredito: **GO para homologação controlada**, com limites sintéticos explícitos. Não equivale a aprovação de produção nem da suíte global: checagem TypeScript global e suíte corporativa possuem pendências preexistentes, discriminadas na entrega e na evidência de validação.
