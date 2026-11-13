# Runbook: readoção do alocador OLOS/MADM

> Documento histórico do contrato v1. Para a candidata v2, seguir [autoridade corporativa v2](authority-v2.md). Os passos de alocação/reversão legacy e materialização durante pausa descritos abaixo não se aplicam à v2. Não combinar os procedimentos.

Somente para execução futura após revisão técnica e aprovação do DBA. Nenhum comando deste runbook foi executado em produção. No `compose.dokploy.yaml` versionado, o processo único de admin/coleta/entrega é o serviço **admin**, com WORKDIR `/app`; o serviço `worker` de `compose.yaml` pertence a outra topologia. Usar o ID exato do container admin da aplicação Dokploy aprovada, sem selecionar um projeto Compose diferente ou criar outro worker. Os endpoints/papéis vinculados permanecem os mesmos. A [decisão técnica](id-allocator-readoption.md) e a [evidência local](../evidence/corporate-id-readoption.json) incluem as limitações atuais da suíte geral/typecheck.

## 1. Pré-condições e ordem de publicação

1. Revisar o diff preservando os trabalhos anteriores, inclusive Corporate Reports v2. Resolver/aceitar formalmente os bloqueios de homologação globais documentados antes de aprovar publicação. Registrar backup e plano de recuperação DBA. Não usar as contagens antigas como condições codificadas.
2. Disponibilizar a versão compatível **no mesmo serviço**, com os mesmos bindings. Esta etapa requer a aprovação de publicação; os comandos abaixo não fazem build/deploy/restart. Código anterior pode rejeitar o novo trigger no startup. Não executar uma CLI nova contra um worker que ainda materializa pelo protocolo antigo.
3. Pausar somente Corporate Delivery. A captura e o scheduler existentes continuam. Confirmar `allocator=legacy`, reversão `completed`, validação persistida e zero admissões anteriores sem materialização. Se a reversão não tiver validação de recuperação persistida, concluir o [procedimento anterior](legacy-reversion.md) com diagnóstico/quarentena/liberação **antes** de instalar a autoridade MADM. Não preencher validação manualmente; `corporate-verify-pending` sozinho não a persiste.
4. Aplicar localmente `010` se ainda ausente e `011`, com privilégios na mesma transação. Migrations `001`–`009` e tabelas de quarentena já devem existir. Não reaplicar `010`: ela é intencionalmente de aplicação única. Se existir preparação antiga da `010` com selos incompletos, diagnosticar/abortar antes de preparar outra; não alterar o ledger manualmente.
5. DBA revisa/aplica **somente no MADM** `migrations/corporate/001_id_allocator.sql`, concede privilégios e homologa os demais escritores. Depois preparar/validar/ativar a nova geração.

A coleta continua podendo usar IDs locais antes do COMMIT da barreira autorizada; as capturas desse intervalo entram no corte histórico. A instalação corporativa sozinha não ativa a autoridade local. Após a barreira, nenhuma falha autoriza retorno automático ao legado.

## 2. Identificação e consultas iniciais

Executar os blocos na mesma sessão Bash administrativa, sem `set -x`, com Docker, Python 3 e `psql` disponíveis. O Node usado nos comandos é o da imagem, sem exigir Node instalado na VPS. As URIs DBA devem ser PostgreSQL **sem senha**, com TLS/CA e endpoint acessível do ambiente onde `psql` será executado. Obter a senha por `PGPASSFILE` privado (modo 0600), não pela URI nem pela linha de comando. Não usar `PGDATABASE="$URI"`: libpq trata esse valor de ambiente como nome literal do banco, sem expandir a URI. `psql --dbname="$URI_SEM_SENHA"` expande corretamente os parâmetros. Não imprimir as URIs, o arquivo de senhas, `docker inspect .Config.Env` ou `docker compose config` resolvido. Não dar `source` no `credentials.env` de formato raw do Dokploy.

Um hostname de serviço Docker, como `postgres`, não é necessariamente resolvível pelo `psql` na VPS. O DBA deve confirmar o caminho de rede e o serviço físico correto; não publicar portas nem alterar bindings para contornar conectividade. A compatibilidade real da configuração Dokploy não foi consultada em produção.

```bash
set -euo pipefail
umask 077
container='SUBSTITUIR_PELO_ID_EXATO_DO_CONTAINER_ADMIN_DOKPLOY_APROVADO'
test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")" = admin
source_key='SUBSTITUIR_PELA_ORIGEM_LITERAL_APROVADA'
evidence_ref='SUBSTITUIR_PELA_REFERENCIA_DA_APROVACAO'
local_worker_role='SUBSTITUIR_PELO_PAPEL_LOCAL_JA_VINCULADO'
corporate_worker_role='SUBSTITUIR_PELO_PAPEL_MADM_JA_VINCULADO'
: "${LOCAL_DBA_DATABASE_URL:?obter URI DBA LOCAL sem senha}"
: "${MADM_DBA_DATABASE_URL:?obter URI DBA MADM sem senha aprovada pelo DBA}"
: "${PGPASSFILE:?arquivo privado aprovado para as duas conexoes DBA}"
test -r "$PGPASSFILE"
test "$(stat -c '%a' "$PGPASSFILE")" = 600
LOCAL_DBA_DATABASE_URL="$LOCAL_DBA_DATABASE_URL" MADM_DBA_DATABASE_URL="$MADM_DBA_DATABASE_URL" \
  python3 - <<'PY'
import os
from urllib.parse import urlsplit, parse_qsl
for key in ('LOCAL_DBA_DATABASE_URL', 'MADM_DBA_DATABASE_URL'):
    try:
        uri = urlsplit(os.environ[key])
    except ValueError:
        raise SystemExit('DBA_URI_INVALID') from None
    if uri.scheme not in ('postgres', 'postgresql'):
        raise SystemExit('DBA_URI_INVALID')
    if uri.password or any(k.lower() == 'password' for k, _ in parse_qsl(uri.query, keep_blank_values=True)):
        raise SystemExit('DBA_URI_PASSWORD_FORBIDDEN')
PY
export PGPASSFILE
docker exec --workdir /app "$container" node --input-type=module -e '
  import {accessSync} from "node:fs";
  for (const p of ["/app/dist/main.js","/app/dist/corporate-delivery/readoption-activation.js",
    "/app/dist/corporate-delivery/readoption-command.js","/app/dist/corporate-delivery/readoption-proof.js",
    "/app/migrations/008_corporate_id_allocator.sql","/app/migrations/010_corporate_allocator_readoption.sql",
    "/app/migrations/011_corporate_readoption_activation.sql","/app/migrations/corporate/001_id_allocator.sql"]) accessSync(p);'

docker exec --workdir /app "$container" node /app/dist/main.js corporate-pause
docker exec --workdir /app "$container" node /app/dist/main.js corporate-status
psql --dbname="$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v worker_role="$local_worker_role" <<'SQL'
BEGIN READ ONLY;
SELECT current_database();
SELECT rolname,rolsuper,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=:'worker_role';
SELECT source_key,state,request_id,binding,target_table FROM olos_http.corporate_id_allocator;
SELECT request_id,adoption_request_id,state,initial_count,materialized_count,batch_count,
       initial_digest,completed_at,validated_at,validation_digest
FROM olos_http.corporate_id_reversions;
SELECT to_regclass('olos_http.corporate_allocator_readoptions') AS migration_010,
       to_regclass('olos_http.corporate_readoption_schema') AS migration_011;
COMMIT;
SQL
```

Conferir a origem literal, binding e UUIDs anteriores. `legacy` sem reversão concluída e validada não permite readoção. Não instalar a autoridade MADM antes de concluir essa recuperação anterior. Não selecionar payloads/tokens para comprovar isso.

## 3. Migrations e privilégios, após aprovação

Se a consulta confirmou ausência da `010`, aplicá-la **uma vez** no banco local:

```bash
psql --dbname="$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f migrations/010_corporate_allocator_readoption.sql
```

Revisar e aplicar `011` e GRANTs na mesma transação para evitar que a coleta veja tabelas novas sem permissão. Este bloco gera um bundle privado local a partir da migration revisada, retirando somente seu COMMIT final e acrescentando privilégios e COMMIT. Não muda o arquivo da migration. O papel local deve conservar os privilégios existentes em `records`, outbox, admissões, assignments, controle, reversão e quarentena.

```bash
recovery_dir="$(mktemp -d /tmp/corporate-readoption.XXXXXX)"
local_bundle="$recovery_dir/local-011-with-grants.sql"
python3 - "$local_bundle" <<'PY'
from pathlib import Path
import sys
sql = Path('migrations/011_corporate_readoption_activation.sql').read_text()
assert sql.rstrip().endswith('COMMIT;')
sql = sql.rstrip()[:-len('COMMIT;')]
grants = '''
GRANT SELECT,INSERT,UPDATE ON olos_http.corporate_allocator_readoptions TO :"worker_role";
GRANT SELECT,INSERT ON olos_http.corporate_readoption_batches TO :"worker_role";
GRANT SELECT ON olos_http.corporate_readoption_schema TO :"worker_role";
GRANT SELECT,INSERT,UPDATE ON olos_http.corporate_allocation_fence TO :"worker_role";
COMMIT;
'''
Path(sys.argv[1]).write_text(sql + grants)
PY
psql --dbname="$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v worker_role="$local_worker_role" -f "$local_bundle"
```

Se já existir `011`, a reaplicação somente é autorizada para o mesmo contrato revisado; schema divergente exige diagnóstico. Timeout/falha reverte a transação. Não aumentar indefinidamente timeouts nem remover guardas para executar a migration.

**Etapa exclusiva do DBA MADM**, em janela aprovada: a migration bloqueia escritores de `raw.olos_calls` durante o bootstrap e instala trigger ALWAYS. Não atualiza chamadas nem sequências. Rever duplicidade já existente de IDs não nulos, capacidade do registry/índices, int32, ownership, versão PostgreSQL e impacto nos escritores. O `reserve()` SECURITY DEFINER usa o owner aprovado das tabelas. O runtime não deve possuir privilégios para modificar o registry/counter diretamente ou desabilitar o trigger. `IF NOT EXISTS` não autoriza reaplicar a migration para reparar um namespace parcial/desconhecido.

Inventariar com o DBA todos os produtores: INSERT, UPDATE, UPSERT, COPY, funções intermediárias e replicação. Um produtor com gerador próprio pode receber `ALLOCATOR_ID_NOT_OWNED` ao tentar consumir um ID reservado; isso protege a integridade, mas exige homologação/adaptação desse produtor. Não há garantia de continuidade de escritores reais que não foram examinados. Confirmar também as permissões do papel local: o Compose inicializa `POSTGRES_USER=olos_app`, o que não comprova os privilégios atuais no volume existente. Ownership/superuser permitem contornar triggers; qualquer ajuste de privilégio/ownership deve ser aprovado pelo DBA, preservando o papel/endpoints vinculados da aplicação.

```bash
psql --dbname="$MADM_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v worker_role="$corporate_worker_role" <<'SQL'
BEGIN READ ONLY;
SELECT current_database();
SELECT rolname,rolsuper,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=:'worker_role';
SELECT relname,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=to_regclass('raw.olos_calls');
SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=to_regclass('raw.olos_calls') AND NOT tgisinternal;
COMMIT;
SQL
```

O teste descartável confirmou que um escritor aberto impede a instalação e produz timeout após 5 s, sem schema parcial nem alteração das chamadas; a repetição após liberar o escritor instala normalmente. Isso não dimensiona a janela necessária para milhões de linhas. A espera por lock é limitada a 5 s, cada statement a 60 s; transações de outros produtores podem sofrer espera durante o bootstrap inteiro. O DBA deve monitorar locks e aprovar a janela, sem aumentar limites indiscriminadamente. [Semântica dos locks PostgreSQL 16](https://www.postgresql.org/docs/16/explicit-locking.html).

```bash
# Somente o DBA, após aprovação específica da migration corporativa:
psql --dbname="$MADM_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f migrations/corporate/001_id_allocator.sql
psql --dbname="$MADM_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v worker_role="$corporate_worker_role" <<'SQL'
BEGIN;
GRANT USAGE ON SCHEMA olos_delivery_ids TO :"worker_role";
GRANT EXECUTE ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) TO :"worker_role";
COMMIT;
SQL
```

Conservar os privilégios corporativos existentes de SELECT/INSERT e sequences necessários ao INSERT original. A validação recusa contrato ou privilégios incompatíveis. Não trocar o papel MADM configurado na aplicação: ele participa do binding e da identidade das reservas. Não conceder DML direto no registry/counter ao runtime. Um timeout do bootstrap exige revisão pelo DBA; não deixar instalação parcial.

## 4. Preparar, consultar e validar

Gerar **uma única vez** o UUID e salvá-lo antes da primeira tentativa. Em perda de sessão, recuperar o UUID do arquivo/evidência; não executar novamente a geração abaixo para contornar resultado incerto.

```bash
request_id="$(docker exec --workdir /app "$container" node --input-type=module -e \
  'import {randomUUID} from "node:crypto"; process.stdout.write(randomUUID())')"
printf 'source=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$request_id" "$evidence_ref" > "$recovery_dir/operation.txt"
base_args=(--confirm-source "$source_key" --request-id "$request_id" --evidence "$evidence_ref")
query_args=(--confirm-source "$source_key" --request-id "$request_id")

docker exec --workdir /app -e OLOS_CORPORATE_READOPTION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION \
  "$container" node /app/dist/main.js corporate-prepare-id-readoption "${base_args[@]}"
docker exec --workdir /app "$container" node /app/dist/main.js corporate-id-readoption-status "${query_args[@]}"
docker exec --workdir /app -e OLOS_CORPORATE_READOPTION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION \
  "$container" node /app/dist/main.js corporate-validate-id-readoption "${base_args[@]}" \
  > "$recovery_dir/validation.jsonl"
cat "$recovery_dir/validation.jsonl"
docker exec --workdir /app "$container" node /app/dist/main.js corporate-id-readoption-evidence "${query_args[@]}"
```

Exigir `state=ready` e conferir `previous_adoption_id`, `previous_reversion_id`, hashes de contrato/predecessor e origem. Consultas de status/evidência são READ ONLY locais, não chamam MADM e não reservam IDs. A validação consulta MADM em transação READ ONLY. `ready` não significa alocador ativo. Repetir preparação/validação com os mesmos argumentos é idempotente.

Copiar o `validation_digest` exato emitido pela validação/status, após revisão:

```bash
validation_digest='SUBSTITUIR_PELO_SHA256_VALIDADO_DESTA_SOLICITACAO'
printf 'validation=%s\n' "$validation_digest" >> "$recovery_dir/operation.txt"
activation_args=("${base_args[@]}" --validation "$validation_digest" --max-batches 10)
```

## 5. Ativar a barreira e registrar o histórico em lotes

Esta invocação tem autorização própria: confirma a barreira e faz reservas no MADM. O limite é de lotes por invocação, não altera o UUID nem o tamanho de lote já configurado no worker. A ativação pode terminar em `READOPTION_ACTIVATION_INCOMPLETE` com exit 1 e progresso persistido. Não usar um loop que ignore indiscriminadamente exit codes.

```bash
docker exec --workdir /app \
  -e OLOS_CORPORATE_READOPTION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION \
  -e OLOS_CORPORATE_READOPTION_ACTIVATION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION_ACTIVATION \
  "$container" node /app/dist/main.js corporate-activate-id-readoption "${activation_args[@]}"
```

Após cada invocação ou falha, consultar, sem alteração de estado:

```bash
docker exec --workdir /app "$container" node /app/dist/main.js corporate-id-readoption-status "${query_args[@]}"
docker exec --workdir /app "$container" node /app/dist/main.js corporate-id-readoption-evidence "${query_args[@]}"
docker exec --workdir /app "$container" node /app/dist/main.js corporate-status
```

Em `activating`, conferir `authority_required=true`, `authority_generation` igual ao UUID, `barrier_at`, cursor, contagens e último erro. Novas chamadas permanecem em admissões e não recebem IDs locais. Prosseguir por lotes, com a mesma identidade e digest, após resolver qualquer impedimento:

```bash
docker exec --workdir /app \
  -e OLOS_CORPORATE_READOPTION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION \
  -e OLOS_CORPORATE_READOPTION_ACTIVATION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION_ACTIVATION \
  "$container" node /app/dist/main.js corporate-reconcile-id-readoption "${activation_args[@]}"
```

Repetir essa mesma invocação de reconciliação até comprovar `state=active`, `completed=true`, cursor igual ao corte e `activated_at` persistido. Confirmar novamente por status/evidência; ausência de exceção sozinha não comprova a transição. A evidência é incremental: um histórico grande exige várias invocações. O worker não conclui automaticamente uma ativação administrativa interrompida; continua preservando admissões.

## 6. Colisões históricas durante a ativação

`INTERNAL_ID_COLLISION` pode referir-se a um ID histórico já atribuído. O lote remoto/local falha sem remapear nem alterar chamadas MADM e conserva checkpoints anteriores. A operação marca o bloqueio, permitindo usar a quarentena seletiva com vínculo à geração.

```bash
diagnostic_file="$recovery_dir/pending-before-quarantine.jsonl"
if docker exec --workdir /app "$container" node /app/dist/main.js corporate-verify-pending > "$diagnostic_file"; then
  diagnostic_exit=0
else
  diagnostic_exit=$?
fi
cat "$diagnostic_file"
printf 'diagnostic_exit=%s\n' "$diagnostic_exit"
```

Somente se o diagnóstico completo terminou em `CORPORATE_PENDING_DIVERGES`, revisar IDs/campos e copiar seu digest. Ausência de autoridade, timeout, erro de schema, hash, identidade lógica noutro ID ou conexão não autoriza quarentena. A operação existente isola somente colisões confirmadas; a readoção exige integridade dos demais casos. Não remover/adulterar quarentenas existentes.

```bash
quarantine_digest='SUBSTITUIR_PELO_DIGEST_REVISADO_DO_DIAGNOSTICO'
quarantine_request="$(docker exec --workdir /app "$container" node --input-type=module -e \
  'import {randomUUID} from "node:crypto"; process.stdout.write(randomUUID())')"
printf 'request_id=%s\nverification=%s\n' "$quarantine_request" "$quarantine_digest" \
  > "$recovery_dir/quarantine-operation.txt"
docker exec --workdir /app \
  -e OLOS_CORPORATE_QUARANTINE_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_QUARANTINE \
  "$container" node /app/dist/main.js corporate-quarantine-collisions \
  --confirm-source "$source_key" --verification "$quarantine_digest" \
  --request-id "$quarantine_request" --evidence "$evidence_ref"
```

Gerar o UUID de quarentena uma vez; em COMMIT incerto conservar seus parâmetros e consultar/repetir a mesma operação, conforme o [runbook seletivo](selective-collision-recovery.md). Seu UUID é distinto da geração de readoção. Refazer diagnóstico, consultar evidência da geração e então continuar `corporate-reconcile-id-readoption` com o UUID original de readoção. A quarentena mantém `pending`; não marca `confirmed`/`skipped`. `corporate-recover-collision` é recusado durante `activating`.

## 7. Verificar e retomar a entrega após `active`

`active` indica a autoridade formal, não disponibilidade atual do MADM. O materializador do worker passa a reservar IDs e escoar admissões por lote mesmo com a entrega pausada, conforme as autorizações de escrita configuradas. Conferir nos eventos `corporate_id_reservation_completed`/`corporate_id_materialization_completed`, no status e no ledger que a fila progride; não comparar com uma contagem antiga fixa. Confirmar `allocator=active`, geração correta, quarentenas preservadas e ausência de novos erros de integridade.

```bash
docker exec --workdir /app "$container" node /app/dist/main.js corporate-id-readoption-status "${query_args[@]}"
docker exec --workdir /app "$container" node /app/dist/main.js corporate-status
docker exec --workdir /app "$container" node /app/dist/main.js corporate-verify-pending \
  > "$recovery_dir/pending-after-active.jsonl"
cat "$recovery_dir/pending-after-active.jsonl"
```

Exigir `valid=true`. Se houver colisão confirmada adicional, repetir o diagnóstico e isolamento seletivo aprovado; não ignorar outro erro. Se `blocked=true` com `INTERNAL_ID_COLLISION`, usar o digest novo válido para liberar administrativamente, mantendo a pausa:

```bash
release_digest='SUBSTITUIR_PELO_DIGEST_VALIDO_ATUAL_DO_RESTANTE'
release_request="$(docker exec --workdir /app "$container" node --input-type=module -e \
  'import {randomUUID} from "node:crypto"; process.stdout.write(randomUUID())')"
printf 'request_id=%s\nverification=%s\n' "$release_request" "$release_digest" \
  > "$recovery_dir/release-operation.txt"
docker exec --workdir /app \
  -e OLOS_CORPORATE_RECOVERY_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_RECOVERY \
  "$container" node /app/dist/main.js corporate-recover-collision \
  --confirm-source "$source_key" --verification "$release_digest" \
  --request-id "$release_request" --evidence "$evidence_ref"
docker exec --workdir /app "$container" node /app/dist/main.js corporate-status
```

Pular somente esse bloco de liberação se o controle já estiver sem bloqueio. Outro código de bloqueio exige sua própria reconciliação. `CORPORATE_VERIFICATION_STALE` exige diagnóstico/digest atuais revisados; a captura/materialização concorrente pode mudar as pendências. Não substituir o UUID de uma liberação incerta.

Somente após `active`, verificação válida, bloqueio resolvido e autorização de escrita já configurada no **worker existente** (`OLOS_CORPORATE_WRITE_ENABLED=true` e `OLOS_CORPORATE_WRITE_CONFIRMATION=AUTHORIZE_EXPORTDATA_DIRECT_DELIVERY`), executar a retomada aprovada:

```bash
docker exec --workdir /app "$container" node /app/dist/main.js corporate-resume
docker exec --workdir /app "$container" node /app/dist/main.js corporate-status
docker logs --since 5m --tail 100 "$container"
```

O ciclo existente entrega os lotes e confirma recibos. Não iniciar outro worker, não executar `corporate-deliver-once` ao lado do owner OLOS, nem alterar filtros de operador/campanha. Revisar logs no canal aprovado; não publicar logs operacionais brutos. A recuperação pode ser validada adicionalmente por SELECTs de contagens/IDs/hashes nos ledgers, sem selecionar payloads ou tokens.

## 8. Recuperação de incidentes e rollback

| Resultado observado por UUID | Ação permitida |
| --- | --- |
| Ausente após preparação incerta | Repetir preparação com **o mesmo UUID e argumentos**. |
| `prepared` / `validating` | Repetir validação; autoridade ausente/incompatível mantém legado e pausa. |
| `ready` após ativação incerta | Barreira não consta persistida. `reconcile` não a inicia; revisar e executar `activate` explicitamente com o mesmo UUID/digest. |
| `activating`, checkpoint anterior | Repetir reconciliação; reservas remotas sem confirmação local são recuperadas idempotentemente. |
| `activating`, checkpoint avançado | COMMIT do lote ocorreu. Continuar a partir dele com a mesma operação. |
| `active` | Repetição é idempotente. Conferir controle/evidência e tratar a entrega separadamente. Não trocar UUID. |
| `READOPTION_BUSY` | Outra operação possui o lock; consultar seu estado e aguardar conclusão. Não forçar unlock de outra sessão. |
| Contrato/evidência/hash/binding alterado | Manter pausa/barreira, diagnosticar a divergência com DBA; não atualizar selos manualmente. |
| Outage MADM / timeout / int32 esgotado | Conservar admissões e reservas; restaurar a condição externa e repetir o mesmo protocolo. Sem fallback nem ajuste de sequência. |

Antes da barreira pode-se abortar a solicitação com autorização base, mantendo todas as evidências:

```bash
# Usar somente se status comprovar prepared, validating ou ready, após revisão:
docker exec --workdir /app -e OLOS_CORPORATE_READOPTION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION \
  "$container" node /app/dist/main.js corporate-abort-id-readoption "${base_args[@]}"
```

Após a barreira **não existe rollback para autoridade legada**. Rollback operacional é `corporate-pause`, preservação das filas/ledgers e correção para frente com binário compatível. Um rollback de binário anterior ou remoção de migrations exige outro plano validado pelo DBA e está fora deste procedimento. Não desligar `required`, alterar geração, apagar registry, remover triggers, limpar quarentenas ou reajustar sequência. O bloqueio deliberado de binários antigos protege a integridade; não deve ser contornado.

O conjunto sintético local comprova os cenários exercitados, mas não aprovação de implantação: a suíte global/typecheck têm falhas preexistentes documentadas, o contrato/privilegios reais e capacidade devem ser homologados e o DBA precisa aprovar a migration corporativa. Nenhuma dessas validações remotas foi realizada nesta implementação.
