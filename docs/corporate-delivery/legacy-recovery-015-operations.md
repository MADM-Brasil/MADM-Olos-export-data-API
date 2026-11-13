# Implantação e rollback da recuperação legacy / 015

Procedimento futuro para operador autorizado. Nenhum comando abaixo foi executado na VPS ou em bancos reais durante a validação. O código de produção permanece idêntico a `4788bab`; os commits posteriores acrescentam documentação e testes. Não executar migrations corporativas, `setval`, remapeamento, remoção de quarentenas ou comandos de ativação de autoridade.

## Portões de execução

| Etapa | Evidência obrigatória para prosseguir | Interromper se |
| --- | --- | --- |
| Publicar o código, ainda inativo | SHA revisado; testes PostgreSQL 16/build aprovados; imagem vinculada ao SHA; serviço `admin` e volumes identificados; scheduler desejado/real STOPPED; delivery pausado; backup atual restaurável | Serviço/imagem desconhecido, processo em voo, RUNNING/PAUSED no scheduler, ausência de backup/volume ou falha nova de validação |
| Aplicar 015 local | Contratos 010/011/014 presentes; allocator legacy e reversão completed/validada; geração nula; required=false; zero assignments, zero admissions não materializadas, zero readoções não abortadas; guardas canônicas ALWAYS | Qualquer pré-condição falhar, inclusive assignment existente; não apagar dados para habilitar a migration |
| Liberar Corporate Delivery | 015 e hashes históricos verificados; índice/schema/TLS/lock corporativos aceitos; pendências admitidas sem divergência; incertezas reconciliadas; escritores/latência homologados; autorização operacional específica | Diferença de ID/hash/recibo/quarentena, drift, falta de privilégio, INTERNAL_ID_COLLISION, identidade ambígua, COMMIT incerto ou backoff pendente |
| Liberar scheduler | Delivery validado por entrega controlada e replay; journal/checkpoints aptos; um único owner; conectividade e capacidade aceitas; autorização específica | Recuperação de captura bloqueante, nova leitura incerta, autorização de continuidade ausente/expirada quando necessária, spool insuficiente, owner duplicado ou estado operacional desconhecido |

Os 57.208 confirmados, 1.162 pendentes e 696 itens em quarentena são referências informadas. O snapshot real aprovado antes da janela é a referência de preservação; não corrigir contadores por SQL para fazê-los coincidir com o chamado. Assignments não vazios são **bloqueio**, não um caso de migração suportado pela 015.

## 1. Identificar artefato e serviço

Variáveis obrigatórias, preenchidas pelo operador; não inventar nomes de containers, projeto Dokploy, caminhos ou endpoints. `RELEASE_COMMIT` deve ser um SHA completo aprovado da branch `fix/corporate-legacy-recovery`.

```bash
set -euo pipefail
: "${RELEASE_DIR:?checkout de release aprovado}"
: "${RELEASE_COMMIT:?SHA completo aprovado}"
: "${RELEASE_IMAGE:?tag imutavel da imagem}"
: "${ADMIN_CONTAINER_ID:?container do servico admin aprovado}"
: "${LOCAL_URI_SEM_SENHA:?URI do PostgreSQL LOCAL sem senha}"
: "${PGPASSFILE:?arquivo privado de autenticacao do PostgreSQL local}"
: "${AUDIT_DIR:?diretorio novo e privado para evidencias}"
umask 077
mkdir -p "$AUDIT_DIR"
test "$(stat -c %a "$PGPASSFILE")" = 600
test "$(git -C "$RELEASE_DIR" rev-parse HEAD)" = "$RELEASE_COMMIT"
test -z "$(git -C "$RELEASE_DIR" status --porcelain)"
git -C "$RELEASE_DIR" diff --exit-code 4788bab "$RELEASE_COMMIT" -- src migrations Dockerfile compose.dokploy.yaml

docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.Config.WorkingDir}} {{json .Config.Cmd}}' "$ADMIN_CONTAINER_ID"
docker inspect --format '{{range .Mounts}}{{println .Destination .Type .Name .Source}}{{end}}' "$ADMIN_CONTAINER_ID"
```

Esperado: serviço `admin`, workdir `/app`, comando `node dist/main.js admin`, volume persistente em `/var/lib/olos/captures` e CA corporativa correspondente à configuração aprovada. O Dockerfile isolado tem CMD `start`: **não iniciar essa imagem com o CMD padrão para este procedimento**. Caso a implantação use outra topologia/labels, interromper e reconciliar a identificação; não escolher um container por semelhança de nome. Não imprimir `.Config.Env`, não copiar credenciais para logs e não usar `PGDATABASE` para passar uma URI.

Build/publicação do artefato, em CI ou host de build aprovado, sem iniciar um worker:

```bash
docker build --label "org.opencontainers.image.revision=$RELEASE_COMMIT" \
  --tag "$RELEASE_IMAGE" "$RELEASE_DIR"
docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$RELEASE_IMAGE"
```

No Dokploy, selecionar o SHA/imagem aprovado no serviço existente e manter o comando `admin` e os volumes atuais. A ação de deploy/recreate pertence à janela autorizada e só ocorre depois dos passos 2–4. Não há comando universal de deploy Dokploy validado para a VPS nesta sessão; não substituir isso por `docker compose up` usando outro nome de projeto, o que poderia criar volumes e um coletor paralelo.

## 2. Confirmar parada e obter backup atual

Conferência somente leitura no banco **local**:

```bash
psql --dbname="$LOCAL_URI_SEM_SENHA" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT current_database(),current_user;
SELECT desired_state,runtime_state FROM olos_http.worker_settings;
SELECT source_key,target_table,ready,paused,blocked,last_code,
       id_allocator_required,id_allocator_generation,confirmed_count
FROM olos_http.corporate_control;
SELECT state,request_id,contract_hash,adopted_at FROM olos_http.corporate_id_allocator;
SELECT request_id,state,validated_at FROM olos_http.corporate_id_reversions;
SELECT count(*) AS assignments FROM olos_http.corporate_id_assignments;
SELECT count(*) AS unmaterialized FROM olos_http.corporate_id_admissions WHERE NOT materialized;
SELECT count(*) AS open_readoptions FROM olos_http.corporate_allocator_readoptions WHERE state<>'aborted';
COMMIT;
SQL
```

Esperado: banco/role local aprovados, scheduler `STOPPED/STOPPED`, controle pronto e pausado, `legacy`, contrato/adopted_at/geração nulos, `id_allocator_required=false`, reversão concluída/validada e os três contadores iguais a zero. Ausência de `worker_settings` exige reconciliar a topologia administrativa; não criar a tabela manualmente neste procedimento. Bloqueio de colisão preservado não deve ser limpo para aplicar a 015, mas impede liberar Delivery até a recuperação autorizada.

Depois de confirmar STOPPED e ausência de operações em voo, parar somente o serviço identificado, com encerramento gracioso:

```bash
docker stop --time 600 "$ADMIN_CONTAINER_ID"
pg_dump --dbname="$LOCAL_URI_SEM_SENHA" --format=custom --file="$AUDIT_DIR/local-before-015.dump"
pg_restore --list "$AUDIT_DIR/local-before-015.dump" > "$AUDIT_DIR/local-before-015.contents"
mkdir -p "$AUDIT_DIR/spool"
docker cp "$ADMIN_CONTAINER_ID:/var/lib/olos/captures/." "$AUDIT_DIR/spool/"
sha256sum "$AUDIT_DIR/local-before-015.dump" > "$AUDIT_DIR/local-before-015.dump.sha256"
```

`pg_restore --list` só confere o catálogo do arquivo; restauração em PostgreSQL isolado é necessária para comprovar restaurabilidade. O backup anterior à 014 não substitui este backup atual. Dados pessoais do backup/spool devem permanecer no diretório privado, fora de Git e logs compartilhados.

## 3. Registrar hashes antes/depois, sem expor payloads

Com todos os escritores locais suspensos, a função abaixo produz hashes de linhas ordenadas. O único campo ignorado é `delivery_uncertain_ids`, adicionado nulo pela 015; ele será conferido separadamente. Os dados atravessam um pipe para SHA-256, sem serem gravados em claro no manifesto. Qualquer falha SQL/pipeline interrompe o procedimento.

```bash
snapshot_corporate_local() {
  local output="$1" table digest
  : > "$output.partial"
  for table in \
    raw.olos_calls olos_http.records olos_http.corporate_outbox \
    corporate_sync.receipts olos_http.corporate_id_assignments \
    olos_http.corporate_id_admissions olos_http.corporate_id_allocator \
    olos_http.corporate_id_reversions olos_http.corporate_id_reversion_batches \
    olos_http.corporate_collision_quarantine olos_http.corporate_collision_quarantine_runs \
    olos_http.corporate_collision_recoveries olos_http.corporate_allocator_readoptions \
    olos_http.corporate_readoption_batches olos_http.corporate_allocation_fence \
    olos_http.corporate_control
  do
    digest=$(PGOPTIONS='-c default_transaction_read_only=on -c timezone=UTC -c datestyle=ISO,YMD' \
      psql --dbname="$LOCAL_URI_SEM_SENHA" -X -q -v ON_ERROR_STOP=1 \
      -c "COPY (SELECT evidence FROM (SELECT (to_jsonb(t)-'delivery_uncertain_ids')::text AS evidence FROM $table t) rows ORDER BY evidence COLLATE \"C\") TO STDOUT" \
      | sha256sum)
    printf '%s %s\n' "$table" "$digest" >> "$output.partial"
  done
  mv "$output.partial" "$output"
}
snapshot_corporate_local "$AUDIT_DIR/before-015.sha256"
```

Executar com o banco quiescente; caso contrário snapshots entre tabelas não são uma fotografia transacional única. Tabela ausente, erro de consulta ou alteração concorrente é motivo de interrupção. Homologar duração/espaço de ordenação no banco restaurado; não remover tabelas do manifesto para ocultar falhas.

## 4. Aplicar somente a 015 local e conferir o contrato

```bash
psql --dbname="$LOCAL_URI_SEM_SENHA" -X -v ON_ERROR_STOP=1 \
  -f "$RELEASE_DIR/migrations/015_corporate_legacy_recovery.sql"
snapshot_corporate_local "$AUDIT_DIR/after-015.sha256"
cmp "$AUDIT_DIR/before-015.sha256" "$AUDIT_DIR/after-015.sha256"

psql --dbname="$LOCAL_URI_SEM_SENHA" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT version,source_key,binding,target_table,installed_at
FROM olos_http.corporate_legacy_recovery;
SELECT delivery_uncertain_ids FROM olos_http.corporate_control;
SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname IN ('olos_http','raw')
ORDER BY n.nspname,c.relname,t.tgname;
COMMIT;
SQL
```

Esperado: exit 0 em todos os comandos, manifestos iguais, uma evidência `version=1` com source/binding/target exatos, `delivery_uncertain_ids=NULL` na primeira instalação. As guardas da 011 continuam ALWAYS; as três `corporate_authority_only` da 014 permanecem ALWAYS, agora com a função revisada da 015. As quatro novas guardas também são ALWAYS: controle, evidência e mappings de records/outbox. Não comparar apenas a quantidade de triggers: conferir definição e função canônicas com o runtime no próximo passo.

Se a conexão cair durante COMMIT, não concluir que houve rollback. Abrir nova sessão, verificar marcador/guardas/hashes; reaplicar a mesma 015 enquanto pausado só é permitido se suas pré-condições continuarem atendidas. Qualquer diferença histórica, assignment existente ou contrato desconhecido bloqueia a janela. Não executar DROP/DISABLE/UPDATE manual para fazer a migration passar.

## 5. Subir apenas o admin parado e validar com a role do runtime

Publicar o artefato aprovado pelo serviço existente no Dokploy. Reidentificar o novo container por ID e conferir imagem, comando e volumes como no passo 1. O scheduler persistido deve permanecer STOPPED, e o delivery pausado. A autorização para publicar o código não autoriza iniciar a coleta.

Verificação local canônica, sem capturar OLOS nem executar delivery:

```bash
docker exec -i --workdir /app "$ADMIN_CONTAINER_ID" node --input-type=module <<'JS'
import pg from 'pg';
import {assertReadoptionSchema} from './dist/corporate-delivery/readoption-proof.js';
import {assertLegacyRecoverySchema} from './dist/corporate-delivery/legacy-transition.js';
import {assertSchema} from './dist/schema.js';
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const db = await pool.connect();
try {
  await db.query('BEGIN READ ONLY');
  await assertReadoptionSchema(db);
  if (!await assertLegacyRecoverySchema(db)) throw new Error('LEGACY_RECOVERY_TRANSITION_REQUIRED');
  await assertSchema(db,'raw','olos_calls');
  await db.query('COMMIT');
  console.log('LOCAL_015_CONTRACT_OK');
} finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
JS

docker exec --workdir /app "$ADMIN_CONTAINER_ID" node dist/main.js corporate-status
docker exec --workdir /app "$ADMIN_CONTAINER_ID" node dist/main.js corporate-check
docker exec --workdir /app "$ADMIN_CONTAINER_ID" node dist/main.js corporate-verify-pending
```

Esperado: `LOCAL_015_CONTRACT_OK`; status pronto/pausado/legacy, origem e contagens compatíveis; evento `corporate_schema_checked`; verificação com `valid=true`, `divergences=0` nos itens fora da quarentena. `corporate-check` acessa o MADM e adquire lock, sem alterar dados; só executá-lo na janela autorizada e com timeout/impacto aprovados. Esses comandos administrativos não substituem a verificação canônica local, pois não chamam `delivery.open()`.

Verificar `GET /api/status` ou o painel autenticado: estado desejado e runtime STOPPED, sem owner coletor ativo. Não copiar cookies/tokens para logs. As liberações de Corporate Delivery e scheduler são decisões posteriores, sujeitas aos portões e ao [runbook de recuperação](legacy-recovery-015.md). Não há `corporate-resume` nem chamada de start/resume do scheduler nesta sequência de implantação.

## Rollback e interrupção

- **Antes do COMMIT da 015:** erro SQL aborta a transação. Com ACK conhecido de rollback, conferir ausência do marcador e guardas 014 originais. O código antigo ainda é incompatível com essas guardas; manter o serviço parado.
- **ACK da 015 desconhecido:** consultar o estado em nova sessão. Não remover marcador, recriar namespace ou restaurar backup como tentativa de descobrir o resultado.
- **015 confirmada, nenhuma operação posterior:** a opção padrão é manter banco/guardas e parar o processo. Restaurar o backup pré-015 exige janela própria, prova de ausência de novas escritas, ensaio isolado e reconciliação de spool; não se obtém segurança simplesmente recolocando uma imagem antiga.
- **Houve captura, atribuição ou entrega posterior:** não restaurar o backup anterior sobre o banco atual. Preservar IDs, outbox, recibos e possíveis COMMITs remotos. Voltar a outra política exige nova transição versionada e reconciliada, fora desta entrega.
- **Rollback só de imagem:** manter processo parado se a imagem não entender a 015. Não desabilitar `corporate_authority_only`, as guardas de mapping ou os controles para fazê-la rodar. A função da 014 foi alterada pela 015; preservar apenas nomes dos triggers não torna o binário anterior compatível.

Interromper imediatamente a liberação por divergência de hashes/recibos, quarentena alterada sem autorização, drift de função/trigger, COMMIT incerto, índice inválido, falta de privilégio, novo INTERNAL_ID_COLLISION ou identidade ambígua. Interromper novas capturas por leitura remota incerta, perda de owner, recuperação pendente ou falta de espaço. Falha de conectividade/timeout não autoriza ampliar timeout indiscriminadamente, repetir captura ambígua, trocar IDs ou limpar bloqueios.
