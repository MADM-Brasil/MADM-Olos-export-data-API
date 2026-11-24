# Terminal / Logs

[Manual do painel](README.md) / Terminal / Logs

## Finalidade

Visualizar eventos operacionais sanitizados e o histórico das **últimas 100 leituras**. A página não oferece execução de comandos do servidor.

## Terminal de eventos

| Controle | Comportamento |
|---|---|
| Pesquisar logs | Filtra eventos visíveis por texto, por exemplo `batch_completed` ou `read_id` |
| Nível | `Todos`, `INFO`, `WARN` ou `ERROR` (classificação de apresentação) |
| Autoscroll | Mantém a visualização próxima aos eventos recentes quando habilitado |
| Pausar visualização | Interrompe o avanço da apresentação; **não pausa o worker** |
| Copiar logs | Copia texto de eventos sanitizados para a área de transferência |

O mesmo componente de terminal é movido entre **Dashboard** e **Terminal / Logs** ao navegar.

## Histórico de leituras

Campos identificados: **Identificador, Início, Estado, Processados, Recebidos, HTTP (ms), Erro**. O botão **Atualizar** recarrega o histórico e os eventos.

## Eventos de referência

- `scheduler_started` / `scheduler_resumed`: inicialização e retomada solicitadas/observadas.
- `batch_completed`: resumo de um ciclo, incluindo quantidades e tempos de processamento.
- `corporate_delivery_confirmed`: quantidade de confirmações registradas.
- `scheduler_error` / `recovery_required`: eventos que exigem avaliação contextual.

> [!WARNING]
> Não publique logs brutos que possam conter informações pessoais ou segredos fora dos canais autorizados. Mesmo que o frontend aplique sanitização, siga as políticas internas de compartilhamento.

**Veja:** [Monitoramento](../operacao/monitoramento.md) e [Troubleshooting](../operacao/troubleshooting.md).
