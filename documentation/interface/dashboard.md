# Dashboard

[Manual do painel](README.md) / Dashboard

## Finalidade

Oferecer uma visão rápida do fluxo de ligações observado no MADM, do agendamento e da evolução histórica. A tela inclui indicadores, gráfico expansível e o mesmo terminal visual de eventos usado na página **Terminal / Logs**.

## Elementos

| Elemento | Descrição | Atenção |
|---|---|---|
| **CHAMADAS NO MADM HOJE** | Contagem de linhas físicas em `raw.olos_calls` no dia em Brasília, obtida por `/api/corporate/daily` | Não é o número de primeiras persistências locais |
| **Atualizar coleta do dia** | Solicita atualização da consulta do dia usando `refresh=1` no relatório corporativo | Não inicia uma leitura consumidora da OLOS; há proteção contra acionamentos repetidos |
| **Próxima leitura OLOS** | Contagem regressiva baseada no estado do scheduler | Pode mudar quando um ciclo demora ou o scheduler está parado |
| **Ligações por dia** | Gráfico recolhível com filtros Hoje, 7, 14 e 30 dias | Agrupamento pela data da ligação |
| **Ver relatório analítico completo** | Navega até **Relatórios** | Não altera a coleta |
| **Terminal de eventos** | Compartilhado com Terminal / Logs | Observabilidade, não shell remoto |

## Como usar

1. Confirme a data de Brasília e o estado da plataforma.
2. Leia o indicador **Chamadas no MADM hoje**, observando a data/hora da última atualização.
3. Consulte a próxima leitura para entender a programação, não o volume futuro de chamadas.
4. Expanda o gráfico e escolha a janela de análise.
5. Abra **Relatórios** para detalhamento e exportação.

## Fontes e limitações

O fluxo ativo do contador usa `/api/corporate/daily` e exige resposta com `source='madm.raw.olos_calls'` e `count_basis='physical_rows'`. Existe também `/api/today`, cujo contrato é **primeira persistência local**; não confunda as duas grandezas. O frontend pode conservar o último valor conhecido, identificando-o como desatualizado. Veja [Indicadores](../referencia/indicadores.md).

## Se a contagem parecer incorreta

Verifique o horário da observação, a diferença entre **data da ligação** e **data da primeira persistência**, o estado do relatório corporativo e a conectividade da fonte. Não reinicie o worker apenas para atualizar o cartão.
