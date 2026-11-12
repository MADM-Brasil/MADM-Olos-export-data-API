# Recuperação autorizada de uma leitura ExportDataV3

Implementação local. Nenhum comando abaixo foi executado em produção. Não há migração nova.

## Condição de segurança

`read-data-current-day` recebe somente `TableName`. O código e o catálogo não comprovam uma recaptura integral nem ausência de consumo do cursor. A pesquisa pública não encontrou contrato oficial suficiente. Continuamos tratando esse POST como potencialmente consumptivo, sem retry. `RESPONSE_TOO_LARGE`, `processed_count=0`, os 8.220 registros da leitura anterior e o maior ID local **não provam o intervalo perdido**.

Antes de qualquer releitura real, obter da OLOS, para a mesma conta/instância/tabela:

1. Confirmação de que a operação original terminou, sem requisição ainda em voo.
2. Correlação inequívoca entre a leitura original e a entrada de `log-read-data`: DateExport, DateRead, PKIDStart, PKIDEnd e Quantity.
3. Enumeração exaustiva dos AttemptsRawDataID afetados, ou prova formal que permita enumerá-los exatamente. Não preencher buracos por suposição. Contagem e extremos isolados não estabelecem a lista de uma faixa esparsa.
4. Confirmação do contrato de `re-read-data`: limites inclusivos, cobertura completa, retenção e ausência de alteração do cursor normal. Não habilitar `rereadCursorSafe` por inferência do nome do endpoint.

O manifesto é uma aprovação administrativa dessas evidências, não uma assinatura da OLOS. A aplicação confere o hash do arquivo oficial, uma única entrada correspondente, quantidade, extremos e a lista aprovada; não consegue autenticar a origem externa de um arquivo recebido do operador. Se essas evidências não existirem, manter RECONCILIATION_REQUIRED.

Sem o corpo original, não é possível comparar seus campos com a resposta perdida. A prova local verifica os IDs aprovados e o conteúdo recuperado efetivamente persistido; qualquer garantia de imutabilidade histórica desses campos depende do contrato OLOS.

## Esquema e limites

O plano é acrescentado a `reads.spec.recovery_authorization`. Não altera corpo, erro, checkpoint, data inicial ou estado da leitura original. Cada filho mantém a ligação ao pai e ao hash em `spec.recovery`. O journal e o lock PostgreSQL da origem são os existentes.

- Manifesto/evidência: arquivos regulares privados (0600), até 8 MiB cada; até 200.000 IDs e 2.000 intervalos por aprovação.
- IDs são strings decimais canônicas de bigint; intervalos disjuntos e ordenados; IDs únicos e ordenados dentro de cada intervalo. Cada intervalo tem até 10.000 posições inclusivas. Pode haver buracos, desde que a lista exata seja comprovada.
- `MAX_RESPONSE_BYTES` mantém seu comportamento e padrão de 32 MiB. **Não aumentar esse limite para repetir a leitura perdida.**
- `RECOVERY_MAX_RESPONSE_BYTES` limita somente a captura manual: padrão e teto de 8 MiB, e nunca supera MAX_RESPONSE_BYTES no transporte. Pode ser reduzido. Preparar inicialmente intervalos pequenos, por exemplo até 100 IDs, ajustados ao tamanho real das chamadas. O procedimento abaixo utiliza 2 MiB. O teto conservador considera o parse em memória no Admin de 2 GiB; não é uma garantia universal de RSS, que deve ser monitorado junto aos demais processos do container.
- A aprovação também vincula URL/conta/client ID por fingerprint, TLS, fuso, baseline e os dois limites. Manter o mesmo ambiente nos comandos. Alterações são recusadas, sem sobrescrever a aprovação anterior.
- O corpo é persistido antes do parse. A validação integral do filho antecede o primeiro lote: nenhum ID esperado pode faltar; extras e duplicatas divergentes são recusados. Duplicatas com conteúdo idêntico são deduplicadas pela persistência existente.
- A regra de baseline continua válida: uma exclusão de registro esperado bloqueia o filho antes de escrever. Não converter exclusão em sucesso nem alterar silenciosamente a regra de negócio.
- `verify` processa um corpo de filho por vez e consulta os marcadores em lotes indexados. Confere hashes e persistência local: raw no modo local; outbox ou admissão íntegra ainda não materializada no modo corporativo. Não consulta o destino corporativo nem exige confirmação de entrega para provar captura local. Não muda recibos, quarentenas ou estados da outbox.

## Procedimento para 2523225a-a46d-407a-ad5a-d1ff771e576e — 12/11/2026

### 1. Preparar sem consumir

Publicar a versão candidata somente mediante autorização separada. No painel autenticado, solicitar **STOPPED**, aguardar ausência de ciclo em andamento e conferir o estado desejado. Manter outros consumidores da mesma conta/origem parados. Não alterar Corporate Delivery ou quarentenas. O lock local não coordena Postman nem consumidores em outros bancos.

Executar os comandos na imagem candidata, com Node 24 e o mesmo ambiente privado do serviço, incluindo credenciais OLOS, SOURCE_TIME_ZONE e INGESTION_BASELINE. Se as credenciais forem mantidas apenas pelo painel, provisionar o ambiente privado da CLI por procedimento autorizado; não imprimir/descriptografar credenciais em logs. Um arquivo `--env-file` não substitui variáveis já presentes no ambiente.

Exemplo abaixo para um shell já no diretório `/app` do container autorizado, com ambiente correto. O serviço versionado no Dokploy é `admin`; confirmar o container por label antes de usar `docker exec`. Não usar um container inferido por nome nem iniciar outro scheduler.

```bash
export RECOVERY_MAX_RESPONSE_BYTES=2097152
parent='2523225a-a46d-407a-ad5a-d1ff771e576e'
node dist/main.js status
```

Confirmar UUID, reading, RESPONSE_TOO_LARGE, processed=0 e anotar `started_at`. Este fluxo aceita apenas current sem corpo. O timestamp vincula a intenção local; DateExport vem da evidência OLOS, não de StartDate nem de uma conversão presumida de started_at. Correlacionar a operação com a OLOS, inclusive se atravessou a meia-noite; não editar timestamps.

Somente após autorização da consulta do log, salvar a evidência sem imprimir seu conteúdo:

```bash
umask 077
recovery_dir="$(mktemp -d /tmp/olos-read-recovery.XXXXXX)"
node dist/main.js log-read 2026-11-12 "$recovery_dir/official-log.json"
sha256sum "$recovery_dir/official-log.json"
```

Preservar esse diretório em armazenamento privado durável antes de reiniciar/recriar o container: `/tmp` do Dokploy é efêmero. Verificar espaço no PostgreSQL para respostas, normalizados e outbox. Não há limpeza automática das evidências.

### 2. Preparar e aprovar o manifesto

Preparar `$recovery_dir/manifest.json` com permissão 0600. O exemplo é deliberadamente inválido até substituir os campos indicados por **evidência real**, inclusive a lista completa. `targetTable` inclui as aspas do identificador SQL. Não reutilizar UUID/intervalos de 28/10.

```json
{
  "version": 1,
  "sourceKey": "ORIGEM_EXATA_DO_SERVICO",
  "targetTable": "\"raw\".\"olos_calls\"",
  "parentId": "2523225a-a46d-407a-ad5a-d1ff771e576e",
  "parentStartedAt": "STARTED_AT_EXATO_DO_STATUS",
  "date": "2026-11-12",
  "evidenceRef": "REFERENCIA_DO_CHAMADO_OLOS",
  "evidenceSha256": "SHA256_DO_ARQUIVO_OFFICIAL_LOG",
  "remoteOperationComplete": true,
  "rereadCursorSafe": true,
  "exactIdsConfirmed": true,
  "operation": {
    "start": "PKIDSTART_DA_OPERACAO_ORIGINAL",
    "end": "PKIDEND_DA_OPERACAO_ORIGINAL",
    "quantity": "QUANTITY_DA_OPERACAO_ORIGINAL",
    "dateRead": "DATEREAD_EXATO_DO_LOG"
  },
  "ranges": [
    {"start": "INICIO_DO_PRIMEIRO_BLOCO", "end": "FIM_DO_PRIMEIRO_BLOCO", "expectedIds": ["TODOS_OS_IDS_COMPROVADOS_DESTE_BLOCO"]}
  ]
}
```

Subdividir **todo** o conjunto perdido em blocos aprovados. Os extremos globais e a quantidade de IDs únicos devem corresponder à operação oficial selecionada. Os nomes/maiúsculas do log conferem com o formato já observado no repositório; formato distinto é recusado e exige análise, não adaptação improvisada da evidência.

```bash
chmod 600 "$recovery_dir/manifest.json" "$recovery_dir/official-log.json"
manifest_sha="$(sha256sum "$recovery_dir/manifest.json" | cut -d ' ' -f 1)"
OLOS_REREAD_CONFIRMATION=AUTHORIZE_EXPORTDATA_REREAD_RECOVERY \
  node dist/main.js recovery-authorize \
  "$recovery_dir/manifest.json" "$recovery_dir/official-log.json" "$manifest_sha"
```

Guardar o `authorization_hash` retornado. Ele é o digest canônico da aprovação, **não** necessariamente o SHA do arquivo. Repetir a autorização idêntica é seguro se houve perda de ACK; alteração do plano/configuração é recusada. Não substituir por outro plano quando houver filho incerto.

### 3. Capturar e processar um bloco por vez

Substituir somente pelos limites de um bloco já aprovado e pelo hash retornado:

```bash
authorization_hash='HASH_RETORNADO_PELA_AUTORIZACAO'
start_id='INICIO_EXATO_DO_BLOCO_APROVADO'
end_id='FIM_EXATO_DO_BLOCO_APROVADO'
node dist/main.js capture-reread "$parent" 2026-11-12 "$start_id" "$end_id" \
  --authorization "$authorization_hash"
node dist/main.js recover-local
node dist/main.js status
```

Prosseguir ao próximo bloco somente se ambos os primeiros comandos tiverem sucesso e `status` mostrar apenas o pai pendente. Registrar privadamente o bloco e UUID do filho retornado. Não repetir bloco concluído: a sobreposição é recusada sem novo POST. `recover-local` usa as referências existentes e pode consultá-las na OLOS; não consome AttemptsRawData. Seu kick corporativo existente continua sujeito aos controles corporativos, que não são alterados por esta feature.

Em reinício: inspecionar `status` antes de agir. Filho received: executar somente recover-local; lotes já confirmados são retomados pelo checkpoint. Filho reading sem corpo, timeout ou RESPONSE_TOO_LARGE: **parar**. Não repetir, resolver o filho, apagar journal, trocar UUID ou aumentar limite para contornar. Isso exige nova reconciliação externa; esta correção não inventa a evidência necessária. Falha de banco em um lote não avança o checkpoint desse lote; lotes anteriores confirmados permanecem válidos.

Metadados adicionais, se necessários para escolher o próximo bloco após interrupção, podem ser consultados sem escrever no banco:

```sql
BEGIN READ ONLY;
SELECT id,state,processed_count,received_count,error_code,
       spec->>'date' AS export_date,spec->>'start' AS start_id,spec->>'end' AS end_id
FROM olos_http.reads
WHERE source_key = 'ORIGEM_EXATA_DO_SERVICO'
  AND spec->'recovery'->>'parentId' = '2523225a-a46d-407a-ad5a-d1ff771e576e'
ORDER BY started_at,id;
ROLLBACK;
```

### 4. Provar cobertura e resolver

```bash
node dist/main.js recovery-verify "$parent"
```

Exigir complete=true, covered=expected, missing=0, conflicts=0, pending=0 e completed=children=quantidade de blocos aprovados. O comando retorna exit 1 quando incompleto e não resolve nada. `received_count`, contagem de linhas, menor/maior ID ou ausência de erros isoladamente não autorizam resolução.

```bash
verification_digest='DIGEST_RETORNADO_COM_COMPLETE_TRUE'
node dist/main.js resolve "$parent" "recovery:$verification_digest"
node dist/main.js recovery-verify "$parent"
node dist/main.js status
```

`resolve` recalcula a prova antes de escrever; texto livre é recusado para este caso. Exigir parent_state=resolved e ausência de pendências. Se a confirmação da resolução se perder, reinspecionar; repetir a mesma resolução com a mesma prova é idempotente. Corpo NULL, erro original e checkpoint original permanecem preservados.

### 5. Retomar e homologar

Somente então solicitar RUNNING pelo painel, se esse for o estado desejado pelo operador. Conferir desired_state=RUNNING, estado RUNNING sem erro, pelo menos um novo ciclo done com contagens coerentes, next_run_at restabelecido e ausência de reading/received indevidos. PAUSED/STOPPED não são alterados pela CLI. Não declarar recuperação concluída sem essa evidência e a prova anterior guardadas.

Interromper em divergência, perda de lock, indisponibilidade de evidência, limite de resposta, filho incerto ou memória próxima ao limite. Manter journal, aprovações, respostas, checkpoints, outbox e recibos. Não fazer rollback de dados. Em rollback de código, manter STOPPED e preservar o banco; o binário anterior não entende a aprovação e seu resolve não deve ser usado para concluir este protocolo. A recuperação deve continuar com código compatível.
