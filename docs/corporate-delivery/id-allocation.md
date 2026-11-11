# IDs exclusivos do Corporate Delivery

Implementação e testes locais; nenhum acesso à produção, deploy, commit ou push. As 221 chamadas em quarentena foram informadas pelo operador e não foram consultadas.

Para desfazer exclusivamente uma preparação ainda em `adopting`, sem alocador remoto instalado, existe o [procedimento emergencial auditado](legacy-reversion.md). Ele conserva os dados da `008`; não é retorno ao binário antigo nem rollback de uma adoção ativa.

## Auditoria e contrato

`src/db.ts` não existe neste checkout. A descoberta/validação real está em `src/schema.ts`: `pg_get_serial_sequence(target,'internal_id_olos')`, coluna local `int8`, PK e privilégio USAGE. `Store.open()` guarda esse nome em `Store.sequence`.

Consumidores encontrados:

| Caminho | Uso |
| --- | --- |
| `src/store.ts`, persistência em modo local | `nextval()` ao inserir `olos_http.records`; grava a tabela local e usa a mesma sequência descoberta pelo catálogo. Continua existindo no modo local. |
| `src/corporate-delivery/delivery.ts`, admissão corporativa legada | `nextval()` e validação int32 antes de congelar a outbox. Continua somente até a preparação explícita desta adoção. |
| `src/corporate-delivery/reconcile.ts` | Apenas lê `last_value`, `is_called`, incremento e cycle; compara com o maior ID **local**. Não aloca e não prova exclusividade no MADM. |
| `src/corporate-sync/worker.ts` | Transporta IDs já existentes; não chama a sequência. Deve continuar desligado no fluxo direto, inclusive porque não implementa o novo contrato de reservas. |
| `src/store.ts.bak-*` | Cópias antigas com `nextval()`, fora do build TypeScript. Não são consumidores ativos. |
| `scripts/admin-preflight.mjs` | Descobre a sequência de `id` de tabelas administrativas; não é a sequência de `internal_id_olos`. |

A sequência local garante exclusividade somente entre seus próprios consumidores. Ela desconhece a ocupação do MADM, e o preflight da conciliação não altera isso. `MAX(id)+1`, um offset, números negativos ou uma faixa arbitrária não impedem que outro escritor use um ID entre a consulta e o INSERT.

## Solução

A migration corporativa `migrations/corporate/001_id_allocator.sql` cria um registro autoritativo de IDs usados/reservados, um cursor transacional limitado a inteiros positivos de 32 bits, uma função de reserva e um guard `ENABLE ALWAYS` em `raw.olos_calls`. A instalação bloqueia DML brevemente e registra **todos** os IDs corporativos não nulos existentes sem atualizar as chamadas. O cursor começa em 1 e procura posições livres no registro; não é inicializado por MAX nem escolhe uma faixa externa.

A chave primária do registro decide a concorrência. Reservas e escritores diretos disputam a mesma chave; um escritor direto registra seu ID como usado ou é recusado quando o ID já está reservado/usado. IDs usados permanecem registrados mesmo após DELETE da chamada. Uma reserva identifica papel PostgreSQL, binding, source ID, hash e requisição. Um token privado permite somente ao papel proprietário consumir aquele ID. O token não é logado. O papel de entrega recebe USAGE no schema e EXECUTE na função, sem acesso direto às tabelas de reserva.

**A garantia exige instalar e preservar esse guard no MADM e revisar o contrato dos demais escritores.** Ele também se aplica a seus INSERTs e mudanças de `internal_id_olos`: eles não podem continuar supondo que qualquer número de uma sequência independente está livre. Escritores que recebem recusa precisam usar a autoridade de reservas ou tratar a recusa; não há bypass automático. DDL privilegiado que desabilite/remova o guard ou adultere o registro está fora do contrato. O código verifica funções exatas, propriedade, search_path, trigger ALWAYS, PK e hash do contrato antes de reservar/entregar. O Corporate Sync independente continua recusando esse trigger adicional.

A preparação local, antes da instalação corporativa, persiste `adopting` e `id_allocator_required=true`. Um lock exclusivo esvazia admissões legadas em andamento. A partir desse COMMIT, o código corporativo não volta a `nextval()`. A captura conserva o HTTP/read/checkpoint original e persiste os registros normalizados em `corporate_id_admissions`, **sem ID**, mesmo sem MADM. Não há reserva remota na transação de captura, nova leitura OLOS, outro worker ou timer.

O ciclo de entrega existente materializa um lote limitado pela configuração já existente: reserva IDs idempotentemente no MADM, confirma a reserva e grava `records`, primeira outbox congelada e `corporate_id_assignments` numa única transação local. Uma falha/COMMIT incerto conserva a admissão e sua requisição estável; repetir a reserva retorna o mesmo ID/token, sem atribuir outro ID. A marca `materialized` é confirmada junto com a outbox. Não há promessa de transação distribuída.

A adoção registra também **todos os IDs locais antigos**, inclusive confirmados, pending, skipped e quarentena. IDs já ocupados no MADM permanecem usados; IDs locais ainda ausentes são reservados com seu número original. Colisões antigas não são renumeradas, resolvidas ou liberadas por essa operação. As funções/hashes/payloads de entrega anteriores não são reescritos. O hash de schema antigo continua válido: o guard adicional é validado separadamente e seu contrato é registrado na adoção.

Um constraint trigger local diferido exige uma atribuição autoritativa para novos `records` após a preparação. Assim, um binário legado não consegue confirmar gravações a partir de `nextval()`. Não remover a marca de adoção nem voltar ao binário antigo: isso não é rollback operacional suportado. A sequência local, seus valores e configurações não são alterados.

A quarentena continua independente. Novas admissões ainda sem ID aparecem como `unallocated` no status; não são recibos nem confirmações. O verificador inclui esse contador e exige o contrato do alocador ativo. Seu digest usa domínio v3 apenas no modo adotado; evidências v1/v2 existentes permanecem preservadas. A entrega normal mantém filtros, comparação integral, identidade lógica, schema, hashes e proteção de COMMIT incerto. Ausência de reservas/capacidade ou alteração de contrato retém as admissões. Em `2147483647`, esgotamento para a atribuição: não há wrap, incremento fora de int32 ou fallback local.

## Adoção curta na VPS, após aprovação

Pré-requisito: versão revisada **já em execução no mesmo worker** e migrations locais anteriores `001`–`007`. Nenhum comando abaixo faz deploy ou reinicia a coleta. Usar o projeto Compose efetivo ou preencher o ID exato do container aprovado. Rever papéis e todos os escritores corporativos com o DBA antes da instalação do guard. As conexões DBA abaixo são separadas das credenciais normais do worker e nunca substituem seu binding.

```bash
set -euo pipefail
umask 077
container="$(docker compose ps -q worker)"
test -n "$container"
source_key='ORIGEM_LITERAL_APROVADA'
evidence_ref='REFERENCIA_DA_APROVACAO'
local_worker_role='PAPEL_LOCAL_EXISTENTE_DO_WORKER'
delivery_role='PAPEL_CORPORATIVO_EXISTENTE_DO_WORKER'
: "${LOCAL_DBA_DATABASE_URL:?conexao DBA LOCAL aprovada}"
: "${CORPORATE_DBA_DATABASE_URL:?conexao DBA MADM aprovada}"

# Pausa somente a entrega. Coleta permanece em operação.
docker exec "$container" node dist/main.js corporate-pause
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/008_corporate_id_allocator.sql
psql "$LOCAL_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v worker_role="$local_worker_role" <<'SQL'
GRANT SELECT,INSERT,UPDATE ON olos_http.corporate_id_allocator,olos_http.corporate_id_admissions TO :"worker_role";
GRANT SELECT,INSERT ON olos_http.corporate_id_assignments TO :"worker_role";
SQL

adoption_id="$(docker exec "$container" node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
adoption_file="$(mktemp /tmp/corporate-id-adoption.XXXXXX)"
printf 'source=%s\nrequest_id=%s\nevidence=%s\n' "$source_key" "$adoption_id" "$evidence_ref" > "$adoption_file"
cat "$adoption_file"
adoption_args=(--confirm-source "$source_key" --request-id "$adoption_id" --evidence "$evidence_ref")
docker exec -e OLOS_CORPORATE_ID_ALLOCATOR_CONFIRMATION=AUTHORIZE_CORPORATE_ID_ALLOCATOR \
  "$container" node dist/main.js corporate-prepare-id-allocator "${adoption_args[@]}"

# Somente MADM; registra a ocupação existente e instala o guard, sem renumerar chamadas.
psql "$CORPORATE_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/corporate/001_id_allocator.sql
psql "$CORPORATE_DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v delivery_role="$delivery_role" <<'SQL'
GRANT USAGE ON SCHEMA olos_delivery_ids TO :"delivery_role";
GRANT EXECUTE ON FUNCTION olos_delivery_ids.reserve(text,jsonb,boolean) TO :"delivery_role";
SQL

docker exec -e OLOS_CORPORATE_ID_ALLOCATOR_CONFIRMATION=AUTHORIZE_CORPORATE_ID_ALLOCATOR \
  "$container" node dist/main.js corporate-adopt-id-allocator "${adoption_args[@]}"
docker exec "$container" node dist/main.js corporate-status
docker exec "$container" node dist/main.js corporate-check
docker exec "$container" node dist/main.js corporate-verify-pending
```

Conferir `allocator=active`, IDs/recibos/quarentena preservados e contador `unallocated`. A adoção **não remove bloqueio nem pausa existentes**. Se o verificador encontrar colisões antigas, usar o [procedimento seletivo já existente](selective-collision-recovery.md) com novos diagnósticos/digests desta versão. Somente depois de liberar o bloqueio pelo procedimento autorizado e conferir a evidência:

```bash
docker exec "$container" node dist/main.js corporate-resume
docker exec "$container" node dist/main.js corporate-status
docker logs --since 5m --tail 100 "$container"
```

Acompanhar redução de `unallocated` e confirmações pelo ciclo já existente; novas capturas podem aumentar o contador. A fila não deve ser apagada para aparentar sucesso. O processamento continua limitado ao batchSize existente; os testes não estabelecem capacidade/latência de produção.

Em falha de adoção ou `ALLOCATOR_ADOPTION_LOCAL_COMMIT_UNKNOWN`, conservar o mesmo UUID/origem/referência e repetir **a mesma chamada de adoção**. `adopting` mantém a captura em fila sem alocação local. Em falha de reserva/materialização, a próxima execução do ciclo repete a mesma requisição persistida; não limpar o registro remoto, seus tokens/tombstones, admissões ou atribuições locais. A preservação do banco MADM e dessas tabelas de autoridade faz parte do backup/restore; restaurar apenas uma parte pode invalidar o contrato.


## Validação local

Build aprovado; **132/132 unitários**, **42/42 Corporate Sync**, **43/43 na suíte de recuperação/alocação** (42 subtestes mais agregado). A suíte corporativa completa teve **123 aprovados / 8 falhas**. O HEAD limpo `bd8b58a`, compilado e executado separadamente, reproduziu as mesmas sete falhas de histórico/homologação mais o agregado (**107 aprovados / 8 falhas**). O typecheck global mantém os **17 erros preexistentes**, com saída completa idêntica via `cmp`; `git diff --check` passou. [Evidências](../evidence/corporate-id-allocator.json).

Os testes usam PostgreSQL descartável com TLS verificado e cobrem concorrência, escritores externos e outro papel SQL, registros usados/tombstones, int32, preservação da sequência e históricos, falha de conexão, captura offline sem ID, rollback, COMMIT incerto, reinício, idempotência, lock order, compatibilidade de quarentena e reaplicação das migrations. Não estabelecem capacidade, privilégios ou compatibilidade dos demais escritores reais do MADM.
