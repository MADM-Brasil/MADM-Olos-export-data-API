# Recuperação administrativa de INTERNAL_ID_COLLISION

Implementação local; nenhum procedimento deste documento foi executado na VPS. O contexto informado é `blocked=true`, `last_code=INTERNAL_ID_COLLISION`, 479 pendentes e coleta OLOS retomada. Esses valores não foram consultados em produção. O diagnóstico determina a fila atual; a contagem pode ter aumentado com novas capturas.

## Contrato dos comandos

`node dist/main.js corporate-verify-pending` é estritamente somente leitura: usa `REPEATABLE READ READ ONLY` nos dois bancos, sem Store, chamadas OLOS, locks de ownership, migrations, INSERT, UPDATE, recibos ou timers. Retorna exit code 0 somente com validação concluída sem divergências. Uma falha de conexão/schema termina com erro e nunca representa uma validação aprovada.

O comando percorre **todos** os pendentes da origem, em ordem de `target_id`, com paginação. Reutiliza o predicado SQL de admissão automática, `deliveryPayload`/`mapRow`, `projection`, `compare` e a consulta `matchCandidates` da entrega. Valida o schema/funções e seu hash congelado, integridade dos payloads/hashes/IDs, vínculo em `records`, identidades duplicadas inclusive entre páginas e correspondências remotas por ID ou identidade lógica. A cobertura inclui pendentes atualmente inelegíveis, para impedir que um conflito escondido depois do LIMIT ou dos filtros seja ignorado. `eligible` informa quantos passariam pelos mesmos filtros da entrega; a recuperação não altera esses filtros ou estados. Uma linha ausente no destino é uma inserção pendente normal; uma linha existente precisa ser integralmente compatível.

As linhas `corporate_pending_divergence` contêm somente IDs internos/corporativos, nomes de campos e códigos de erro. Não mostram telefone, nome, CPF, email, CallId, datas das chamadas, valores anteriores/esperados, URLs ou payloads. A linha final `corporate_pending_verified` contém contagens, `valid` e `verification_digest`. O digest SHA-256 vincula origem/binding, schema, geração/bloqueio, fila local e resultados remotos. O comando não persiste diagnóstico no banco; o operador pode guardar o stdout em arquivo privado.

`node dist/main.js corporate-recover-collision ...` exige por invocação:

- `OLOS_CORPORATE_RECOVERY_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_RECOVERY`;
- `--confirm-source` igual, byte a byte, ao `OLOS_SOURCE_KEY` aprovado;
- `--verification` com o digest do diagnóstico aprovado;
- `--request-id` UUID exclusivo da operação;
- `--evidence` referência opaca de aprovação/incidente, sem dados pessoais, com 1–100 caracteres de `[A-Za-z0-9._:-]`.

A autorização habitual de escrita/`corporate-resume` não substitui essa autorização. O comando recusa outros códigos de bloqueio, origem/binding divergentes, homologação ativa, dependência Billing incompatível, schema alterado, conflitos e digest desatualizado. A tabela de evidência precisa existir, mas o diagnóstico funciona sem ela.

A liberação bloqueia a linha de controle e mantém `SHARE` em `records`/outbox local e `raw.olos_calls` remoto. Assim, aguarda operações anteriores e impede novas admissões locais, entrega/resume e escritores remotos durante a revalidação e o COMMIT local. Isso pode causar espera breve na persistência da coleta já retomada; não para nem reprograma o coletor. Locks/statement timeouts e privilégios insuficientes fazem a operação falhar preservando o bloqueio; não há GRANT, retry ou escalada automática. A identidade de conexão configurada precisa ter os privilégios PostgreSQL necessários para esses locks; revisar isso na janela aprovada sem alterar o binding para contornar a proteção.

O PostgreSQL não permite `LOCK ... SHARE` em transação READ ONLY. Por isso **somente a liberação** abre uma transação remota convencional, executa consultas/lock e sempre faz ROLLBACK remoto; não executa DML/DDL no MADM. O diagnóstico permanece READ ONLY nos dois lados.

A liberação grava uma linha em `olos_http.corporate_collision_recoveries` e muda somente o controle administrativo: `blocked=false`, **`paused=true`**, `last_code=NULL`, falhas/backoff zerados e geração incrementada. Os dois efeitos locais são atômicos. A evidência conserva UUID, origem/binding, digest, referência, código/geração anteriores, contagens, schema hash e horário da liberação. Payloads, hashes congelados, IDs, recibos, chamadas, respostas e checkpoints permanecem intactos. O código insere evidências; não atualiza ou apaga evidências anteriores.

Repetir exatamente a mesma requisição retorna `already_applied=true` e não libera novamente, mesmo se surgiu outro bloqueio. O mesmo UUID com parâmetros diferentes é rejeitado. Isso também permite reconciliar `CORPORATE_RECOVERY_COMMIT_UNKNOWN`: manter o mesmo UUID/digest/referência e consultar a evidência ou repetir a mesma invocação. Não gerar outro UUID para contornar um resultado incerto. A proteção normal de entrega continua verificando cada lote após a liberação; não há garantia de atomicidade distribuída nem de que escritores externos não mudarão dados depois que os locks forem liberados.

## Execução na VPS, somente após aprovação

Pré-requisito: versão revisada já disponibilizada no mesmo worker, com os dois novos comandos e a migration local. Este documento não autoriza build/deploy. Executar no diretório do projeto Compose efetivamente usado na VPS. Se o serviço for administrado por outro projeto, informar o ID exato do container aprovado no lugar da descoberta abaixo. Não iniciar outro worker nem o Corporate Sync antigo.

```bash
set -euo pipefail
umask 077
container="$(docker compose ps -q worker)"
test -n "$container"

# Preencher com a origem literal e a referência aprovadas; não inferir de contagens/IDs de chamadas.
source_key='SUBSTITUIR_PELA_ORIGEM_EXATA_APROVADA'
evidence_ref='SUBSTITUIR_PELA_REFERENCIA_DA_APROVACAO'

# Estado atual, sem retomada e sem alteração da coleta.
docker exec "$container" node dist/main.js corporate-status

# Somente no banco LOCAL: usar conexão DBA aprovada já carregada na sessão.
# Executar a partir do checkout revisado, com psql disponível; nunca apontar para MADM.
: "${LOCAL_DBA_DATABASE_URL:?defina a conexao administrativa do banco local aprovado}"
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f migrations/006_corporate_collision_recovery.sql

# Diagnóstico somente leitura e arquivo privado exclusivo para esta revisão.
verification_file="$(mktemp /tmp/corporate-verify-pending.XXXXXX)"
docker exec "$container" node dist/main.js corporate-verify-pending > "$verification_file"
cat "$verification_file"
```

Interromper se exit code não for zero ou houver `valid=false`, `divergences>0`, erro de schema/conexão ou divergência. Revisar a causa usando os IDs/campos; este procedimento não fornece comando para corrigir/ignorar dados. Um diagnóstico válido não prova a causa histórica do bloqueio nem autoriza automaticamente a liberação.

Depois de aprovar o diagnóstico, copiar os 64 caracteres de `verification_digest` para `verification_digest` abaixo, mantendo o arquivo aprovado. Não usar um digest de execução com erro.

```bash
verification_digest='SUBSTITUIR_PELO_DIGEST_DO_DIAGNOSTICO_APROVADO'
request_id="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"

# Guardar os parâmetros antes da tentativa, para permitir repetição exata após queda da sessão.
request_file="$(mktemp /tmp/corporate-collision-request.XXXXXX)"
printf 'source=%s\nverification=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$verification_digest" "$request_id" "$evidence_ref" > "$request_file"
cat "$request_file"

docker exec \
  -e OLOS_CORPORATE_RECOVERY_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_RECOVERY \
  "$container" node dist/main.js corporate-recover-collision \
  --confirm-source "$source_key" \
  --verification "$verification_digest" \
  --request-id "$request_id" \
  --evidence "$evidence_ref"

docker exec "$container" node dist/main.js corporate-status
```

Resultado esperado da primeira liberação: `already_applied=false`, evidência persistida, `blocked=false`, `paused=true`; nenhuma chamada foi entregue por esse comando. `already_applied=true` confirma somente a evidência anterior: conferir o estado atual antes de prosseguir. Se a coleta admitiu registros ou o destino mudou entre o diagnóstico e a liberação, `CORPORATE_VERIFICATION_STALE` mantém o bloqueio: executar novo diagnóstico, revisar/aprovar o novo digest e usar nova requisição, desde que não exista COMMIT incerto pendente de conciliação.

Consultar a evidência local com parâmetros SQL (também útil após COMMIT incerto), sem selecionar payloads:

```bash
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v request_id="$request_id" <<'SQL'
BEGIN READ ONLY;
SELECT request_id, source_key, binding, verification_digest, evidence_ref,
       previous_code, previous_generation, pending_count, eligible_count,
       existing_count, schema_hash, released_at
FROM olos_http.corporate_collision_recoveries
WHERE request_id=:'request_id'::uuid;
COMMIT;
SQL
```

Somente com a evidência e o estado conferidos e a retomada aprovada, executar o resume existente. Ele exige as autorizações habituais de escrita já configuradas no worker. Não alterar o Environment ou persistir a autorização de recuperação para fazer esse passo funcionar.

```bash
docker exec "$container" node dist/main.js corporate-resume
docker exec "$container" node dist/main.js corporate-status
docker logs --since 5m --tail 100 "$container"
```

A entrega é retomada pelo ciclo existente. Não executar `corporate-deliver-once`, não parar/iniciar a coleta OLOS e não criar serviço, timer ou retry adicional. A contagem pendente pode subir com novas capturas; acompanhar confirmações e eventuais novos bloqueios em vez de esperar uma redução exata de 479. Se necessário, `docker exec "$container" node dist/main.js corporate-pause` pausa somente a entrega, preservando fila/evidências.

## Validação local

Executar com Node 24, sem arquivos de ambiente operacionais:

```bash
npm run build
npm test
OLOS_DIRECT_TEST_FILES=test/corporate-recovery.integration.ts \
  bash scripts/test-corporate-delivery.sh
bash scripts/test-corporate-delivery.sh
npm run typecheck
git diff --check
```

A suíte dirigida usa rede Docker interna, PostgreSQL descartável sem portas publicadas e TLS verificado. Cobre diagnóstico read-only nos dois bancos, paginação, privacidade, identidade/conteúdo/hash/mapeamento divergentes, duplicidade entre páginas, inelegíveis, prova desatualizada, schema/binding, falhas de conexão, exclusão de homologação, concorrência com captura/resume/entrega/escritores remotos, idempotência, rollback da evidência, COMMIT local incerto, perda de sessões, lock timeout e reaplicação da migration. A fixture não prova compatibilidade, privilégios, retenção ou a causa do bloqueio em produção.

Resultado em 2026-11-11: build aprovado, unitários **130/130**, recuperação dirigida **17/17** e Corporate Sync **42/42**. A suíte corporativa completa ficou em **97 aprovados / 8 falhas**; uma cópia limpa do HEAD, compilada e executada separadamente, reproduziu exatamente os mesmos sete subtestes com falha mais o agregado (**80 aprovados / 8 falhas**). As falhas são de histórico e da CLI antiga de homologação. O typecheck global mantém os **17 diagnósticos preexistentes**, com saída completa idêntica à anterior às alterações. `git diff --check` passou. Detalhes em [evidência de validação](../evidence/corporate-collision-recovery.json). A suíte completa e o typecheck global, portanto, não estão integralmente aprovados.
