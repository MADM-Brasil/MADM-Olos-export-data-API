# Troubleshooting

[Operação](README.md) / Diagnóstico

## Matriz de sintomas

| Sintoma | Verificações seguras | Evitar |
|---|---|---|
| Dashboard sem contagem | Data de Brasília, horário de observação, acesso ao relatório MADM, status HTTP | Forçar leitura OLOS |
| Scheduler desejado `RUNNING`, real `STOPPED` | Logs de inicialização, estado atual, tempo desde boot, `last_error` | Reinícios repetitivos |
| `batch_completed` com zero recebidos | Comparar histórico de ciclos e disponibilidade da origem | Tratar zero como falha automaticamente |
| `RECOVERY_REQUIRED` | Identificar `read_id`, `state`, `processed_count`, existência de resposta durável | Apagar `reads` ou consumir novamente |
| Entrega pendente | Consultar `corporate_control`, `corporate_outbox` e erros, sem payload | Editar recibos manualmente |
| Relatório indisponível | Origem corporativa, intervalos, cache, timeouts, fonte utilizada | Confundir com snapshots locais desabilitados |
| CPU alta no banco | Coletar múltiplas amostras e `pg_stat_activity` | Reiniciar PostgreSQL sem diagnóstico |

## Consulta de atividade SQL (somente leitura)

```bash
DB="olos-export-data-madmolosexportdataapi-vqrnw6-postgres-1"
sudo docker exec "$DB" psql -U olos_app -d olos_exportdata -X -P pager=off -c "
SELECT pid,state,wait_event_type,wait_event,
       clock_timestamp()-query_start AS duration,
       LEFT(query,200) AS sql_excerpt
FROM pg_stat_activity
WHERE datname='olos_exportdata' AND pid<>pg_backend_pid() AND state='active'
ORDER BY query_start;"
```

Antes de compartilhar uma amostra, confira se o SQL não contém literais com dados pessoais.

## Registro mínimo de incidente

**Horário de Brasília**, versão da imagem, estado real/desejado, IDs de leitura relevantes, erro, último ciclo concluído, situação da outbox e comandos de leitura utilizados. Documente o que foi observado e o que continua incerto; não inferir resolução a partir de ausência de erros.

**Escalonamento:** chamar responsável pela integração OLOS quando for necessário verificar se uma chamada consumidora alterou o cursor remoto.
