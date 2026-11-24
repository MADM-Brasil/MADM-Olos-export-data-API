# Monitoramento seguro

[Operação](README.md) / Monitoramento

## Princípio

Investigar por **leitura**, sem gerar chamadas consumidoras adicionais da API OLOS.

## Inspeção de containers

```bash
ADMIN="olos-export-data-madmolosexportdataapi-vqrnw6-admin-1"
DB="olos-export-data-madmolosexportdataapi-vqrnw6-postgres-1"
sudo docker ps --filter "name=olos-export-data" --format 'table {{.Names}}	{{.Status}}'
sudo docker inspect "$ADMIN" --format 'Imagem={{.Config.Image}} Estado={{.State.Status}} Reinicios={{.RestartCount}}'
sudo docker stats --no-stream "$ADMIN" "$DB"
```

## Estado do scheduler (somente leitura)

```bash
sudo docker exec "$DB" psql -U olos_app -d olos_exportdata -X -P pager=off -v ON_ERROR_STOP=1 -c "
SELECT desired_state,runtime_state,last_error,interval_ms
FROM olos_http.worker_settings
WHERE source_key='olos-production';"
```

## Controle de entrega (somente leitura)

```bash
sudo docker exec "$DB" psql -U olos_app -d olos_exportdata -X -P pager=off -v ON_ERROR_STOP=1 -c "
SELECT ready,paused,blocked,failure_count,last_code,confirmed_count
FROM olos_http.corporate_control WHERE singleton=true;"
```

## Logs relevantes

```bash
sudo docker logs --since 15m "$ADMIN" 2>&1 |   grep -E 'batch_completed|scheduler_resumed|scheduler_error|recovery_required|corporate_delivery_confirmed' | tail -30
```

Verifique as regras internas antes de encaminhar logs a terceiros. Em alertas, registre **horários, estado real, estado solicitado, read_id e código de erro**, evitando payloads.

## Como interpretar

Uma leitura com `received=0` e `batch_completed` significa **ciclo concluído sem registros retornados**; isoladamente não é falha. CPU alta em apenas uma medição não comprova sobrecarga sustentada. `pending_now` é fila atual, não total histórico do intervalo selecionado.
