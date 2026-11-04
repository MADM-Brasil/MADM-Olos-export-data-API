# Planejamento histórico: índice local para operadores

Revisão sobre `1e50a89`, branch `feature/exportdata-history`. Somente código e
PostgreSQL descartável foram utilizados. Nenhuma leitura OLOS, alteração MADM,
migration operacional, commit, push ou deploy foi executado.

## Alteração e equivalência

O plano informado em produção varria aproximadamente 725 mil mappings, fazia
Nested Loops na outbox e ordenava por `target_id` antes do LIMIT. O custo informado
era 40622 e o statement excedia 2 segundos. Não houve acesso ao plano completo ou
ao banco de produção nesta revisão.

A migration **local** `008_drain_operator_index.sql` acrescenta somente:

```sql
CREATE INDEX CONCURRENTLY records_identified_operator_order
  ON olos_http.records (source_key,target_id)
  WHERE agent_id ~ '^[1-9][0-9]*$';
```

Ela também atualiza estatísticas das duas tabelas locais com `ANALYZE`. Não cria
índice na MADM, coluna, registro de negócio, novo payload, hash ou recibo.
O predicado parcial usa somente a elegibilidade do AgentId: nome e período
dependem da outbox e continuam sendo filtrados na consulta **antes do LIMIT**.

`drain-selection.ts` contém a seleção usada pelo runtime e pelo benchmark.
O predicado de AgentId passa a ser uma constante SQL do código, igual à migration,
para permitir o índice inclusive em plano preparado genérico. Origem e demais
valores continuam parametrizados. A ordem passa a `r.target_id`, equivalente à
anterior porque `r.target_id=o.target_id` continua obrigatório. O índice da outbox
pendente existente é reutilizado; não foi necessário outro índice nem forçar
o planner a escolher um tipo de join.

O cast `o.target_id::text=o.source_id` foi preservado como filtro residual. Fazer
cast do identificador textual para bigint alteraria a regra de identidade para
zeros à esquerda e texto inválido. As buscas pelos índices usam as colunas sem
esse cast. A unicidade do destino mantém a ordenação determinística.

Continuam obrigatórios: nome identificado, setembro/outubro de 2026 no fuso
America/Sao_Paulo, somente pendentes, `internal_id_olos=AttemptsRawDataID`, ambos
os timestamps locais anteriores ao pai ou proveniência validada de filho `done`.
Permanecem `FOR UPDATE OF o,r NOWAIT`, validações posteriores da seleção,
manifesto congelado, contrato v1, locks, hashes, recibos, guardas de COMMIT incerto
e degraus de lote. Pai `reading/RESPONSE_TOO_LARGE` e filho `received/[]` não são
modificados; vazio não cria prova de recuperação.

## Ensaio reproduzível

Com Node 24 e dependências já instaladas:

```bash
npm run typecheck
npm run build
npm test
bash scripts/test-corporate-sync.sh
bash scripts/test-corporate-delivery.sh --drain-performance > /tmp/drain-performance.log 2>&1
```

O último comando executa Admin, Store e Corporate Delivery completos, mais o
benchmark opcional. Cria PostgreSQL 16 com TLS verificado, rede Docker interna,
nenhuma porta publicada e tmpfs de até 3 GB; remove seus recursos no final.
Não lê configuração operacional. Sem a flag, o runner mantém tmpfs de 768 MB
e omite somente a massa de desempenho.

Cada uma das duas massas tem 725.287 mappings e outboxes, incluindo dois
confirmados prévios. Cenários: operadores distribuídos (`uniform`) e concentrados
nos últimos 11.259 registros (`tail`). Incluem AgentId 0, -1 e `007`, nomes
ausentes/placeholder, novembro, IDs legados e admissões posteriores sem prova.
Pai interrompido e filho recebido vazio coexistem durante todo o ensaio.

Compara-se a seleção da base publicada sem índice, a mesma seleção com índice
e a consulta final com índice. São três repetições por cenário/fase/lote de
100, 250, 500 e 1.000, com `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` e comparação
da lista **ordenada e exata** dos IDs. Cada transação de medição termina em
ROLLBACK. Também são testados SELECT preparado com `force_generic_plan`, uso
efetivo de `generic_plans` e o EXPLAIN EXECUTE correspondente.

Finalmente, o comando real de planejamento e a entrega/replay são exercitados
em sequência 100 → 250 → 500 → 1.000, exclusivamente contra destino descartável.
Não se fabrica um estágio anterior concluído. Conferem-se 1.852 destinos finais,
preservação integral das leituras/journals e Delivery ainda pausado.
As regressões existentes cobrem proveniência de filhos `done`, pai sozinho,
filhos desconhecidos/incertos, identidade, datas, deduplicação, recibos e COMMIT
incerto. O teste adicional da migration confere índice válido e evidências
anteriores inalteradas.

O runtime e todas as seleções medidas mantêm `statement_timeout=2s`.
**Somente a preparação sintética e a sessão DDL** têm orçamento explícito de
60 segundos por statement. A primeira tentativa de gerar toda a outbox em um
statement excedeu esse orçamento de preparação; a fixture agora materializa
payloads uma vez e carrega blocos de 25 mil. Isso não muda a seleção medida.

## Resultados

Os resultados e EXPLAINs estão em
[drain-plan-performance.json](drain-plan-performance.json). Dados sintéticos,
tmpfs e caches aquecidos não reproduzem IO, concorrência, estatísticas nem
latência da instalação operacional. A consulta antiga também terminou abaixo
de 2 segundos neste ambiente: o timeout real informado não foi reproduzido.
O ganho demonstrado é a eliminação da varredura completa de `records` e do Sort,
com redução das consultas à outbox até satisfazer o LIMIT. Nested Loops
permanecem, agora sobre um conjunto menor. Custo estimado é uma unidade do
planner, não milissegundos; os custos locais não são comparáveis ao 40622
informado para produção.

Medições finais em 2026-11-04; medianas de três execuções da seleção, em ms.

| Distribuição | Lote | Base sem índice | Só índice | Consulta final + índice |
| --- | ---: | ---: | ---: | ---: |
| uniform | 100 | 206.657 | 1.072 | 1.036 |
| uniform | 250 | 202.462 | 2.320 | 2.459 |
| uniform | 500 | 194.260 | 4.845 | 6.022 |
| uniform | 1000 | 201.776 | 10.124 | 10.256 |
| tail | 100 | 175.368 | 0.845 | 0.885 |
| tail | 250 | 174.775 | 2.012 | 2.050 |
| tail | 500 | 175.437 | 4.255 | 4.281 |
| tail | 1000 | 175.706 | 9.940 | 8.641 |

EXPLAIN do lote de 100 (primeira repetição):

| Distribuição | Custo base → final | Acessos à outbox base → final | Buffers hit+read base → final |
| --- | ---: | ---: | ---: |
| uniform | 86080.09 → 76128.49 | 11334 → 143 | 60345 → 1339 |
| tail | 88932.46 → 74854.46 | 11261 → 138 | 60050 → 979 |

A maior seleção otimizada medida foi 17.567 ms. O planejamento
administrativo completo ficou entre 42.253 e 117.540 ms
(incluindo guardas, validações, manifesto e preflight do destino descartável).
O índice ocupou 568 kB / 560 kB; a sessão
de migration com ANALYZE levou 2041.290 / 492.964 ms.
Os dois SELECTs preparados usaram plano genérico e o índice parcial.

No banco sintético, o plano anterior tinha Seq Scan não paralelo em `records`,
Nested Loops e Sort. O final tem Index Scan em `records_identified_operator_order`,
Nested Loops em `corporate_outbox_pending`/`reads_pkey`, sem Sort. O estimador
continuou subestimando a cardinalidade após os filtros JSON (1 linha estimada
para 100 retornadas); a melhora do custo estimado é menor que a de trabalho real.
A fase “só índice” demonstra que o índice é responsável pelo ganho principal.

Validação: typecheck e build aprovados, 111/111 unitários,
39/39 no runner Corporate Sync e 165 aprovados no runner completo Admin/Store/Corporate Delivery
com desempenho; zero falhas e zero skips.

## Aplicação controlada e homologação

1. Em ambiente de homologação autorizado, conferir origem, banco local, versão
   do código e migrations anteriores, inclusive 007. Manter Admin encerrado,
   scheduler disabled/STOPPED, Delivery ready/paused, escrita geral false e
   ausência de run aberto ou COMMIT incerto. Registrar evidências do pai, filho,
   journals e confirmados antes da janela, conforme
   [backlog-drain-v1.md](backlog-drain-v1.md). Não resolver nem reprocessar leituras.
2. Aplicar **somente no banco local**, em conexão psql dedicada e fora de
   transação (`-1` é incompatível com CONCURRENTLY). O nome da variável abaixo
   deve apontar para um serviço libpq privado já revisado, sem senha no comando:

   ```bash
   PGOPTIONS='-c statement_timeout=60000 -c lock_timeout=2000' \
     psql -X -v ON_ERROR_STOP=1 "service=${DRAIN_LOCAL_PG_SERVICE:?}" \
     -f migrations/008_drain_operator_index.sql
   ```

   O orçamento DDL de 60s é explícito e separado; pode ser insuficiente em outro
   ambiente. A migration não altera defaults nem o timeout do comando. Adquire
   os fences de entrega/consumo/Admin, confere manutenção após os locks e recusa
   banco `madm`, estrutura ausente, timeouts ilimitados e intenções abertas.
   Interromper diante de erro, sem retry automático; fechar a sessão libera os
   locks, inclusive em falha parcial.
3. Conferir definição, validade e prontidão do índice:

   ```sql
   SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
   FROM pg_index i
   WHERE i.indexrelid = to_regclass('olos_http.records_identified_operator_order');
   ```

   Deve retornar uma linha, ambos os flags true e o predicado exato acima.
   CREATE INDEX CONCURRENTLY pode deixar índice inválido em caso de falha.
   Por isso não há `IF NOT EXISTS`: investigar antes de nova aplicação.
   Eventual remoção/recriação deve atingir somente este índice local, em janela
   controlada; jamais apagar journals, planos, recibos ou leituras.
4. Executar `corporate-drain-plan` com lote 100 e
   `--statement-timeout-ms 2000`, mantendo todos os demais parâmetros e guardas
   do [procedimento existente](backlog-drain-v1.md#homologação-inicial-de-100).
   Comparar EXPLAIN, IDs, datas, operadores e proveniência. EXPLAIN ANALYZE com
   `FOR UPDATE` adquire locks: usar transação normal seguida de ROLLBACK, não
   transação READ ONLY. O plano administrativo cria journal local e faz
   preflight corporativo somente leitura; não entrega registros.
5. Após revisão do UUID/hash, homologar a entrega exata pelo fluxo existente e
   conferir recibos, payloads, pai e filho. Avançar 250 → 500 → 1.000 somente
   com os estágios anteriores realmente confirmados. Nesta implementação as
   entregas foram executadas apenas no PostgreSQL descartável.
6. Se houver timeout, ausência do índice no plano ou divergência, manter a pausa
   e investigar estatísticas/IO/contenção. Não aumentar timeout silenciosamente,
   descartar o filho vazio, contornar proveniência ou selecionar novas chamadas
   da OLOS. A reversão desta otimização é de código/índice local; não desfaz
   entregas, recibos nem intenções que precisem de reconciliação.
