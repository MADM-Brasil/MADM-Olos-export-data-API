# Recuperação seletiva de colisões OLOS/MADM

Procedimento para executar somente após aprovação, com o mesmo worker já usando esta versão da seleção e com as migrations locais `006` e `007` aplicadas. Não basta atualizar apenas o arquivo da CLI se o processo de entrega ainda usa uma versão anterior. Nenhum acesso à produção, deploy, commit ou push foi realizado nesta implementação.

O contexto informado foi 479 pendentes, 183 divergências, 54.090 confirmados, entrega bloqueada por `INTERNAL_ID_COLLISION` e coleta ativa. As contagens não foram consultadas em produção. Uma divergência do diagnóstico não equivale necessariamente a uma chamada isolável: a operação reclassifica os casos, sem assumir que existem exatamente 183 IDs distintos com colisões confirmadas.

## Comportamento e limites

O novo `corporate-quarantine-collisions` reutiliza o diagnóstico, autorização por origem, locks e transação administrativa existentes. Aceita somente linhas cujo diagnóstico completo contém colisões `INTERNAL_ID_COLLISION`, com IDs corporativos e campos de identidade divergentes. Uma linha com hash/mapeamento inválido, normalização inválida, duplicidade local, identidade lógica em outro ID ou divergência apenas de conteúdo não é isolada por esse comando. Se existem colisões qualificadas e outros erros em linhas diferentes, ele isola apenas as colisões e conserva os demais erros para impedir a liberação.

A quarentena usa `olos_http.corporate_collision_quarantine_runs` e `olos_http.corporate_collision_quarantine`, contendo aprovação, origem/binding, IDs, hashes originais, campos divergentes, IDs corporativos, geração e prova do diagnóstico. Não copia valores pessoais para a evidência. Os payloads originais permanecem na outbox; seu estado continua **pending**, sem recibo, sem `confirmed` e sem `skipped`. FKs preservam os vínculos e triggers recusam UPDATE, DELETE e TRUNCATE dos novos registros de auditoria. Não existe comando de remoção automática da quarentena.

A seleção normal e a homologação excluem, antes do LIMIT, somente as identidades locais formalmente isoladas. Os filtros de operador e campanha permanecem os mesmos. Antes de entregar, o código verifica que a quarentena continua ligada aos mesmos IDs, hashes, payloads e `records`; divergência bloqueia a entrega sem interromper a admissão de novas capturas. A ausência da migration `007` também bloqueia a entrega. Revisar permissões locais de SELECT/INSERT nas tabelas novas; o código não faz GRANT automático.

`corporate-verify-pending` continua **READ ONLY nos dois bancos**. Agora verifica a integridade local da quarentena e compara **todos os pendentes não isolados**, inclusive inelegíveis, contra MADM: schema/funções, hashes, IDs, mapeamento e identidade lógica. `pending` inclui a quarentena, `quarantined` informa os isolados e `eligible` conta somente os demais admitidos pelos filtros existentes. `valid=true` significa ausência de divergências entre os não isolados e integridade local da quarentena; não significa que os isolados foram corrigidos.

O digest usa domínio `corporate-pending-verification-v2` e inclui a associação formal de quarentena. Gerar diagnóstico novo nesta versão; não reutilizar um digest anterior à atualização. Evidências e digests antigos da migration `006` não são reescritos.

A operação de quarentena mantém `blocked=true` e o código original; incrementa apenas a geração administrativa. Revalida o restante ainda sob os mesmos locks e informa o resultado. O evento `corporate_collision_quarantine_member_prepared` é uma preparação, e não prova de COMMIT; somente `corporate_collision_quarantine_recorded` ou a consulta da evidência confirma persistência. O `corporate-recover-collision` existente libera somente após revalidar todo o restante e sempre mantém `paused=true`. O `corporate-resume` continua separado e exige a autorização normal de escrita.

Ambas as operações usam lock da linha de controle, exclusão de homologação, SHARE nas tabelas locais e SHARE em `madm.raw.olos_calls`, mantido até o COMMIT local. Podem causar espera breve na persistência da coleta e nos escritores corporativos; não param/reprogramam a coleta, não assumem ownership OLOS e não criam outro worker. A conexão corporativa precisa ter autorização para o lock SHARE. A transação remota convencional executa apenas consultas/lock e termina em ROLLBACK; não executa DML/DDL no MADM. Não há alteração de sequência de IDs.

Uma colisão nova durante a entrega continua acionando a proteção original: rollback remoto, bloqueio persistente e conservação de todo o lote em pending. Não há quarentena automática, descarte ou alteração de registros corporativos existentes. Para novo isolamento é necessário novo diagnóstico e nova autorização. Uma divergência posterior aos locks continua sujeita à validação normal de cada lote; não há promessa de atomicidade distribuída.

## Comandos para a VPS

Executar no diretório do projeto Compose efetivamente utilizado. Se o serviço for gerenciado fora desse projeto, informar o ID exato do container aprovado em `container`. As variáveis abaixo são parâmetros da recuperação, não mudanças permanentes no Environment. A aplicação da versão é pré-requisito externo; este procedimento não faz deploy.

```bash
set -euo pipefail
umask 077
container="$(docker compose ps -q worker)"
test -n "$container"
source_key='SUBSTITUIR_PELA_ORIGEM_LITERAL_APROVADA'
evidence_ref='SUBSTITUIR_PELA_REFERENCIA_DA_APROVACAO'

# Conexão DBA LOCAL previamente aprovada; nunca a conexão MADM.
: "${LOCAL_DBA_DATABASE_URL:?defina a conexao DBA LOCAL aprovada}"
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f migrations/007_corporate_collision_quarantine.sql

docker exec "$container" node dist/main.js corporate-status

# Antes da quarentena, divergências e exit code 1 são esperados.
# Capturar e revisar; não ignorar erros de conexão/schema ou outros códigos.
diagnostic_file="$(mktemp /tmp/corporate-selective-before.XXXXXX)"
if docker exec "$container" node dist/main.js corporate-verify-pending > "$diagnostic_file"; then
  diagnostic_exit=0
else
  diagnostic_exit=$?
fi
cat "$diagnostic_file"
printf 'diagnostic_exit=%s\n' "$diagnostic_exit"
```

Revisar os IDs/campos/códigos. Para a quarentena, copiar o digest da linha final `corporate_pending_verified` desta execução, mesmo que `valid=false`, **somente se a execução concluiu o diagnóstico e terminou com `CORPORATE_PENDING_DIVERGES`**. Falha de infraestrutura não autoriza isolamento. Um diagnóstico válido sem colisões não requer quarentena e o comando recusará `CORPORATE_NO_CONFIRMED_COLLISIONS`.

```bash
quarantine_digest='SUBSTITUIR_PELO_DIGEST_REVISADO_DESTA_VERSAO'
quarantine_request="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
quarantine_request_file="$(mktemp /tmp/corporate-quarantine-request.XXXXXX)"
printf 'source=%s\nverification=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$quarantine_digest" "$quarantine_request" "$evidence_ref" > "$quarantine_request_file"
cat "$quarantine_request_file"

docker exec \
  -e OLOS_CORPORATE_QUARANTINE_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_QUARANTINE \
  "$container" node dist/main.js corporate-quarantine-collisions \
  --confirm-source "$source_key" \
  --verification "$quarantine_digest" \
  --request-id "$quarantine_request" \
  --evidence "$evidence_ref"

docker exec "$container" node dist/main.js corporate-status
```

Esperado: evento `corporate_collision_quarantine_recorded`, `blocked=true`, confirmados inalterados e contagem `quarantined` correspondente aos membros formalmente identificados. Não exigir 183 se o diagnóstico atual mostrar outro conjunto. Consultar a evidência local sem selecionar payloads:

```bash
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v request_id="$quarantine_request" <<'SQL'
BEGIN READ ONLY;
SELECT request_id, source_key, target_table, binding, evidence_ref, verification_digest,
       previous_generation, previous_code, pending_count, member_count, schema_hash, created_at
FROM olos_http.corporate_collision_quarantine_runs WHERE request_id=:'request_id'::uuid;
SELECT target_id, code, remote_ids, fields, created_at
FROM olos_http.corporate_collision_quarantine WHERE request_id=:'request_id'::uuid ORDER BY target_id;
COMMIT;
SQL

# Aqui qualquer exit code não zero impede prosseguir para liberação.
remaining_file="$(mktemp /tmp/corporate-selective-remaining.XXXXXX)"
docker exec "$container" node dist/main.js corporate-verify-pending > "$remaining_file"
cat "$remaining_file"
```

Conferir `valid=true`, zero divergências e contagens de pendentes/isolados/elegíveis. Copiar **o novo digest aprovado do restante**, que inclui a quarentena. Se ainda houver erros, manter o bloqueio: não editar payloads, recibos, IDs ou o ledger para forçar sucesso.

```bash
release_digest='SUBSTITUIR_PELO_NOVO_DIGEST_VALIDO_APROVADO'
release_request="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
release_request_file="$(mktemp /tmp/corporate-selective-release-request.XXXXXX)"
printf 'source=%s\nverification=%s\nrequest_id=%s\nevidence=%s\n' \
  "$source_key" "$release_digest" "$release_request" "$evidence_ref" > "$release_request_file"
cat "$release_request_file"

docker exec \
  -e OLOS_CORPORATE_RECOVERY_CONFIRMATION=AUTHORIZE_CORPORATE_COLLISION_RECOVERY \
  "$container" node dist/main.js corporate-recover-collision \
  --confirm-source "$source_key" \
  --verification "$release_digest" \
  --request-id "$release_request" \
  --evidence "$evidence_ref"

docker exec "$container" node dist/main.js corporate-status
```

Esperado: evidência da liberação em `olos_http.corporate_collision_recoveries`, `blocked=false` e `paused=true`. Conferida a liberação e aprovada a retomada:

```bash
docker exec "$container" node dist/main.js corporate-resume
docker exec "$container" node dist/main.js corporate-status
docker logs --since 5m --tail 100 "$container"
```

Apenas o ciclo existente fará as entregas. Não executar outro worker, `corporate-deliver-once`, alteração de sequência, restart da coleta ou atualização direta de estado. Os isolados continuam em pending e não devem ser contados como entregas confirmadas. Se necessário, `docker exec "$container" node dist/main.js corporate-pause` pausa apenas a entrega.

`CORPORATE_VERIFICATION_STALE` exige diagnóstico novo e revisão do novo digest; a coleta pode ter admitido mais chamadas entre as etapas. Em `CORPORATE_QUARANTINE_COMMIT_UNKNOWN` ou `CORPORATE_RECOVERY_COMMIT_UNKNOWN`, preservar o UUID/digest/referência originais, consultar a respectiva evidência e repetir **exatamente a mesma invocação** para reconciliar. A repetição retorna `already_applied=true` e não muda estado/geração nem libera novo bloqueio. Nunca gerar outra requisição para contornar COMMIT incerto. Confirmar o estado atual mesmo após `already_applied=true`.


## Validação local

Com Node 24: `npm run build` aprovado; `npm test` **131/131**; `OLOS_DIRECT_TEST_FILES=test/corporate-recovery.integration.ts bash scripts/test-corporate-delivery.sh` **27/27**. A suíte completa `bash scripts/test-corporate-delivery.sh` teve **107 aprovados / 8 falhas**. Uma cópia limpa do HEAD `12ee8de`, compilada separadamente, reproduziu as mesmas sete falhas de histórico/homologação mais o agregado (**97 aprovados / 8 falhas**). Não se trata de uma suíte global limpa. O `npm run typecheck` mantém os **17 diagnósticos preexistentes**; apenas os números de linha mudaram pela adição da migration à fixture. `git diff --check` aprovado.

Os testes dirigidos incluem isolamento e retomada, preservação de recibos/Kommo/sequence/records/payloads, privacidade, novos conflitos, filtros, integridade dos vínculos, idempotência concorrente, locks com captura/entrega/resume/escritores remotos, rollback completo, COMMIT incerto, imutabilidade e reaplicação/ausência de migration. São testes sintéticos em PostgreSQL descartável com TLS, não validação da VPS. [Evidências detalhadas](../evidence/corporate-selective-recovery.json).
