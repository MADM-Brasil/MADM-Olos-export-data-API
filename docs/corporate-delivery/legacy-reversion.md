# Reversão administrativa da preparação do alocador

> Documento histórico do contrato v1. Para a candidata v2, seguir [autoridade corporativa v2](authority-v2.md). Os passos de alocação/reversão legacy e materialização durante pausa descritos abaixo não se aplicam à v2. Não combinar os procedimentos.

Procedimento emergencial para `allocator=adopting`, `paused=true`, `blocked=true`, `last_code=INTERNAL_ID_COLLISION`, **sem alocador corporativo instalado**. Não é um rollback de um alocador já ativo. Nenhum comando deste documento foi executado em produção nesta implementação.

O estado informado foi 12.270 admissões sem ID, 371 pendentes, 221 quarentenados e 54.390 confirmados. Esses números não foram consultados; novas capturas podem aumentar a fila antes/durante a recuperação. O manifesto inicial e os lotes persistidos registram o conjunto realmente encontrado.

## O que o comando faz

`corporate-revert-id-allocator` exige autorização própria, origem literal, UUID da preparação original, UUID novo para a reversão e referência de aprovação. Verifica binding, pausa, bloqueio de colisão, integridade das admissões/quarentena, sequência local, ausência de atribuições autoritativas e ausência do namespace/trigger do alocador no MADM. O acesso remoto dessa operação é **READ ONLY**; nenhuma reserva ou DML/DDL corporativo é executado. Conexão/schema inconclusivos, alocador ativo, vestígios de instalação remota ou atribuições existentes impedem a reversão.

A migration local `009` mantém todas as tabelas e o trigger da `008`. Acrescenta os modos `reverting`/`legacy` e as evidências `corporate_id_reversions`/`corporate_id_reversion_batches`. Não remove triggers, modifica chamadas ou altera sequências. Os controles são modificados somente pelo comando autorizado, nunca por SQL manual de recuperação.

A preparação original é preservada com o mesmo request ID, binding e referência. O comando registra seu manifesto de source IDs, hashes e request IDs de admissão, desarma de forma controlada a exigência de reserva e entra em `reverting`. Nesse modo a coleta continua admitindo dados na fila sem ID, e a entrega continua impedida de transmitir. Uma tentativa de retomar a adoção antiga é recusada.

A materialização usa a mesma admissão legada: `nextval()` da sequência descoberta pelo catálogo, normalização/freeze, `records`, outbox e filtros de operador/campanha existentes. Só então altera `materialized=false` para `true`; conserva `mapped`, hashes e request IDs das admissões. O checkpoint, o vínculo source ID -> target ID e a evidência de cada lote são confirmados na mesma transação. IDs e payloads já persistidos são reconhecidos e comparados, sem substituição. Confirmados, recibos, quarentena e dados corporativos existentes não são reescritos.

A exclusão mútua usa o fence de admissão `(17320914,5)`, o de materialização `(17320914,6)`, a linha de controle e a exclusão de homologação. Os locks de escrita são liberados entre lotes, permitindo novas persistências da coleta; o comando não assume seu lock de ownership nem cria outro worker. Um lock de sessão `(17320914,7)` impede dois comandos de reversão concorrentes. Falhas/COMMIT incerto mantêm os lotes confirmados e a entrega pausada. A mesma requisição retoma do checkpoint; uma requisição concluída retorna `already_applied=true`, sem pausar novamente uma entrega que já foi retomada.

Ao esvaziar a fila e conferir o manifesto inicial, passa para `legacy`, com `unallocated=0`, mantendo `paused=true`, o bloqueio e o código originais. Novas capturas passam diretamente pela admissão legada. `resume()` exige também a validação persistida por `corporate-recover-collision`; somente executar o diagnóstico read-only não libera a entrega. A quarentena seletiva continua excluindo somente membros formalmente isolados.

**Limite deliberado:** voltar ao fluxo legado restaura o uso da sequência local, cuja faixa pode colidir com MADM. Esta operação não promete exclusividade global. As colisões continuam sendo diagnosticadas, bloqueadas e isoladas pelo procedimento seletivo, sem sobrescrever o destino. Não há `setval`, offset, alteração manual de sequência ou tentativa de corrigir IDs existentes. Rollbacks podem consumir números de sequência e deixar lacunas normais, sem duplicar registros confirmados.

## Prova da sequência local sem usar o maior ID histórico

A validação anterior comparava `last_value` com `MAX(records.target_id)`. Essa comparação foi removida da reversão: `records` não contém uma coluna que certifique qual gerador atribuiu cada ID. `source_id`, a contagem de linhas e `outbox.origin` tampouco provam essa origem. Nenhum registro é classificado como externo apenas por ser alto, nem ignorado com base nessa suposição.

A prova agora separa o **cursor real da sequência** da **ocupação histórica**:

- Lê a sequência vinculada à coluna pelo catálogo, `is_called`, incremento, limites, cache e ciclo. Exige incremento positivo, ausência de ciclo e `cache=1`, para demonstrar a faixa ainda necessária. Outra configuração mantém o bloqueio, sem alteração automática da sequência.
- Conta somente admissões não materializadas que ainda não têm mapeamento em `records`. Calcula a progressão a partir do próximo valor real; não usa MAX, contagem de registros históricos, offset ou renumeração.
- Exige unicidade imediata válida em `records(target_table,target_id)`, outbox e PK da tabela local, com dados visíveis sem RLS. Estabiliza as tabelas locais por transação, inclusive recibos antigos quando presentes. A exclusão de escritores usa `SHARE ROW EXCLUSIVE`; os privilégios necessários são os definidos pelo [PostgreSQL 16 para LOCK](https://www.postgresql.org/docs/16/sql-lock.html). Não há GRANT automático.
- Procura qualquer ID dessa progressão já ocupado em `records` para a tabela vinculada, outbox, destino local ou recibos antigos. Um ID acima da faixa não interfere na prova atual; um ID dentro dela impede a reversão antes de materializar.
- Em cada alocação legada, confere também o valor **efetivamente retornado por `nextval()`**, sob os locks e constraints. Isso protege contra divergências de uma previsão anterior e também vale para novas capturas após a reversão. Não pula IDs ocupados nem reescreve seus titulares.

Na evidência informada, `last_value=2.117.157`, `is_called=true` e incremento 1 dariam a faixa **2.117.158–2.129.427** para 12.270 novos mapeamentos, se todos ainda precisarem de ID. A presença de 11.618 IDs históricos acima da sequência e do máximo 47.561.749, isoladamente, não informa se essa faixa está livre. O comando verifica a ocupação real antes de autorizar sua utilização. Novas admissões entre lotes são incluídas nas verificações seguintes.

`corporate_legacy_sequence_verified` registra limites/quantidade necessária. `corporate_legacy_sequence_unsafe` informa a condição impeditiva, sem payloads ou dados pessoais:

| `reason` | Condição que conserva o bloqueio |
| --- | --- |
| `LOCAL_TARGET_ID_OCCUPIED` | Candidato ocupado; log inclui `target_id`, `scope` e, no preflight, limites da faixa. |
| `LOCAL_ID_UNIQUENESS_NOT_PROVEN` | Constraint/index de unicidade ausente, inválido ou diferível. |
| `LOCAL_ID_SPACE_NOT_VISIBLE` | Relação inesperada ou RLS impede a prova integral de ocupação. |
| `LOCAL_ID_LOCK_PRIVILEGE_REQUIRED` | A conexão não pode excluir os escritores locais durante a prova. |
| `LEGACY_RECEIPTS_MISSING` | Controle conserva confirmações legadas, mas sua tabela de recibos está ausente. |
| `SEQUENCE_METADATA_UNSUPPORTED` | Metadados ausentes, incremento não positivo ou ciclo habilitado. |
| `SEQUENCE_CACHE_NOT_ONE` | Cache diferente de 1 impede usar `last_value` como previsão segura para esta rotina. |
| `SEQUENCE_CAPACITY_NOT_PROVEN` | Próximos candidatos fora dos limites do gerador ou do inteiro positivo de 32 bits. |

O erro de saída permanece `ALLOCATOR_LEGACY_SEQUENCE_UNSAFE`. No preflight, falha não consome IDs nem altera a preparação. Falha posterior conserva os checkpoints já confirmados e as admissões restantes. As comparações no MADM, a pausa, a liberação explícita e a quarentena seletiva continuam obrigatórias: esta prova é de disponibilidade **local**, não de exclusividade corporativa.

Não é necessária migration nova. Após disponibilização autorizada da correção no mesmo worker, repetir o comando com os parâmetros/UUID de reversão preservados. Se a nova prova encontrar uma condição impeditiva, manter o bloqueio e reconciliar a causa; não usar `setval`, offsets, reinicialização ou remoção de constraints.

## Comandos exatos para a VPS, após aprovação

Pré-requisito: esta versão já em execução no **mesmo worker**, migrations locais `001`–`008` presentes. Não basta executar uma CLI nova ao lado de um worker com o código antigo: ele não conhece o modo `legacy` da reversão. A disponibilização da versão é uma etapa externa, separadamente autorizada; os comandos abaixo não fazem deploy/restart. Não instalar a migration corporativa de reservas.

Executar no projeto Compose efetivamente usado na VPS, ou preencher `container` com o ID exato aprovado. Usar somente a conexão DBA **local** para a migration/grants. O comando acessa MADM com as credenciais já configuradas do worker, apenas para leitura de preflight.

```bash
set -euo pipefail
umask 077
container="$(docker compose ps -q worker)"
test -n "$container"
source_key='SUBSTITUIR_PELA_ORIGEM_LITERAL_APROVADA'
evidence_ref='SUBSTITUIR_PELA_REFERENCIA_DA_APROVACAO'
local_worker_role='SUBSTITUIR_PELO_PAPEL_LOCAL_EXISTENTE_DO_WORKER'
: "${LOCAL_DBA_DATABASE_URL:?defina a conexao DBA LOCAL aprovada}"

docker exec "$container" node dist/main.js corporate-status

# Copiar allocator_request_id do status, referente à preparação atual em adopting.
adoption_request='SUBSTITUIR_PELO_UUID_DA_PREPARACAO_ATUAL'

psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f migrations/009_corporate_allocator_reversion.sql
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v worker_role="$local_worker_role" <<'SQL'
GRANT SELECT,INSERT,UPDATE ON olos_http.corporate_id_reversions TO :"worker_role";
GRANT SELECT,INSERT ON olos_http.corporate_id_reversion_batches TO :"worker_role";
SQL

# Gerar UMA VEZ; guardar antes da tentativa. Não gerar outro UUID em caso de queda.
reversion_request="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
reversion_file="$(mktemp /tmp/corporate-legacy-reversion.XXXXXX)"
printf 'source=%s\nadoption_request=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$adoption_request" "$reversion_request" "$evidence_ref" > "$reversion_file"
cat "$reversion_file"
reversion_args=(--confirm-source "$source_key" --adoption-request "$adoption_request" \
  --request-id "$reversion_request" --evidence "$evidence_ref")
```

Executar a reversão. Em `ALLOCATOR_REVERSION_COMMIT_UNKNOWN`, interrupção da sessão ou `ALLOCATOR_REVERSION_INCOMPLETE`, repetir **somente esta invocação**, com os mesmos parâmetros preservados. `--max-batches N` é opcional (1–10000; padrão 1000), limita o trabalho por invocação e não muda a identidade da recuperação. Outro processo simultâneo recebe `ALLOCATOR_REVERSION_BUSY` e não altera dados.

```bash
docker exec \
  -e OLOS_CORPORATE_LEGACY_REVERSION_CONFIRMATION=AUTHORIZE_CORPORATE_LEGACY_REVERSION \
  "$container" node dist/main.js corporate-revert-id-allocator "${reversion_args[@]}"

docker exec "$container" node dist/main.js corporate-status
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v request_id="$reversion_request" <<'SQL'
BEGIN READ ONLY;
SELECT request_id, adoption_request_id, state, initial_count, materialized_count, batch_count,
       previous_allocator_state, previous_id_allocator_required,
       previous_confirmed_count, initial_digest, created_at, completed_at, validated_at, validation_digest
FROM olos_http.corporate_id_reversions WHERE request_id=:'request_id'::uuid;
SELECT batch_no, member_count, created_at
FROM olos_http.corporate_id_reversion_batches WHERE request_id=:'request_id'::uuid ORDER BY batch_no;
COMMIT;
SQL
```

Esperado: evento `corporate_legacy_reversion_recorded` com `completed=true`; ledger `completed`; `allocator=legacy`, `unallocated=0`, **`paused=true`** e bloqueio original conservado. Os 54.390 confirmados e as 221 quarentenas informadas devem permanecer iguais ao snapshot inicial real. `materialized_count` pode superar `initial_count` por novas capturas que entraram durante a operação. Pendentes/skipped podem crescer conforme os filtros originais; materialização não é confirmação corporativa.

Se aparecer `ALLOCATOR_REVERSION_REMOTE_PRESENT`, `ALLOCATOR_REVERSION_ASSIGNMENTS_EXIST`, divergência de hashes/mapeamento ou sequência insegura, manter o bloqueio. Não apagar provas, instalar/remover objetos remotos ou alterar controles/seqüência para contornar o erro.

### Validar e isolar colisões, mantendo a pausa

O diagnóstico pode retornar exit code 1 enquanto existem colisões. Guardar o resultado e revisar os códigos/IDs/campos. Usar digest de uma execução que concluiu com `CORPORATE_PENDING_DIVERGES`, jamais de falha de conexão/schema. O domínio de digest é `corporate-pending-verification-v4-legacy`; não reutilizar digests v3 da fase de adoção.

```bash
diagnostic_file="$(mktemp /tmp/corporate-legacy-pending.XXXXXX)"
if docker exec "$container" node dist/main.js corporate-verify-pending > "$diagnostic_file"; then
  diagnostic_exit=0
else
  diagnostic_exit=$?
fi
cat "$diagnostic_file"
printf 'diagnostic_exit=%s\n' "$diagnostic_exit"
```

Se houver colisões `INTERNAL_ID_COLLISION` comprovadas fora da quarentena, revisar/aprovar seu isolamento e executar o comando existente abaixo. Se `valid=true` sem divergências, pular esta etapa de quarentena. Outras divergências não são ignoradas pelo procedimento.

```bash
quarantine_digest='SUBSTITUIR_PELO_DIGEST_DO_DIAGNOSTICO_REVISADO'
quarantine_request="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
quarantine_file="$(mktemp /tmp/corporate-legacy-quarantine.XXXXXX)"
printf 'source=%s\nverification=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$quarantine_digest" "$quarantine_request" "$evidence_ref" > "$quarantine_file"
docker exec \
  -e OLOS_CORPORATE_QUARANTINE_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_QUARANTINE \
  "$container" node dist/main.js corporate-quarantine-collisions \
  --confirm-source "$source_key" --verification "$quarantine_digest" \
  --request-id "$quarantine_request" --evidence "$evidence_ref"
```

### Liberar somente após validação do restante

```bash
remaining_file="$(mktemp /tmp/corporate-legacy-valid.XXXXXX)"
docker exec "$container" node dist/main.js corporate-verify-pending > "$remaining_file"
cat "$remaining_file"
```

Prosseguir somente com exit code zero, `valid=true`, zero divergências e `unallocated=0`. Copiar o digest aprovado desta última execução. Se a coleta alterou a fila entre as etapas, `CORPORATE_VERIFICATION_STALE` requer diagnóstico/revisão novos. Não trocar de requisição para contornar COMMIT incerto: consultar a evidência e repetir o mesmo UUID/digest/referência.

```bash
release_digest='SUBSTITUIR_PELO_DIGEST_VALIDO_APROVADO'
release_request="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
release_file="$(mktemp /tmp/corporate-legacy-release.XXXXXX)"
printf 'source=%s\nverification=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$release_digest" "$release_request" "$evidence_ref" > "$release_file"
docker exec \
  -e OLOS_CORPORATE_RECOVERY_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_RECOVERY \
  "$container" node dist/main.js corporate-recover-collision \
  --confirm-source "$source_key" --verification "$release_digest" \
  --request-id "$release_request" --evidence "$evidence_ref"

docker exec "$container" node dist/main.js corporate-status
```

Conferir liberação auditada, `blocked=false`, `paused=true` e `validated_at`/`validation_digest` persistidos no ledger da reversão. Somente então, com a retomada aprovada:

```bash
docker exec "$container" node dist/main.js corporate-resume
docker exec "$container" node dist/main.js corporate-status
docker logs --since 5m --tail 100 "$container"
```

O mesmo ciclo existente executará os INSERTs legados, excluindo a quarentena e preservando as comparações de integridade. Não iniciar outro worker nem executar `corporate-deliver-once`. Uma nova colisão pode bloquear novamente; tratar pelo mesmo isolamento seletivo, sem sobrescrever MADM. `docker exec "$container" node dist/main.js corporate-pause` continua sendo a pausa exclusiva da entrega.


## Validação local

Correção da prova da sequência: build aprovado; `npm test` **133/133**; suíte de recuperação/alocação **66/66** (65 subtestes e agregado). A suíte completa teve **146 aprovados / 8 falhas**. O HEAD limpo `8c18c99`, compilado e executado separadamente, reproduziu as mesmas sete falhas antigas de histórico/homologação mais o agregado (**136 aprovados / 8 falhas**). O typecheck mantém os **17 diagnósticos preexistentes**, com saída integral idêntica à do HEAD limpo via `cmp`; `git diff --check` passou. A suíte global e o typecheck não estão integralmente aprovados.

As dez novas provas incluem histórico acima da sequência, preservação de um ID 47.561.749 e da quarentena, colisões em records/outbox/destino local/recibos, conferência do valor real de nextval, sequência ainda não chamada, falta de privilégio/constraint, interrupção/reinício, retomada idempotente e escritor SQL concorrente. [Evidência desta correção](../evidence/corporate-legacy-sequence-validation.json). A [evidência inicial da reversão](../evidence/corporate-legacy-reversion.json) permanece preservada.

Todos os testes usam PostgreSQL descartável com TLS verificado e fixtures menores. Não houve execução sobre as 12.270 admissões produtivas nem benchmark do volume real.
