# Dicionário de indicadores

[Início](../README.md) / Referência

> [!IMPORTANT]
> **As métricas não são todas aditivas nem usam a mesma dimensão temporal.** Leia a coluna “base temporal” antes de compará-las.

| Indicador | Fonte | Base temporal / regra | Limitação |
|---|---|---|---|
| Chamadas no MADM hoje | `raw.olos_calls` via `/api/corporate/daily` | `data_ligacao` no dia Brasília | Linhas físicas, não contagem de `records` |
| Chamadas coletadas hoje (contrato `/api/today`) | `olos_http.records` | `created_at` da primeira persistência local | Diferente do cartão corporativo ativo |
| Chamadas no MADM no período | `raw.olos_calls` | `data_ligacao` entre os limites em Brasília | Histórico corporativo |
| Com operador | `raw.olos_calls` | `nome_agente` não vazio na consulta | Não equivale à elegibilidade de entrega |
| Operadores distintos | `raw.olos_calls` | `COUNT(DISTINCT nome_agente)` na janela inteira | Não somar valores diários |
| Confirmadas no período | `corporate_outbox` | `confirmed_at` no intervalo | Não representa chamadas daquele intervalo por data de ligação |
| Outbox pendente | `corporate_outbox` | `state='pending'` agora | Não tem filtro de data do relatório |
| Inseridos / duplicidades | Log do último ciclo | Evento `batch_completed` | Não é acumulado histórico |
| Controle liberado | `corporate_control` | Estado local (`ready`, `paused`, `blocked`) | Não prova escrita ou conectividade corporativa |
| Indicadores de integridade indisponíveis | Fluxo corporativo da UI | Exibidos como `—` quando não fornecidos | **Não significa zero** |

## Por que os totais diferem?

Porque **MADM**, **captura OLOS**, **primeira persistência local**, **fila da outbox** e **recibos confirmados** são eventos distintos, em momentos diferentes. Uma confirmação tardia pode atualizar o total de recibos sem que a chamada tenha ocorrido no mesmo dia da confirmação.

## Atualização

A consulta corporativa diária mantém cache de **60 segundos**. Snapshots locais possuem contrato separado (300 segundos de cache nominal e limite de idade de 900 segundos), mas seu **atualizador estava desabilitado** na produção auditada. O frontend de Dashboard pode solicitar observações em intervalos menores sem causar nova leitura OLOS.
