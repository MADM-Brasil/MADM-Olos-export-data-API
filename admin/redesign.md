# Redesign administrativo — implementação local

Data: 04/11/2026. Projeto: `export-data-v3-api`, branch `main`, base `ca9e174`.
Não houve publicação, alteração de serviços, acesso a banco real, commit ou push.

## Auditoria e limites

O painel existente é HTML/CSS/JavaScript servido por `src/admin/server.ts`, com navegação entre views em `/`, sem React, Vite, CDN ou dependência de gráficos. A estrutura foi mantida. O frontend agora usa módulos JavaScript nativos, componentes de apresentação compartilhados em `ui.js`, SVG responsivo e CSS local. Não há fontes ou scripts de terceiros.

Foram inspecionados o servidor administrativo, repository, eventos, autenticação, mapeamento, schema local, outbox, integrações de testes e origem das observações. Ações e contratos existentes continuam nos mesmos endpoints:

| Fonte/ação | Contrato preservado |
|---|---|
| Sessão | GET `/api/session`, POST `/api/login`, POST `/api/logout` |
| Status | GET `/api/status` |
| Leituras, eventos, auditoria | GET `/api/logs`, `/api/events`, `/api/audit` |
| Agendamento | PATCH `/api/schedule`, corpo `interval_ms` |
| Worker | POST `/api/worker/start`, `/pause`, `/resume`; POST `/stop` exige `confirm:true` |
| Credenciais | GET/PUT `/api/credentials`, POST `/api/credentials/test` |

Não foram modificados scheduler, Worker, consumidor administrativo, integração OLOS, Corporate Delivery, autenticação ou migrations. As modificações preexistentes em `src/api.ts`, `config.ts`, `main.ts`, `store.ts`, `worker.ts`, `test/store.integration.ts`, arquivos de billing e teste histórico foram preservadas.

O endpoint novo permanece depois da validação de sessão do servidor. Escritas antigas continuam com Origin/CSRF, cookie HttpOnly/SameSite/Secure e confirmação da parada. CSP continua restrita à mesma origem. O relatório não adiciona qualquer ação operacional. Não é necessário iniciar o worker para consultá-lo; é necessário que o repository administrativo já esteja disponível, como nos endpoints atuais.

## Interface

- Sidebar compacta com identidade tipográfica OLOS, navegação móvel, foco visível, link para pular navegação e respeito a movimento reduzido. Menu móvel fechado fica `inert`.
- Dashboard separa registro local, chamada com operador, recibo corporativo e fila pendente. Estado do scheduler, última leitura, próxima execução, erro, saúde do banco e estado do controle corporativo continuam disponíveis.
- Gráfico diário dos últimos 30 dias, em SVG com descrição acessível, tooltips e ajuste de eixos para telas menores. Valores tabulados estão em Relatórios. Dias vazios só são completados com zero após uma consulta bem-sucedida; erro nunca vira zero.
- Relatório com datas inicial/final, agrupamento diário, paginação de 14 dias com chamadas e exportação UTF-8/BOM de **todos** os dias da consulta, independentemente da página. Nenhum valor pessoal é exportado. Datas/contagens são projetadas explicitamente, impedindo fórmulas de planilha.
- Terminal único, movido entre Dashboard (abaixo do gráfico) e Terminal / Logs. Fonte original `/api/events`, até 200 eventos, pesquisa por evento, INFO/WARN/ERROR, horário de Brasília, autoscroll, pausa de visualização e cópia sanitizada.
- A fonte não publica severidade: os níveis são de **apresentação**, derivados do evento/código. `scheduler_error`, `recovery_required` ou `blocked=true` são ERROR; retry/erro adiável/exceção TLS são WARN; demais eventos admitidos são INFO. Isso está explícito na tela. Pausar o terminal não pausa o serviço.
- Eventos são novamente projetados por allowlist antes de mostrar/copiar. Payload, CPF, e-mail e campos arbitrários são descartados. Pausa mantém o snapshot visível; retomada recebe a janela atual, sem prometer recuperar eventos que saíram da memória.
- Estados de carregamento, vazio, falha e indisponibilidade explícitos. Respostas tardias de relatórios/eventos/status/credenciais são desconsideradas após troca de sessão. Não se usa armazenamento persistente no navegador.

## Origem e semântica dos dados

| Indicador | Origem/semântica |
|---|---|
| Ligações coletadas | `olos_http.records`, fonte e destino configurados. Uma linha por `(source_key,source_id)`; `source_id` é AttemptsRawDataID. CallId repetido não elimina tentativas distintas. |
| Operador identificado | `records.agent_id` decimal positivo canônico e `nome_agente` do registro **local mapeado**. Não é contagem de elegibilidade da entrega nem validação dos payloads congelados. |
| Data/grupo/período | Campo tipado `data_ligacao` do destino local configurado, vinculado por `records.target_id = internal_id_olos`, convertido por `AT TIME ZONE 'America/Sao_Paulo'`. Nunca `records.created_at` nem início de leitura. |
| Operadores distintos | `count(DISTINCT agent_id)` das chamadas com nome identificado. O total do período é calculado separadamente; não soma operadores de dias diferentes. |
| CPF/e-mail preenchidos | Somente contagem de campos locais não vazios após trim. Não valida CPF, endereço de e-mail ou titularidade. Nenhum valor sai do PostgreSQL. |
| MADM confirmadas | Estado `confirmed`, recibo local com `remote_raw_id`/`confirmed_at`, target/source_hash concordantes com o mapping. São **recibos locais**, não consulta direta à MADM, contagem de INSERTs, recomputação de hashes ou reconciliação. |
| Pendentes | Estado `pending` da outbox, sem confirmação e com mapping concordante; inclui chamadas sem operador. Divergências aparecem separadamente. |
| Sem outbox / divergentes | Mapeamento sem item de fila / item incompatível com mapping ou recibo. Não se presume sucesso, não se corrige nada. |
| Leituras com erro | Quantidade de leituras da fonte com `error_code`, incluindo histórico preservado. Não representa chamadas perdidas nem quantidade de falhas corporativas. |
| Corporate Delivery | `corporate_delivery` já exposto por `/api/status`. Controle liberado não comprova conectividade, worker em execução ou autorização de escrita. |

A regra de nome rejeita vazios/espaços ECMAScript, nomes exclusivamente numéricos e os placeholders `-1`, `null`, `undefined`, `n/a`, `unknown`, `desconhecido`, `sem operador`, `sem agente`, `não identificado`, `nao identificado`, sem distinção de caixa. AgentId não é convertido para Number. Nome original não é modificado. A política é exclusiva da apresentação: o módulo corporativo existente não foi editado/importado para executar entregas. CPF/e-mail são opcionais.

Totais do dashboard cobrem **todo o histórico local** da origem/destino. O gráfico cobre 30 dias. Totais do relatório cobrem o período escolhido. Essa separação evita confundir volumes globais com o gráfico. Registros sem data são contabilizados no total e destacados, mas ficam fora dos períodos. Mappings sem registro local são destacados separadamente. `reading`/`received`, inclusive resposta `[]`, não viram chamadas confirmadas.

## Endpoint somente leitura

`GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD`

- Período inclusivo, datas reais, máximo de 366 dias. Limite mantém resposta em até 366 agregados diários; paginação é feita no frontend, sem baixar chamadas individuais.
- Usa exclusivamente o pool **local** existente e o destino configurado no repository. Não acessa a conexão corporativa ou a OLOS.
- `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL statement_timeout='5s'`, `SET LOCAL lock_timeout='1s'`, SELECTs e ROLLBACK/finally. Nenhum INSERT, UPDATE, DELETE, DDL, COMMIT, lock de consumidor ou rotina de recuperação.
- Valores variáveis parametrizados; identificador de tabela vem da configuração existente e é escapado com `quote`. Não aceita tabela, fonte ou SQL do cliente.
- Consulta somente identificadores, data, campos necessários aos predicados de contagem e metadados dos recibos. Não lê `response_body`, payload JSONB, telefone, Lead ID nem credenciais. Nome/CPF/e-mail são avaliados no SQL, nunca retornados ao Node.
- Outbox ausente produz contagens corporativas `null`, exibidas como indisponíveis. Falha de consulta não é substituída por resultado vazio.
- Cache em memória de um snapshot/período por repository, TTL 30 s, timestamp visível. Chamadas simultâneas do mesmo período compartilham a consulta; período diferente durante consulta ativa recebe `REPORT_BUSY`. Falhas não são cacheadas.
- Apenas métricas do dashboard são atualizadas a cada 30 s. Status/eventos mantêm a cadência existente de 2 s. Relatórios são consultados ao abrir a página ou aplicar período.

## Desempenho e limites

Em PostgreSQL 16 descartável, massa sintética com **200.013 mappings** e 200 mil itens adicionais de outbox: consulta de outubro completou em **416 ms**, cache em menos de 1 ms. É uma amostra local; não prova latência em produção nem comportamento sob concorrência real.

A consulta faz agregação global e por período, com joins por chaves existentes; portanto tem custo proporcional ao volume local. Não foi criado índice, migration ou materialização persistente. O limite de 5 s é exclusivo da nova consulta, não modifica timeouts operacionais. Em volume maior/carga concorrente, indisponibilidade é preferível a contagens inventadas. Qualquer otimização futura de schema deve ser auditada separadamente. A agregação usa pool compartilhado, mas mantém no máximo uma consulta de relatório ativa por repository.

## Arquivos desta alteração

- `admin/public/index.html`, `style.css`, `app.js`: estrutura, layout, interação e reaproveitamento das ações.
- `admin/public/ui.js`: formatação, CSV, sanitização, níveis de apresentação e gráfico.
- `admin/tsconfig.json`: verificação de JavaScript existente com `checkJs`, sem migração de framework. Não é conversão integral para TypeScript estrito.
- `src/admin/reports.ts`: consulta agregada, limites e cache.
- `src/admin/repository.ts`: exposição do leitor usando o pool existente.
- `src/admin/server.ts`: rota GET autenticada e allowlist do asset `ui.js`.
- `package.json`, `scripts/build-admin.mjs`: scripts de verificação/empacotamento estático. Sem dependências novas no projeto.
- `test/admin.test.ts`: autorização e ausência de ação operacional na rota nova.
- `test/admin-reports.test.ts`, `test/admin-ui.test.mjs`: período, concorrência/falha, formatação, sanitização e CSV.
- `test/admin-reports.database.ts`, `scripts/test-admin-reports.sh`: PostgreSQL descartável, usuário SELECT-only, snapshots, massa de volume.
- `test/admin-redesign.browser.mjs`: servidor HTTP efêmero de fixtures, Chromium e fluxos completos. Não inicializa scheduler/worker nem conecta em banco/OLOS.
- `admin/redesign.md` e link no README: auditoria, semântica, comandos e evidências.

## Validação

Node 24.16.0. Ações operacionais do teste de navegador são respondidas por **fixtures em memória**, nunca por serviços existentes. Os dois runners de banco criam containers próprios e os removem no trap. Não carregam `.env`.

| Verificação | Resultado |
|---|---|
| `npm run typecheck:admin` | Aprovado |
| `npm run build:admin` | Aprovado; 4 assets em `dist/admin/public`, nenhum deploy |
| `npm run typecheck` / `npm run build` | Aprovados |
| `npm test` | 112/112 |
| `npm run test:admin-ui` | 3/3 |
| `bash scripts/test-admin.sh` | 13/13 no PostgreSQL descartável |
| `bash scripts/test-admin-reports.sh` | 6/6, incluindo volume e role SELECT-only |
| Browser Chromium isolado | Desktop/mobile, gráfico, relatórios/paginação/CSV, terminal/filtros/pausa/cópia, ações originais/CSRF/parada, indisponibilidade/vazio e respostas tardias após logout |
| `git diff --check` | Aprovado |

Playwright foi instalado **fora do projeto**, exclusivamente em `/tmp/olos-admin-ui-validation`. Reproduzir o navegador apontando para uma instalação local de Playwright e Chromium:

```bash
ADMIN_PLAYWRIGHT_PATH=/caminho/para/node_modules/playwright \
ADMIN_CHROMIUM_PATH=/caminho/para/chrome \
node test/admin-redesign.browser.mjs
```

O teste inicia/encerra seu próprio servidor em porta aleatória de loopback. Capturas em `/tmp/olos-admin-dashboard-desktop.png` e `/tmp/olos-admin-dashboard-mobile.png` estão marcadas como dados sintéticos. Fixtures nunca são incorporadas ao painel servido em produção.

O frontend continua sendo estático, sem bundler. `build:admin` verifica os módulos e copia os quatro assets para revisão; o Dockerfile existente continua copiando `admin/public`, sem alterações. Nenhuma ação de publicação foi executada. Compatibilidade e latência no ambiente real ainda exigem homologação separada autorizada.
