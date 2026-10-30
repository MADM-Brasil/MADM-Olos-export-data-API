# Captura histórica ExportDataV3

`capture-history` faz **um único POST** em `read-data-previous-days`, somente com `TableName=AttemptsRawData`. Não recebe intervalo, não pagina, não agenda execuções e não garante recuperar setembro/outubro de 2026 completos. Não usar chamadas consumidoras para sondar retenção; obter os limites por documentação/evidência do provedor e auditar as datas efetivamente recebidas.

A resposta completa é persistida em `olos_http.reads` antes de ser processada. A política `{ "kind": "history" }` permanece no registro e impede o descarte pelo `INGESTION_BASELINE`, inclusive após reinicialização. No modo corporativo, novas chamadas geram `olos_http.records` e outbox **local pendente**; não são inseridas em `raw.olos_calls` local nem enviadas a MADM nesta operação. Recibos existentes são preservados; `AttemptsRawDataID` repetido com conteúdo divergente bloqueia sem sobrescrever nem inventar outro ID. `CallId` isolado não é chave de deduplicação.

## Pré-requisitos e janela autorizada

- Usar esta versão do mesmo ExportDataV3, com Node 24, dependências e migrations locais já instaladas. Nenhuma migration nova é necessária para history.
- Manter a configuração privada existente: origem correta, `ATTEMPTS_PERSISTENCE_MODE=corporate`, binding reconciliado, fuso, baseline normal e unicidade dos IDs confirmada. Não apagar o baseline; a exceção é exclusiva das respostas history.
- Exigir `ready=true`, `paused=true`, `blocked=false` no Corporate Delivery e `OLOS_CORPORATE_WRITE_ENABLED=false` no processo. Não executar `corporate-resume`/`corporate-deliver-once` nem iniciar Corporate Sync.
- Parar a captura e encerrar o processo Admin/agendador de maneira controlada. Antes de encerrar, o agendador deve ter `enabled=false`, `desired_state=STOPPED`, `runtime_state=STOPPED`. Apenas pausar na interface não basta. Ausência da configuração do agendador também bloqueia.
- Exigir ausência de qualquer leitura `reading` ou `received` para a origem. Não limpar pendências para passar nessa verificação.
- Preservar backups das respostas, mappings, outbox, recibos e controles. Verificar espaço em disco e os limites HTTP configurados; não elevar limites cegamente diante de resposta truncada.
- Não alterar configurações de produção ou parar serviços durante uma simples revisão de código. Os passos operacionais abaixo pertencem a uma janela separadamente autorizada.

Exemplo de inspeção **somente leitura no banco local**, a ser realizado pelo operador autorizado, sem exibir payloads ou credenciais:

```sql
\set source_key 'olos-production'
BEGIN READ ONLY;
SELECT enabled,desired_state,runtime_state
FROM olos_http.worker_settings WHERE source_key=:'source_key';
SELECT ready,paused,blocked,confirmed_count,generation,last_code
FROM olos_http.corporate_control WHERE source_key=:'source_key';
SELECT id,spec->>'kind' AS kind,state,processed_count,received_count,
       response_body IS NOT NULL AS response_saved,error_code
FROM olos_http.reads WHERE source_key=:'source_key'
AND state IN ('reading','received') ORDER BY started_at;
SELECT state,count(*) FROM olos_http.corporate_outbox
WHERE source_key=:'source_key' GROUP BY state;
COMMIT;
```

## Executar uma captura

No ambiente já configurado do executável existente, sem restart automático ou wrapper de retentativa:

```sh
OLOS_CORPORATE_WRITE_ENABLED=false \
OLOS_HISTORY_CAPTURE_CONFIRMATION=AUTHORIZE_EXPORTDATA_HISTORY_CAPTURE \
node dist/main.js capture-history
```

Não persistir a autorização como instrução de consumo periódico. Cada nova execução é uma nova operação consumidora e requer avaliação do resultado anterior. Argumentos de data são rejeitados. O comando pode autenticar, validar catálogo e carregar tabelas de referência; faz somente **uma requisição consumidora de chamadas**. HTTP 401/429 também não repetem o POST histórico. Os comandos `current`, `previous` e `reread` preservam suas políticas anteriores.

A intenção `reading` é confirmada localmente antes do POST. Se a gravação/COMMIT da intenção falhar, o POST não é enviado. Após autenticar, a sessão/estado são revalidados antes do envio. Os locks de origem, Corporate Sync e Admin permanecem na sessão. O lock adicional `olos-http:history:<source>` impede `corporate-resume` desta versão durante captura/recuperação. A checagem final dos estados e a inserção da intenção usam uma única transação, com locks nas linhas do agendador e controle corporativo.

Uma resposta `[]` é armazenada e termina como `done` com zero registros. Isso só comprova uma resposta vazia naquela chamada: não comprova ausência de dados históricos, retenção suficiente ou cobertura integral de qualquer mês.

## Auditar resultado e cobertura

Registrar o `read_id` do evento `batch_completed` ou `recovery_required`. Consultar `spec`, estado, `received_count` e `processed_count` em `olos_http.reads`. `queued` significa persistência na outbox local, **não entrega MADM**. Duplicatas não aumentam a fila; contagem recebida pode ser maior que IDs distintos. O controle corporativo deve continuar pausado e seu contador de confirmações não deve aumentar pela captura.

Para uma resposta `done` válida, correlacionar os IDs recebidos com mappings/outbox, sem listar dados pessoais:

```sql
\set read_id 'UUID_DA_LEITURA'
BEGIN READ ONLY;
WITH ids AS (
  SELECT DISTINCT (item->>'AttemptsRawDataID')::numeric::text AS source_id
  FROM olos_http.reads r,
       LATERAL jsonb_array_elements(r.response_body::jsonb) item
  WHERE r.id=:'read_id'::uuid AND r.source_key=:'source_key'
    AND r.spec->>'kind'='history' AND r.state='done'
)
SELECT count(*) AS distinct_received,
       count(r.source_id) AS tracked,count(o.source_id) AS in_outbox,
       count(*) FILTER (WHERE o.state='pending') AS pending,
       count(*) FILTER (WHERE o.state='confirmed') AS already_confirmed
FROM ids LEFT JOIN olos_http.records r
  ON r.source_key=:'source_key' AND r.source_id=ids.source_id
LEFT JOIN olos_http.corporate_outbox o
  ON o.source_key=r.source_key AND o.source_id=r.source_id;
SELECT ((payload->>'data_ligacao')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AS call_date,
       count(*) AS calls,count(*) FILTER (WHERE state='pending') AS pending
FROM olos_http.corporate_outbox WHERE source_key=:'source_key'
GROUP BY 1 ORDER BY 1;
COMMIT;
```

O agrupamento por data mede o conteúdo atual da outbox, incluindo dados anteriores à captura. Comparar snapshots e identificar lacunas por dia; `min`/`max`, totais ou um dia vazio não provam cobertura completa. Validar o fuso e confrontar a cobertura com evidência não consumidora do provedor. Não aplicar esse cast JSON a uma resposta inválida/truncada; nesse caso, preservar o corpo para análise restrita e não o publicar em logs.

## Recuperar sem novo consumo

Se houver uma resposta history `received`, manter Admin parado, Corporate Delivery pausado/desbloqueado e escrita desabilitada. Não executar `capture-history` novamente. Com baseline e `SOURCE_TIME_ZONE` normais configurados, executar:

```sh
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js recover-local
```

A recuperação pode autenticar e consultar referências estáticas, mas não chama endpoints consumidores de chamadas. Não precisa renovar a autorização de captura: utiliza o `spec.kind=history` durável, ignora o baseline somente para essa resposta e continua do checkpoint já confirmado. Cada lote confirma mappings/outbox/progresso na mesma transação; repetir recuperação após perda de confirmação local não duplica os IDs. Recibos já conciliados e payloads congelados permanecem intactos. Não editar `processed_count`, `spec`, resposta, IDs, hashes ou recibos.

Se houver `reading`, o resultado remoto é incerto: ausência de resposta local não prova ausência de consumo remoto. Timeout, SIGTERM, conexão perdida ou COMMIT local incerto exigem reconciliação explícita com evidências. `recover-local` não resolve esse estado nem faz novo POST; comandos normais também não drenam silenciosamente pendências history. Não executar `resolve` apenas para liberar a próxima leitura, nem repetir `read-data-previous-days`/`reread` sem análise autorizada do provedor e do intervalo/IDs efetivamente envolvidos.

`received` inválido, conflito de conteúdo/ID, estado corporativo incompatível ou checkpoint sem prova também exige análise: preservar os dados e não pular registros. Os códigos `RECOVERY_REQUIRED` e `HISTORY_RECOVERY_REQUIRED` são bloqueios, não instruções de retry. O comando retorna erro e fecha conexões/locks; a pendência continua durável.

## Retomar Admin e preparar publicação

Após auditar a captura e resolver pendências por procedimento autorizado, retirar a autorização transitória de history. Confirmar que não existe processo CLI remanescente. Iniciar somente o serviço Admin existente com `node dist/main.js admin`, mantendo o estado persistido STOPPED e a entrega pausada/escrita desabilitada. Conferir status e eventos antes de autorizar separadamente qualquer retomada da captura normal. Iniciar o Admin não autoriza entrega corporativa.

Para publicar, revisar o diff da branch `feature/exportdata-history` sobre `71709b8` e usar somente este worktree como contexto de build; nunca copiar o checkout original. Executar os comandos do relatório, revisar os arquivos listados e aprovar commit/publicação/deploy em etapa separada. Na janela de deploy, encerrar o Admin antigo, preservar dados/configuração, atualizar a mesma imagem/serviço sem executar consumo e verificar estado parado. Não há migration nova. A volta para uma versão sem suporte a history não é segura enquanto houver respostas históricas pendentes, pois ela pode reaplicar o baseline.

Os controles administrativos da janela devem usar esta versão: advisory locks exigem cooperação, não impedem SQL manual ou binários antigos que os ignorem. Não existe atomicidade distribuída entre PostgreSQL e HTTP; perdas na fronteira de envio permanecem incertas e bloqueadas. A validação sintética não comprova retenção real, volume completo de setembro/outubro, latência WAN ou cobertura do provedor. Nenhuma captura ou consulta a produção foi executada durante esta implementação.
