# Dashboard OLOS — redesign operacional

Implementação local sobre `dca50bf` (correção anterior de performance). O checkout estava limpo na auditoria inicial. Não foram revertidas alterações anteriores, alteradas credenciais, acessadas VPS/bases corporativas ou executados commit, push ou deploy.

## Resultado e arquitetura

A Dashboard contém exatamente dois cards principais: **Ligações coletadas hoje** e **Próxima leitura OLOS**. Abaixo vêm o único terminal compartilhado com Logs e o accordion **Ligações por dia**, inicialmente recolhido. Saúde da operação e detalhes de execução estão em **Status operacional**. As seis métricas antigas continuam em **Relatórios**, com resumo histórico, identificação, entrega/outbox, integridade, controle corporativo e definições; filtros, paginação e CSV foram mantidos.

| Arquivo | Responsabilidade |
| --- | --- |
| `admin/public/index.html` | Estrutura semântica, dois cards, seções de relatórios, terminal único, accordion acessível e detalhes operacionais |
| `admin/public/style.css` | Superfícies claras, verde institucional, espaçamento, hierarquia, estados, responsividade, foco e redução de movimento |
| `admin/public/dashboard.js` (novo) | Referência temporal, formatação/estado do contador diário, countdown e renderização dos dois cards |
| `admin/public/app.js` | Fetch autenticado, estado da sessão, concorrência, polling, montagem do terminal, navegação e cache visual do gráfico |
| `admin/public/ui.js` | Helpers existentes preservados; apresentação compacta dos eventos sanitizados com detalhes por linha |
| `src/admin/reports.ts` | Nova contagem por primeira persistência, calculada no snapshot histórico já existente; cache invalidado na virada do calendário |
| `src/admin/repository.ts` | `today()` reutiliza a mesma instância de `AdminReports` dos relatórios |
| `src/admin/server.ts` | GET autenticado `/api/today`, hora do servidor em `/api/status` e `/api/today`, entrega do módulo estático novo |
| `scripts/build-admin.mjs` | Empacotamento dos cinco assets, incluindo `dashboard.js` |
| `scripts/test-admin-reports.sh` | Readiness TCP do PostgreSQL descartável, evitando confundir o servidor temporário de inicialização com o servidor final |
| `package.json` | Inclui a nova suite de helpers de Dashboard em `test:admin-ui`; nenhuma dependência nova |
| `test/admin-reports.test.ts`, `test/admin-reports.database.ts` | Cache, data, contagem real, duplicidade, comparação com SQL anterior e desempenho |
| `test/admin-dashboard-ui.test.mjs` (novo), `test/admin.test.ts`, `test/admin-redesign.browser.mjs` | Estados de apresentação, contrato HTTP e navegação integrada desktop/mobile |
| `admin/premium-dashboard.md` (novo) | Relatório, fontes, decisões, resultados, limitações e procedimento de validação |
| `admin/evidence/premium-*.png` | Evidências visuais identificadas como dados sintéticos de homologação |

Não há React, biblioteca de gráficos, CDN, fontes remotas, novo scheduler ou nova leitura na API OLOS. As mudanças de apresentação não escrevem na outbox, nos recibos nem no estado operacional. As ações existentes de iniciar/pausar/parar continuam nas mesmas rotas autenticadas/CSRF e com a confirmação de parada existente.

## Fonte e semântica do contador diário

**Definição adotada:** “coletadas hoje” significa identidades persistidas localmente pela primeira vez hoje, pelo calendário `America/Sao_Paulo`. Foi explicitada na implementação e na interface. Não é o total histórico, a data de ligação, o número de operadores ou o número de confirmações corporativas.

A fonte é `olos_http.records.created_at`, preenchida pelo banco na inserção da identidade. A PK `(source_key, source_id)` e o caminho existente de inserção impedem uma duplicidade de origem de criar uma segunda identidade. O filtro por `source_key` e `target_table` é o mesmo dos indicadores históricos. Todos os operadores, inclusive não identificados, permanecem elegíveis para a contagem de coleta.

A consulta conta linhas visíveis no snapshot `REPEATABLE READ READ ONLY` cujo `created_at` está em `[início do dia, início do próximo dia)`, com limites calculados no PostgreSQL para Brasília. O contador é uma agregação adicional na consulta já otimizada: não executa uma segunda varredura e não usa um contador estimado a partir de eventos, checkpoints ou quantidade recebida pelo HTTP. Os valores são somados com `BigInt` e retornados como strings decimais.

Exemplos:

- Uma chamada de outubro persistida pela primeira vez hoje entra no card de hoje. No gráfico e nos relatórios por período, permanece na data da ligação de outubro.
- Reprocessar a mesma identidade não a conta novamente hoje.
- Histórico com `data_ligacao` de hoje, mas persistido ontem, não entra na coleta de hoje.
- Banco sem identidades elegíveis retorna `"0"`; endpoint indisponível não é convertido em zero.

`GET /api/today` retorna `date`, `calls`, `observed_at`, `timezone`, `cache_seconds`, `time_basis`, `identity` (definição, sem IDs individuais) e `server_time`. A contagem reflete o timestamp registrado na primeira inserção, não um timestamp de COMMIT ou do sistema corporativo. Anomalias de relógio/correções manuais desse campo não são reconstruídas pelo frontend.

## Fontes temporais e cadência

| Fluxo | Cadência / comportamento |
| --- | --- |
| `/api/status` | Mesmo polling de 2 s; sem requisições concorrentes intencionais dentro do mesmo ciclo |
| `/api/events` | Mesmo ciclo de 2 s, limitado a Dashboard/Logs; continua quando `/api/status` falha |
| `/api/today` | Consulta inicial, a cada 30 s na Dashboard, retorno à aba e transição do dia; requisições em voo são coalescidas no backend |
| Snapshot SQL compartilhado | Até 300 s; mesmo cache, trava de requisição em voo, espera após falha e timeout SQL de **5 s** da correção anterior |
| Relógio visual | Tick local de 1 s; calcula `next_run_at − tempo do servidor`, sem fetch por segundo e sem somar/decrementar ticks acumulados |
| Gráfico | Nenhuma requisição de série ao carregar a Dashboard recolhida; expansão reutiliza snapshot visual válido, inclusive recebido de Relatórios; aberto, revalida somente quando expira |

A sincronização usa `server_time` recebido na resposta e `performance.now()` para o tempo decorrido. A hora do status é capturada junto ao estado atual do scheduler, após a observação do banco. Não se presume intervalo de 60/120 s e não se infere um novo agendamento a partir do intervalo configurado. O próximo horário é sempre `DynamicScheduler.status().next_run_at`.

Quando `/status` falha ou a observação tem mais de 10 s sem atualização, o relógio passa a **Sem conexão**, em vez de continuar exibindo um agendamento como atual. RUNNING, PAUSED, STOPPED, ERROR, PAUSING e STOPPING têm apresentações explícitas. `cycle_in_progress` dá **Em leitura**; prazo alcançado sem confirmação dá **Aguardando execução**; ausência de horário dá **Sem agendamento**. Os textos do relógio não são anunciados a cada segundo por `aria-live`.

Na virada do dia, o backend invalida o snapshot do dia anterior; o frontend não carrega o número de ontem sob o título “hoje”. Mostra a transição até obter o novo acumulado. O horário visível é o da observação, não o do polling. Mesma data com falha ou snapshot expirado mantém o último valor identificado como **Desatualizado**. Sessão expirada limpa os dados e impede respostas pendentes de restaurá-los. Um novo login volta à Dashboard.

## Precisão, performance e limitações

O contador atualiza seus **dados em aproximadamente 5 minutos**, mais a latência de polling/consulta; não promete atualização de dados a cada segundo ou a cada 30 s. A UI marca o snapshot como desatualizado quando seu prazo é ultrapassado. Essa escolha reaproveita a correção anterior e evita reintroduzir uma consulta histórica pesada a cada atualização visual. O intervalo está explícito no card.

A primeira leitura ainda depende da consulta histórica otimizada e do banco local. Falha nessa consulta pode tornar tanto `/today` quanto `/reports` indisponíveis, embora seus estados de apresentação sejam independentes e um gráfico válido possa continuar visível. O gráfico e o terminal não dependem do sucesso do card ou da renderização do relógio. Permanece o custo linear de recomputar histórico a cada expiração; não há garantia de latência sob carga intensa de I/O. Relógios de Node e PostgreSQL devem estar sincronizados, especialmente na virada do dia.

Se for necessário frescor de dados de 30 s com menor custo, a alternativa segura é uma consulta diária separada, apoiada por índice em `(source_key, target_table, created_at)`, a ser avaliada em homologação e publicada por procedimento próprio. Não foi criado índice nem executada migração. Somar contadores de ciclos/eventos seria inadequado: não garante histórico completo, exclusão de duplicidades nem consistência após recuperação.

O terminal é uma projeção sanitizada do mesmo feed limitado a 200 eventos. Mostra os últimos 12 por padrão; “Mostrar todos”, busca e filtro acessam os demais. Ordenação, níveis visuais e detalhes não alteram nem apagam a auditoria. Copiar usa os eventos sanitizados que correspondem aos filtros. Payloads, e-mails, CPF, senhas e tokens não são introduzidos na apresentação.

## Validação e evidências

Os testes de navegador usam somente um servidor HTTP de fixtures em localhost, com dados sintéticos explicitamente identificados nas imagens:

- [Desktop](evidence/premium-desktop.png)
- [Mobile](evidence/premium-mobile.png)
- [Gráfico expandido](evidence/premium-expanded.png)
- [Relatórios](evidence/premium-reports.png)

Cobertura: exatamente dois cards; valor diário distinto do histórico; incremento, erro e recuperação; virada de Brasília; estados do scheduler e atualização do horário; ausência de fetch por tick; accordion inicialmente recolhido, Enter/Espaço e reabertura sem nova consulta; falha SVG; gráfico indisponível com card funcional; status indisponível com terminal funcional; filtros/pausa/cópia/scroll; seis métricas e integridade em Relatórios; paginação/CSV; todas as ações e abas existentes; logout com respostas pendentes; expiração HTTP 401; desktop/mobile sem overflow e sem erros de página/console JavaScript. Respostas HTTP 401/503 são injetadas deliberadamente nos cenários de falha; suas mensagens de rede esperadas não são tratadas como erros JavaScript. O teste também verifica scroll manual preservado, filtro de período de um único dia e `prefers-reduced-motion`.

### Resultados locais (09/11/2026)

| Verificação | Resultado |
| --- | --- |
| `npm test` | 98 testes aprovados |
| `npm run test:admin-ui` | 8 testes aprovados |
| PostgreSQL descartável, incluindo cenário denso de 1,6 milhão | 11 testes aprovados; nenhum ignorado |
| Playwright / Chromium | Fluxo integrado aprovado em desktop (1440 px) e mobile (390 px) |
| `npm run typecheck:admin` | Aprovado |
| `npm run build` / `npm run build:admin` | Aprovados; cinco assets empacotados localmente |
| `npm run typecheck` | **Falha preexistente: 17 erros** em `test/corporate-delivery.integration.ts`, iguais ao baseline; referências a APIs históricas ausentes (`assertHistoryReady` etc.) e modo `history` |
| `git diff --check` | Sem problemas de whitespace |

O typecheck global não está verde e não foi alterado para esconder essas falhas. A suite corporativa de integração não foi executada; as mudanças não acessam bancos corporativos. O primeiro ensaio do banco descartável encontrou `57P03` durante inicialização; o runner foi corrigido para aguardar o listener TCP final, e a execução completa seguinte passou. Nenhuma falha nova ficou pendente nas verificações do escopo.

### Comparação de desempenho

Fixture local com **1.600.013 registros**, outbox correspondente e distribuição densa de 1.000 operadores, após `ANALYZE`/`CHECKPOINT`, sem testes concorrentes durante a medição:

| Implementação | Tempo observado |
| --- | --- |
| SQL legado com `calls AS MATERIALIZED` | Cancelado por `statement_timeout` de 5.000 ms |
| SQL otimizado, incluindo a nova contagem por `created_at` | **2.409 ms** |
| Nova consulta de período usando o mesmo snapshot | **3 ms** |

A comparação diferencial com o SQL legado preservou os campos históricos, períodos, operadores e classificações de recibos. A nova métrica diária passou por limites exatos do calendário, captura histórica, duplicidades, destino diferente, fonte vazia e renovação do cache. Esses tempos são uma amostra sintética, não um SLA ou evidência da produção. Planos locais foram gerados pelo teste em `/tmp/admin-reports-{estimated,new}-562075.json`; para guardar evidência durável em homologação, capturar os planos e estatísticas da execução naquele ambiente autorizado. O procedimento detalhado da otimização anterior permanece em [reports-performance.md](reports-performance.md).

## Reproduzir e preparar publicação controlada

Usar Node 24 e o lockfile existente. Nenhuma dependência da aplicação foi adicionada.

```sh
npm test
npm run test:admin-ui
npm run typecheck
npm run typecheck:admin
npm run build
npm run build:admin
bash scripts/test-admin-reports.sh
REPORT_BENCH_ROWS=1600000 REPORT_BENCH_DENSE=1 REPORT_BENCH_EXPLAIN=1 bash scripts/test-admin-reports.sh
```

O teste de banco cria e remove seu próprio PostgreSQL descartável. Não carrega `.env` nem usa `DATABASE_URL`. A preparação inclui fixtures, `ANALYZE` e `CHECKPOINT` somente nesse banco. Executar o benchmark sem outras cargas de teste concorrentes; o resultado não valida a VPS.

Para validar visualmente com Playwright/Chromium já disponíveis, sem alterar as dependências do projeto:

```sh
ADMIN_PLAYWRIGHT_PATH=/caminho/node_modules/playwright \
ADMIN_CHROMIUM_PATH=/caminho/chrome \
node test/admin-redesign.browser.mjs
```

Antes de uma futura publicação, revisar a definição de coleta por `created_at` e o frescor de 5 minutos; confirmar planos/latência em uma cópia autorizada e representativa; conferir calendário e relógios; executar regressões de autenticação e controles operacionais. Publicar backend e os **cinco** assets compatíveis juntos. Não é necessária mudança de schema. O rollback é de código/assets e não envolve recibos ou dados. Este trabalho não executou publicação nem validou produção.
