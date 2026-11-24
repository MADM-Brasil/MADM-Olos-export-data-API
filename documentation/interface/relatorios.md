# Relatórios de Integração & Telemetria

[Manual do painel](README.md) / Relatórios

## Finalidade

Consultar chamadas presentes no **banco corporativo MADM**, operadores e situação dos recibos locais, com visualização diária e exportação CSV. O frontend ativo usa `GET /api/corporate/daily?from=AAAA-MM-DD&to=AAAA-MM-DD`.

## Filtros

**Hoje**, **Últimos 7 dias**, **Últimos 15 dias**, **Últimos 30 dias** e **Personalizado**. Intervalos aceitos pelo backend têm início e fim válidos, fim não anterior ao início e diferença inferior a **366 dias**. **Atualizar** recarrega a consulta do período; não exige nova captura histórica da OLOS.

## Cartões de resumo

| Cartão | Definição observada |
|---|---|
| Chamadas no MADM | Quantidade de linhas físicas de `raw.olos_calls` por `data_ligacao` no período |
| Com operador | Linhas com `nome_agente` não vazio na consulta MADM |
| Operadores distintos | `COUNT(DISTINCT nome_agente)` do período, não soma diária |
| Confirmadas | Contagem local de `corporate_outbox` com `confirmed_at` **dentro do período** |
| Outbox / fila | Total `pending` **agora**, sem recorte pelo período |
| Controle atual da entrega | Estado local (`ready`, `paused`, `blocked` etc.); não é teste de conexão corporativa |

## Blocos de análise

- **Validação e Integridade dos Pipelines:** o layout inclui erros, timestamps nulos, mappings ausentes e recibos divergentes. No **fluxo corporativo ativo**, o frontend apresenta `—` para vários indicadores não fornecidos por essa consulta; **não interpretar como zero**.
- **Evolução Diária & Desempenho de Despacho:** gráfico por data operacional. A data de confirmação do recibo e a data da ligação são critérios diferentes.
- **Tabela diária:** data, chamadas MADM, identificadas, informações de entrega e ações **Visualizar** / **Exportar**. Seis linhas por página no código auditado.
- **Detalhe diário:** janela com os campos disponibilizados ao clicar em Visualizar; números não fornecidos aparecem como indisponíveis.

## Exportação CSV

**Exportar CSV** gera arquivo no navegador a partir dos dados já consultados. A exportação geral usa o período selecionado; o botão de exportação de uma linha gera dados daquele dia. O nome segue o padrão `olos-chamadas-AAAA-MM-DD-AAAA-MM-DD.csv`. Não é uma exportação de payloads individuais de clientes.

## Exemplo de interpretação

Se **Chamadas no MADM = 6.000** e **Confirmadas = 400**, não conclua que 5.600 chamadas desse mesmo período aguardam entrega. O primeiro número usa **data da ligação** no banco corporativo; o segundo usa **data de confirmação** no recibo local. Além disso, **Outbox pendente** é o estado atual, não um saldo calculado por subtração.

## Atualização, limites e erros

O módulo `corporate-daily.ts` utiliza cache de **60 segundos**, acesso somente leitura ao MADM e proteção contra consultas duplicadas; consultas manuais muito próximas podem reutilizar o resultado cacheado. A disponibilidade depende da conexão corporativa. Não confundir esse fluxo com os snapshots locais (`report_snapshots`), cujo atualizador estava **desabilitado em produção** na auditoria.

**Consulte:** [Dicionário de indicadores](../referencia/indicadores.md) · [Relatórios no backend](../backend/arquitetura-backend.md).
