# Agendamento

[Manual do painel](README.md) / Agendamento

## Finalidade

Controlar a frequência das leituras da OLOS e solicitar transições do scheduler, preservando ciclos ativos.

## Elementos

- **Intervalo em minutos:** inteiro entre **1 e 60**, convertido pelo frontend em `interval_ms` e enviado via `PATCH /api/schedule`.
- **Salvar intervalo:** atualiza o intervalo entre ciclos. A operação em andamento não é interrompida automaticamente.
- **Pausar agendamento:** solicita `PAUSED` com `POST /api/worker/pause`.
- **Retomar agendamento:** solicita `RUNNING` com `POST /api/worker/resume`.
- **Última alteração:** mostra administrador e horário, quando disponíveis.

Os comandos globais do painel também permitem **Iniciar Worker** e **Parar Worker**; a parada exige confirmação explícita em uma janela modal.

## Procedimento seguro

1. Confirme o estado atual em **Status operacional**.
2. Antes de mudar o intervalo ou o estado, valide a necessidade operacional.
3. Execute apenas a ação autorizada.
4. Aguarde a observação do **estado real**. O HTTP `202` indica solicitação recebida, não transição concluída.
5. Consulte **Terminal / Logs** se a mudança não ocorrer como esperado.

## Estados intermediários

A implementação prevê `PAUSING` e `STOPPING`, que permitem aguardar a conclusão/liberação do trabalho ativo. O agendamento pode influenciar a atividade da entrega corporativa: o código invoca `suspendDelivery()` em solicitações diferentes de `RUNNING`. O efeito exato sobre uma tentativa já em andamento depende da implementação do consumidor.

> [!CAUTION]
> Não altere o intervalo para testar desempenho e não force um restart quando houver leitura `reading` potencialmente incerta. Consulte [Recuperação](../backend/recuperacao.md).
