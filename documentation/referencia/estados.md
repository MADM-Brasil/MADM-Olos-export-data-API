# Estados e transições

[Início](../README.md) / Referência

## Leituras `olos_http.reads`

| Estado | Descrição | Próxima ação esperada |
|---|---|---|
| `reading` | Intenção registrada, resposta não confirmada como durável | Verificar incerteza antes de nova leitura |
| `received` | Resposta persistida, processamento pode estar parcial | `drain()` local, sujeito às validações |
| `done` | Progresso concluído e finalizado | Histórico concluído |
| `resolved` | Caso encerrado com justificativa persistida | Consultar evidências da resolução |

## Scheduler

**Desejados:** `RUNNING`, `PAUSED`, `STOPPED`.
**Reais:** `RUNNING`, `PAUSING`, `PAUSED`, `STOPPING`, `STOPPED`, `ERROR`.

`desired_state` é intenção do operador; `runtime_state` é o estado observado. Divergência durante transição não é automaticamente erro, mas requer contexto temporal.

## Entrega corporativa

**Outbox:** `pending`, `confirmed`, `skipped`.
**Controle:** `ready`, `paused`, `blocked` são flags independentes; não tratar `ready` como confirmação de escrita.

## Snapshots

`report_snapshot_state.status`: `initializing`, `building`, `ready`, `error`. Uma geração publicada é imutável e validada por hash/contrato.

**Veja:** [Recuperação](../backend/recuperacao.md).
