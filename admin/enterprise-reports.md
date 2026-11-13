# Relatórios de Integração & Telemetria

Implementação na aba Relatórios existente, comparada visualmente com `~/Downloads/tela-relatorio.png`. Mantidos shell, autenticação, CSRF, fontes e tokens Forest Obsidian. Não há novo sistema de relatórios, tabela, índice, migração, dependência ou endpoint. Nenhum fonte em `src/` foi alterado.

## Fontes e definições verificadas

| Indicador | Escopo e fonte existentes |
|---|---|
| Total coletadas | `period.calls`: contagem de identidades `(source_key, source_id)` em `olos_http.records`, vinculadas ao destino configurado por `target_id`; filtro por `data_ligacao` em America/Sao_Paulo. Não é CallId distinto nem número de requisições. |
| Com operador | `period.identified_calls`: AgentId positivo canônico e nome não vazio/não placeholder conforme SQL de AdminReports; percentual calculado em BigInt sobre `period.calls`, uma casa decimal. |
| Operadores distintos | `period.operators`: união dos IDs no backend; não soma dos distintos diários. IDs/nome de operadores não são expostos para filtragem. |
| Entregas confirmadas | `period.confirmed` e `daily.confirmed`: outbox local com origem/alvo/hash compatíveis com records, state confirmed, remote_raw_id e confirmed_at presentes. Não é comprovação remota nova. |
| Fila do período | `period.pending` e `daily.pending`: estado pending sem identificador remoto ou timestamp de confirmação, atribuído à data da chamada. Não é a fila global repetida por dia. |
| Controle da integração | `/api/status.corporate_delivery`: ready/paused/blocked/last_code observados separadamente. Não comprova conexão, escrita habilitada ou latência. O horário do controle não substitui observed_at dos relatórios. |
| Erros registrados | `failed_reads`: leituras da origem em `olos_http.reads` com error_code; histórico global, não falha ativa nem perda de chamadas. |
| Data da ligação ausente | `summary.undated`: grupo sem data de chamada, inclusive records cujo destino local está ausente. Não é somente uma contagem física de NULL em linhas ainda existentes. |
| Mappings ausentes | `summary.missing_mapping`: records sem linha correspondente no destino. Histórico global da origem. |
| Recibos/estados divergentes | `summary.inconsistent` global e `daily.inconsistent` por data da ligação: alvo/hash incompatível, recibos parciais ou estados não classificados como pending/confirmed/not_queued. O contrato atual inclui skipped nessa categoria. |

`skipped` não é pending nem confirmed. A interface explicita a classificação existente, não a transforma em erro ativo e não inventa um volume skipped separado. O CSV conserva o campo inconsistent recebido. Mudança dessa definição exigiria tarefa própria, não foi feita aqui.

Os três primeiros cards e os dois contadores de entrega usam a mesma janela da tabela/gráfico. Os quatro indicadores de integridade são explicitamente **histórico completo da origem**, com timestamp próprio. Não se calcula percentual global de integridade, crescimento, capacidade ou latência sem definição/fonte. Ausência da outbox produz indisponível, nunca zero.

## Contratos, armazenamento e custo

- `/api/reports?from&to`: mesmo `AdminReports`, snapshot PostgreSQL REPEATABLE READ READ ONLY; dados agregados, sem payloads. `summary`, `period`, `daily`, `failed_reads`, `observed_at`, `outbox_available` e `cache_seconds` existentes são suficientes.
- `/api/today`: preservado na Dashboard como primeira persistência local (`records.created_at`). Não alimenta a série por data de chamada.
- `/api/status`: mesmo ciclo de 2 s, usado para controle atual e relógio. Nenhum novo polling de SQL foi criado. O tick visual só atualiza idade da observação e calendário; ao virar o dia, um preset visível é reaplicado uma vez.
- Chaves existentes: records PK(source_key,source_id), UNIQUE(target_table,target_id); outbox PK(source_key,source_id), UNIQUE(target_id), FK para records e índice parcial pending; reads tem índice parcial para pendências. Nenhum índice novo.
- Cache do backend de 300 s, coalescência e cooldown preservados; Atualizar revalida sem furar esse cache. Nada é persistido em localStorage ou em novas tabelas. O estado JavaScript serve apenas para apresentar o snapshot recebido.

A terceira série é semanticamente suportada: **recibos atualmente confirmados, agrupados pela data da ligação**, e não por created_at/confirmed_at. Backfills e confirmações tardias podem alterar dias antigos na próxima observação. Testes PostgreSQL verificam explicitamente essa atribuição temporal. O gráfico reutiliza o SVG atual com terceira série opcional; sem outbox, são exibidas apenas coletadas e identificadas.

## Interações e integridade da apresentação

Filtros Hoje/7/15/30 dias e personalizado, calendário Brasília, datas reais e limite de 366 dias. Canal/operador não aparece como seletor falso: o contrato não oferece dimensão privada adequada. Revisão de requisições impede resposta antiga de substituir uma seleção nova, e repetições simultâneas do mesmo filtro são coalescidas. Trocar datas invalida imediatamente exportação e dados do período anterior.

`reportModel` verifica tipos, datas, inteiros textuais, observação, indisponibilidade corporativa e equivalência dos totais do período à série diária antes do badge Snapshot observado. HTTP 200 sozinho não basta. Valores grandes e percentuais usam BigInt; Number é reservado a índices e razões limitadas para coordenadas SVG.

Tabela descendente por data da ligação, seis linhas por página, contagem exata de dias retornados e filtros preservados. Dias sem chamadas não são inventados na tabela. O gráfico os preenche como zero somente após resposta válida. Detalhe diário em modal usa agregados reais do mesmo snapshot; não finge oferecer uma lista de chamadas individuais. CSV completo ou por dia, UTF-8/BOM, delimitador ponto e vírgula, escaping e proteção contra fórmulas existentes. Somente campos agregados permitidos. Sem payloads, nomes, tokens, telefones ou documentos.

Falha conserva o snapshot anterior somente para o mesmo filtro e o marca como desatualizado; seleção diferente permanece sem observação. Metadados de integridade global também envelhecem. Observações anteriores de outra sessão são apagadas; respostas tardias após logout são ignoradas. Exportação de snapshot anterior válido informa seu horário e desatualização. Erro de exportação não destrói os dados. O controle corporativo e a Dashboard permanecem independentes da falha do relatório.

Tooltip por mouse, foco e toque, sem GET adicional, com três valores reais. SVG sem reconstrução/animação quando só metadados não exibidos mudam. Skeleton estático durante carga, hover e entrada suaves, accordion de governança nativo; reduced-motion respeitado. Scroll horizontal localizado em séries densas/tabela; página inteira sem overflow em desktop/tablet/mobile.

## Validação local

- 111 testes TypeScript/unitários aprovados em execução serial, incluindo scheduler, ingestão, autenticação e Corporate Delivery unitária. A primeira execução paralela atingiu o limite artificial de 50 ms do teste HTTP existente; a repetição serial passou sem alterar esse teste ou o transporte.
- 17 testes de UI aprovados: calendários (incluindo 15 dias), precisão acima de MAX_SAFE_INTEGER, união/validação de métricas, fonte corporativa indisponível, CSV vazio/1/366 dias e regressões anteriores.
- 13 testes com PostgreSQL descartável aprovados: paridade com consulta congelada, união de operadores, mapping/data ausentes, recibos parciais/divergentes, skipped, backfill, confirmação tardia, cache, modo somente leitura e desempenho.
- Medição sintética: 200.013 registros, query 891 ms, snapshot reutilizado 1 ms, consulta congelada 1.774 ms, timeout existente 5.000 ms. A consulta de produção não foi alterada. Distribuição não densa; não demonstra desempenho de milhões de registros/1.000 operadores nem de produção.
- Chromium/Playwright local: filtros reais e personalizados, revisão com resposta de 15 dias retida por gate, virada do dia, três séries, indicadores, união de operadores do backend, detalhe por dia, CSV completo/linha, falha de exportação, sem outbox, paginação, erros/vazio/stale, sessão/CSRF/logout, Dashboard/terminal/accordion anteriores, viewport desktop/tablet/mobile e ausência de erros de console. Somente API simulada local.
- Build frontend, TypeScript administrativo e diff-check aprovados. Typecheck global conserva os mesmos 17 diagnósticos históricos em corporate-delivery.integration.ts, equivalentes integralmente à base já auditada.
- Runner Corporate Delivery com PostgreSQL/TLS descartáveis: 73 aprovados e oito falhas preexistentes (sete filhos de histórico/CLI e suíte agregadora), com mesmos testes e diagnósticos da referência anterior. Não se declara aprovação integral da suíte nem validação em produção.

## Evidência e diferenças visuais

Capturas em `evidence/enterprise-reports/`: enterprise-desktop.png, enterprise-panel.png, enterprise-tablet.png e enterprise-mobile.png, mais regressões da Dashboard. Dados sintéticos explicitamente rotulados apenas no teste. Comparação visual real com tela-relatorio.png levou a correções de alinhamento dos seis cards, altura do gráfico e distribuição responsiva.

Diferenças deliberadas: fontes e marca existentes; inteiros completos em vez de truncamento; filtros sem canal/operador; sem hash, latência ou percentuais fictícios; integridade com âmbito global explícito; terceira série por data da ligação com sua definição; coluna de divergências no lugar de taxa não definida; metadados e governança adicionais. Em 30 dias o gráfico pode rolar horizontalmente para preservar rótulos. Não se afirma equivalência pixel-perfect.

Arquivos alterados: `admin/public/{index.html,style.css,app.js,ui.js}`, `test/admin-ui.test.mjs`, `test/admin-redesign.browser.mjs`, `test/admin-reports.database.ts`, `test/fixtures/admin-reports.sql` (fixture descartável agora reflete skipped já suportado pelo schema real), esta nota e novas capturas. Backend, SQL de produção, scheduler, Autonomous Recovery, Corporate Delivery, outbox, recibos e checkpoints sem alterações. Sem commit, push, deploy ou acesso à produção.
