# Validação local e desempenho

Execução sintética de 28/10/2026, sem chamadas OLOS ou banco corporativo.

- PostgreSQL 16 no container isolado, volume persistente, rede interna sem porta publicada.
- Prisma 7.10.1 com adapter pg, pool de 4 conexões (uma reservada ao lock).
- Node 24 na imagem; runtime não-root, filesystem read-only, limite de memória do lab 512 MiB.
- Transações usam createMany para brutos/normalizados e checkpoint na mesma transação.

Primeira medição: **5.000 registros, 10 transações de até 500**, incluindo staging da resposta, validação e persistência:

| Medida | Resultado |
|---|---:|
| Duração | 1.294 ms |
| Vazão observada | 3.864 registros/s |
| RSS ao final da medição | 239.509.504 bytes (~228 MiB) |
| Heap ao final da medição | 59.257.480 bytes |

Os registros são pequenos e sintéticos. RSS/heap são amostras ao final, não pico. A execução concorre com outras cargas do host e não estabelece SLA, uso máximo de memória, throughput corporativo ou latência ponta a ponta. Não inclui disponibilização pela OLOS, HTTP, enriquecimento remoto ou escrita corporativa. Reexecutar `bash local/scripts/test.sh` imprime a medição atual como JSON, sem dados pessoais.

A suíte final aprovou **18 testes**, incluindo o executável compilado em processos separados para validar `resume`, `status` e rejeição de `start`. A regressão do worker existente aprovou outros **42 testes**. Typecheck, build e validação do schema Prisma passaram.

Na repetição final, os mesmos 5.000 registros foram persistidos em **1.241 ms** (4.029 registros/s), com RSS final de 237.281.280 bytes e heap de 57.792.504 bytes. Esses números continuam sujeitos às limitações da medição sintética acima.

Foram verificados: migration Prisma local, typecheck/build, raw original preservado, rollback completo do lote que falha, checkpoint parcial confirmado, retomada, ACK perdido, deduplicação por identidade, chegada tardia sem filtro por maior PK, data de baseline com microssegundos e reprocessamento sem avanço de checkpoint. O banco principal permaneceu vazio. Nenhuma amostra HTTP transacional real foi validada.
