# Dashboard administrativa: consulta histórica e isolamento de renderização

Correção local de 09/11/2026. Sem acesso à VPS, bancos corporativos, commit, push ou deploy. Nenhuma migração executada. O SQL de preparação dos testes cria apenas fixtures em um PostgreSQL descartável, com porta aleatória ligada a `127.0.0.1`; o runner não lê `.env` nem `DATABASE_URL`.

## Auditoria e comportamento

| Aspecto | Antes | Agora |
| --- | --- | --- |
| Consulta | `calls AS MATERIALIZED` com todas as linhas; três consumidores: histórico, período e dias; `COUNT(DISTINCT)` repetido | Projeção inline; agregação por dia/ID/nome/classificação, depois operador identificado e dia; apenas agregados saem do PostgreSQL |
| Atualização a cada 30 s | Cache de 30 s para um único período; alternar períodos descarta o benefício | Snapshot histórico único por instância/source/destino por 300 s, compartilhado entre quaisquer períodos válidos |
| Concorrência | Outro período retorna `REPORT_BUSY` | Requisições simultâneas aguardam a mesma consulta |
| Falha | Cada polling pode repetir a consulta histórica | Espera de 300 s depois da falha, inclusive de conexão; próxima solicitação após o prazo tenta novamente |
| Timeout | 5 s por statement | Mantido em 5 s; lock timeout mantido em 1 s |
| Compilação SQL | Política JIT do servidor | `SET LOCAL jit=off` apenas na transação de relatórios, para não gastar o orçamento curto compilando o plano |
| Renderização | Exceção do gráfico entra no catch da consulta e apaga os cards | Erro do gráfico fica no gráfico, inclusive no resize; contagens válidas permanecem |
| Falha após sucesso | Limpa os indicadores | Mantém o último snapshot e seu horário com aviso explícito de possível desatualização; primeiro carregamento continua indisponível |
| HTTP | Timeout genérico `LOCAL_OR_DATABASE_FAILURE`; indisponibilidade explícita tratada como 400 | Cancelamento SQL `57014` sanitizado como `REPORT_TIMEOUT`/503; indisponibilidade 503; `Retry-After: 300`; período inválido continua 400 |

A materialização e as releituras são verificáveis no código anterior. O efeito sobre spill/I/O depende do plano e do ambiente. Não foi inspecionado um plano de produção. A informação sobre os cancelamentos em produção foi fornecida pelo solicitante.

Não foi identificado um erro de classificação no CASE original que justificasse mudar a regra de negócio. Foram preservados detalhes SQL fáceis de perder numa otimização:

- Unidade de contagem: linha de `records`, cuja PK é `(source_key, source_id)`, filtrada também por `target_table` exatamente como antes. Não deduplicar por CallId nem contar todas as linhas da tabela de destino. As chaves únicas existentes impedem multiplicação nas junções.
- Dia: `data_ligacao AT TIME ZONE 'America/Sao_Paulo'`, limites inclusivos. `created_at` e data de confirmação não substituem a data da chamada. Linhas sem data/mapping continuam no histórico e fora dos períodos.
- Operador: ID textual positivo canônico e nome não vazio/não placeholder, preservando regex, case-insensitive e whitespace Unicode originais. `0`, `007`, NULL e placeholders não se tornam operadores identificados. Nomes não são reescritos.
- Operadores do período/histórico são a **união** dos IDs dos dias, incluindo o grupo sem data apenas no histórico. Somar distintos diários seria errado. IDs permanecem internos ao snapshot, sem exposição no JSON/CSV.
- CPF/e-mail significam texto não vazio depois do trim original; não são validações de formato nem critérios de entrega.
- Recibos: primeiro ausência (`not_queued`), depois divergência de target/hash (`inconsistent`), depois estado/remote ID/data coerentes. `pending` exige ambos os campos de confirmação nulos. Recibo parcial é divergente, nunca confirmação. Ausência da tabela mantém contagens de entrega `null`, inclusive com período vazio.
- `failed_reads` mantém o filtro original por source e erro não nulo, sem limitar por período ou target.
- Somatórios usam `BigInt` e retornam strings decimais, preservando valores acima de `Number.MAX_SAFE_INTEGER`. O desenho SVG continua usando escala numérica visual; tabelas, cards, tooltips e CSV mantêm os valores textuais exatos.

## Consistência e custo

A agregação e a leitura de `failed_reads` usam a mesma transação `REPEATABLE READ READ ONLY`. O snapshot só entra no cache depois de ambas concluírem; falhas não publicam resultados parciais. `observed_at` é o horário da transação, não o horário do polling. O frontend mostra a cadência de 300 s. A transação é encerrada com rollback e liberação da conexão, também em erro; isso também restaura a política JIT original da sessão. Não há alteração global de configuração.

Não há tabela materializada, trigger, watermark, contador persistente, alteração de recibos ou novo processo agendado. Um incremento por `created_at` perderia confirmações tardias, mudanças de mappings e cargas históricas. A recomputação integral periódica incorpora essas alterações e não depende de invalidadores nos caminhos operacionais.

Uma leitura completa das linhas pertinentes continua necessária para totais históricos exatos sem um mecanismo transacional de manutenção de agregados. Foi removida a materialização desnecessária por chamada e o trabalho repetido por período; não se promete eliminar toda varredura. Classificação de entrega é calculada como chave do primeiro agrupamento, evitando repetir o CASE para cada contador em cada chamada. A regex de identificação é avaliada sobre grupos com o mesmo dia, ID, nome já aparado e classificação; a regra é constante dentro desses grupos. Assim, operadores recorrentes deixam de exigir a mesma regex para cada chamada. Identidades inválidas são reunidas no segundo agrupamento, sem perder suas chamadas.

O cache é em memória e por instância, sem coordenação entre processos. Reiniciar o processo exige uma leitura inicial. Mais instâncias multiplicariam as recomputações. Memória depende dos pares distintos dia/operador, não só do número de dias; cardinalidade extrema deve ser medida. Não são lidos payloads da outbox, CPF/e-mail ou nomes para o processo Node: somente contagens e IDs internos de operadores identificados.

## Testes e medição

Usar Node 24 conforme `package.json`, Docker local e dependências do lockfile:

```sh
npm ci --ignore-scripts
npm test
npm run test:admin-ui
npm run typecheck
npm run typecheck:admin
npm run build
npm run build:admin
bash scripts/test-admin-reports.sh
REPORT_BENCH_ROWS=1600000 REPORT_BENCH_EXPLAIN=1 bash scripts/test-admin-reports.sh
REPORT_BENCH_ROWS=1600000 REPORT_BENCH_DENSE=1 REPORT_BENCH_EXPLAIN=1 bash scripts/test-admin-reports.sh
```

Os testes PostgreSQL não são incluídos por `npm test`; execute o runner específico. O runner cria e remove seu próprio container, inclusive em falha. `REPORT_BENCH_ROWS` aceita múltiplos de 10 de 200.000 a 1.600.000. A preparação da carga não faz parte do tempo da consulta. Há um `CHECKPOINT` apenas na fixture para concluir a escrita massiva antes da medição; `AdminReports` nunca emite esse comando. Isso modela consulta sobre histórico já persistido, não a concorrência com uma carga massiva recém-inserida. O perfil padrão usa 10% identificados e baixa cardinalidade; o denso usa todos identificados, mil operadores sintéticos e 30 dias. Ambos têm fixtures adicionais com limites de calendário, outros sources, nomes inválidos, datas nulas e recibos divergentes.

`REPORT_BENCH` imprime tempos de leitura nova, resposta em cache e SQL anterior; timeout anterior aparece explicitamente. A comparação antiga usa `test/fixtures/admin-reports-before.sql`, congelado antes da edição. Os testes comparam todos os campos entre as duas implementações nos cenários pequenos, e também na carga maior quando a consulta anterior completa no seu limite original de 5 s. Um cancelamento em 5 s não informa a duração completa da consulta anterior. O perfil denso não representa todo o histórico real, distribuição de payloads, hardware ou concorrência operacional.

Com `REPORT_BENCH_EXPLAIN=1`, planos estimados e `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF, FORMAT JSON)` são gravados em `/tmp/admin-reports-*-<pid>.json`. `EXPLAIN ANALYZE` executa a consulta, portanto o runner só o usa no banco descartável. Os planos executados também respeitam 5 s; os limites são impressos no benchmark. Observe `Execution Time`, `Actual Rows/Loops`, métodos de agregação/junção, sort em disco, hash batches, buffers compartilhados e temporários. Ausência do plano por timeout é falha de medição, não evidência de ausência de spill.

A instrumentação do plano estimado ocorre no wrapper de teste e pode acrescentar alguns milissegundos ao `query_ms`. Compare várias execuções frias e aquecidas em homologação representativa, evitando outras cargas sintéticas concorrentes. Não extrapole linearmente o teste de 200 mil para 1,6 milhão.

O teste de navegador é inteiramente simulado e exige Playwright/Chromium disponíveis:

```sh
ADMIN_PLAYWRIGHT_PATH=/caminho/node_modules/playwright \
ADMIN_CHROMIUM_PATH=/caminho/chrome \
node test/admin-redesign.browser.mjs
```

Ele verifica gráfico, cards, resize com exceção SVG, falha de atualização mantendo snapshot sinalizado, relatórios/CSV, sessão expirada, desktop e mobile, sem serviços reais.

## Evidência local

Ambiente: Node 24.16.0, PostgreSQL 16.15 em container descartável, `work_mem=4MB`, dois workers paralelos por gather. JIT padrão do servidor habilitado, desligado somente dentro da transação de relatórios. Timeout entregue preservado em 5 s; work_mem e configuração global inalterados.

- `npm test`: **97/97**; helpers de UI: **4/4**; PostgreSQL com 1,6 milhão de registros e mil operadores: **10/10**. Chromium passou em desktop/mobile, incluindo falha SVG, erro de atualização após snapshot válido e logout com resposta pendente.
- Builds backend/frontend e typecheck do frontend passaram. Uma checagem adicional de `src/**/*.ts` e demais testes, com configuração temporária fora do repositório, também passou.
- **`npm run typecheck` geral retorna exit 1**: 17 erros em `test/corporate-delivery.integration.ts`, envolvendo `historyCaptureAuthorized`, `assertHistoryReady` e modo `history`. Uma cópia limpa de `git archive HEAD` produziu saída idêntica, confirmada com `cmp`. O arquivo e a configuração oficial de typecheck não foram alterados para ocultar essas falhas.

Medição automatizada final, após preparar a fixture e executar seu `CHECKPOINT`, sem cache da aplicação na primeira leitura:

| Medida | Resultado |
| --- | --- |
| Registros do source | 1.600.013 |
| Perfil | 1.600.000 identificadas sintéticas, mil operadores e 30 dias, mais casos de borda |
| Consulta anterior, limite original de 5 s | `statement_timeout` |
| Nova leitura, incluindo protocolo e montagem da resposta | **3.544 ms** |
| Resposta em cache | **5 ms** |
| Novo plano executado com instrumentação | **4.603,954 ms** |
| Resultados do source | histórico 1.600.013; período 1.600.009; identificadas no período 1.600.003; operadores 1.001 incluindo a fixture adicional |

O plano retornou 34 grupos de dias, incluindo NULL, e 30.013 grupos de identidade antes da classificação. Ainda houve sort externo e hash em 32 batches: **62.251 blocos temporários lidos e 62.868 escritos** no nó raiz. São contadores inclusivos; não somar os mesmos buffers novamente pelos nós filhos. A otimização não eliminou todo spill. Plano integral local: `/tmp/admin-reports-new-490938.json`; log da suite: `/tmp/exportdata-dashboard-final-verified-db.log` (arquivos temporários desta execução, não necessários para reproduzir).

Comparação adicional com o mesmo orçamento diagnóstico de 10 s para ambas as consultas, após persistência da carga: **anterior 7.052 ms, nova 2.245 ms**, com igualdade de **todos** os campos de histórico, período, dias e falhas. Esse orçamento foi usado somente para medir a referência anterior até o fim; o código entregue mantém 5 s. A diferença entre as medições reforça que cache de páginas, plano e carga local afetam o tempo; não é uma garantia de latência.

**Limitação observada:** medições imediatamente após gerar a carga massiva sofreram cancelamentos também na reescrita, inclusive num experimento com 10 s. Não foi estabelecida uma causa exclusiva para essa variação; aumentar o limite não foi adotado como correção. A medição automatizada separa a preparação de dados do relatório com `CHECKPOINT` de teste e não comprova o comportamento durante backfills, concorrência ou pressão intensa de I/O. As primeiras versões também atingiram timeout na carga densa antes de adiar a classificação por regex. A carga é sintética, com payloads pequenos: não valida retenção OLOS, largura real das tabelas, capacidade da VPS ou concorrência de produção. Os testes não autorizam afirmar validação em produção.

## Validação antes de deploy

1. Revisar o diff e este relatório. Resolver ou registrar separadamente os erros preexistentes de TypeScript descritos na evidência; não tratar a checagem geral como verde.
2. Executar os testes e medições acima. Em uma cópia **local/homologação**, autorizada e com distribuição representativa, verificar chaves/índices, estatísticas, versão PostgreSQL, RAM e cardinalidade dia/operador. Não executar este runner contra bases existentes.
3. Comparar histórico, períodos, dias e todas as classificações numa mesma fotografia de dados. Incluir alterações tardias em recibos e backfills, antes e depois dos 300 s. Confirmar que mudança de período e múltiplos clientes não refazem SQL enquanto o snapshot está válido.
4. Exigir margem mensurável abaixo de 5 s, inclusive sob concorrência e leitura fria. Se houver timeout, investigar o plano; não declarar restaurado por causa de um cache quente, nem continuar aumentando timeout. Nenhum novo índice/migração é requisito desta alteração.
5. Revisar a aceitação da defasagem explícita de até 5 minutos mais o tempo de leitura/polling. Em falha, o último snapshot da UI pode ser mais antigo e é sinalizado; o backend não o retorna como uma nova leitura bem-sucedida.
6. O deploy permanece fora deste trabalho. Um rollback do código/assets não requer rollback de dados ou schema. Publicar backend e assets compatíveis juntos quando houver autorização operacional própria.

Scheduler, ingestão, controle corporativo, sincronização, regras de negócio e ciclo de eventos de 2 s permanecem fora do diff. A consulta já existente de status/observação pode ter custos próprios, não medidos aqui; esta correção se limita ao caminho `/api/reports` e sua apresentação.

## Arquivos

- `src/admin/reports.ts`: agregação exata, snapshot, concorrência, prazo de cache/falha e erro sanitizado.
- `src/admin/server.ts`: status HTTP e Retry-After de relatórios.
- `admin/public/app.js`, `admin/public/ui.js`: renderização isolada e indicação de frescor/erro.
- `test/admin-reports.test.ts`, `test/admin-reports.database.ts`: cache, totais, SQL real, concorrência, classificações e benchmark.
- `scripts/test-admin-reports.sh`: limpeza do container e de seu volume descartável após o teste.
- `test/fixtures/admin-reports.sql`: schema descartável restrito ao teste, sem executar migrações.
- `test/fixtures/admin-reports-before.sql`: consulta anterior para equivalência e medição.
- `test/admin.test.ts`, `test/admin-ui.test.mjs`, `test/admin-redesign.browser.mjs`: HTTP e falhas independentes de apresentação.
- `admin/reports-performance.md`: auditoria, evidência e procedimento.
