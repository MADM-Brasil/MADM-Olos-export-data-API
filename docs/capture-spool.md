# Captura grande: integração incremental e operação

O Worker, autenticação, endpoints, mapeamento, `Store.persist()`, locks da origem e regras corporativas existentes são preservados. A opção `CAPTURE_SPOOL_DIRECTORY` habilita streaming para capturas normais atuais/anteriores. Sem ela, permanece o caminho anterior. `capture-reread` continua limitado ao caminho já existente de recuperação progressiva; esta mudança não altera suas autorizações.

## Fluxo e limites

Intenção PostgreSQL → um POST → arquivo privado `.partial` → fsync → publicação exclusiva `.json` → recibo `.json.complete` sincronizado → associação transacional ao journal (`received`). O corpo nunca é substituído por outro arquivo.

Antes de escrever registros de negócio, duas etapas são distintas: validar todo o JSON/UTF-8/hash e os IDs/mapeamentos; depois processar lotes com `Store.persist()` e seu checkpoint transacional. Uma tabela TEMP, restrita à conexão, valida duplicidades entre todos os lotes sem manter o conjunto na memória. O parser `stream-json` mantém os números como lexemas textuais, como o callback atual do `lossless-json`. Chaves duplicadas, JSON inválido, objetos grandes e profundidade acima de 64 são recusados. Ao final, cada identidade elegível é conferida na persistência existente antes de `done`.

Limites padrão: resposta 512 MiB; HTTP 120 s; objeto 1 MiB; lote 4 MiB, também limitado por `BATCH_SIZE`; 5 milhões de elementos. Nenhum timeout PostgreSQL global foi aumentado. O volume deve ter pelo menos o limite de resposta + 16 MiB livres antes da intenção. Isso não reserva espaço contra outros processos: ENOSPC durante o download preserva o bloqueio e a evidência parcial. Não há remoção automática de capturas. Monitorar espaço e definir retenção/backup operacional antes de operação contínua.

O filtro de baseline existente é mantido; a resposta original completa fica no volume e o evento `capture_validated` informa a quantidade excluída pelo baseline. Contagem processada continua representando posições do array, inclusive duplicatas idênticas e registros filtrados, conforme o contrato anterior.

## Falhas e recuperação

| Falha | Estado e ação segura |
| --- | --- |
| Timeout, HTTP não 200, aborto ou stream interrompido | `reading`, sem replay automático; arquivo parcial não é resposta recuperável. Reconciliar consumo remoto. |
| `.json` sem recibo completo | Não adotar; manter evidência e bloqueio. |
| Arquivo + recibo completos, associação PostgreSQL não confirmada | `recover-spool UUID` ou inicialização do consumidor pode verificar e associar a mesma captura, sem POST. Somente intenções novas com contrato de spool são elegíveis. |
| ACK de COMMIT da associação perdido | Consultar journal; repetir a associação é idempotente. Não repetir a requisição remota. |
| JSON inválido, hash/ID divergente, arquivo ausente | Sem novas gravações de negócio durante validação; `received` fica protegido. Não editar corpo/hash para forçar conclusão. |
| Lote confirmado, ACK perdido ou reinício | Ler checkpoint durável, revalidar o arquivo inteiro e retomar os lotes restantes. Sem novo POST para recuperar a captura. |
| ACK da conclusão perdido | Journal `done` é definitivo; retomada não reprocessa essa leitura. |
| Sessão/lock PostgreSQL perdido | AbortSignal interrompe HTTP/parser; novo dono deve respeitar o journal pendente. |

O comando `recover-spool` só associa evidência completa ao journal. `recover-local` processa respostas já recebidas usando as referências estáticas existentes; pode consultar autenticação/catálogos, mas não consome novamente `AttemptsRawData`. A inicialização normal do consumidor também recupera capturas locais completas antes de admitir outra leitura.

## Ordem de publicação — não executada

1. Revisar o diff e os resultados locais; manter captura/scheduler STOPPED durante a transição. Registrar o estado corporativo; não alterar alocador, quarentenas, recibos ou políticas.
2. Fazer backup consistente do PostgreSQL e do volume. Confirmar a migration 001 e a restrição antiga de corpo do journal. A migration 012 não depende das migrations corporativas 010/011; não aplicá-las por associação.
3. Publicar a imagem candidata pelo fluxo GitHub/Dokploy aprovado, inicialmente com `CAPTURE_SPOOL_DIRECTORY` vazio. Validar o serviço atual. Não usar `docker compose up` externo para substituir o ciclo de vida do Dokploy.
4. Após autorização específica, executar **somente** a migration 012 abaixo. Ela é transacional, possui lock_timeout de 5 s, preserva as leituras antigas e recusa uma restrição de corpo desconhecida. É propositalmente de aplicação única: uma segunda execução falha e deve ser revertida com ROLLBACK, sem ignorar o erro.
5. Conferir o volume nomeado `exportdata-captures`, montagem RW em `/var/lib/olos/captures`, proprietário UID/GID do usuário `node` da imagem (1000:1000 nesta imagem), modo 0700 e persistência entre recriações. Não usar tmpfs para captura. O Compose proposto mantém rootfs somente leitura e limite de 2 GiB; o recurso permanece desabilitado até configurar o diretório.
6. No Dokploy, habilitar `CAPTURE_SPOOL_DIRECTORY=/var/lib/olos/captures` e `CAPTURE_SPOOL_REQUIRE_MOUNT=true`. Manter os limites padrão na primeira homologação; reiniciar pelo Dokploy, conservando volume e identidade da origem/baseline/timezone.
7. Executar os diagnósticos e a captura controlada somente quando não houver leitura incerta. A leitura histórica do incidente impede esse passo no estado atual.

Se a tabela 012 já tiver sido criada por uma versão experimental, conferir também `record_count`, as constraints e o contrato; não sobrepor um schema divergente. Esta implementação falha na abertura se o schema necessário estiver ausente. Tratar divergências por revisão específica, não com DDL improvisado.

### Comandos de revisão e build local

```sh
git status --short --branch
git diff --check
npm ci
npm run build
npm test
OLOS_DIRECT_TEST_FILES='test/capture-spool.integration.ts test/store.integration.ts test/corporate-recovery.integration.ts' bash scripts/test-corporate-delivery.sh
docker build -t olos-spool-reviewed:local .
```

Somente após aprovação humana do diff, em uma etapa separada, o responsável pode selecionar os arquivos do patch, criar o commit e publicar `main`. Nenhum commit/push foi executado nesta implementação. O identificador real da aplicação e o método de publicação Dokploy devem vir da instalação; não há comando de deploy automático adicionado ao projeto.

### Diagnósticos somente leitura

Definir `ADMIN_CONTAINER` explicitamente para o contêiner correto. Não imprimir `docker inspect` completo nem variáveis de ambiente, pois contêm segredos.

```sh
docker inspect --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}}' "$ADMIN_CONTAINER"
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/olos/captures"}}{{.Type}} {{.Name}} {{.Destination}} RW={{.RW}}{{end}}{{end}}' "$ADMIN_CONTAINER"
docker exec "$ADMIN_CONTAINER" node --input-type=module -e 'import {stat,statfs} from "node:fs/promises"; const p="/var/lib/olos/captures",s=await stat(p),f=await statfs(p,{bigint:true}); console.log({uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8),available_bytes:String(f.bavail*f.bsize)});'
docker exec -i "$ADMIN_CONTAINER" node --input-type=module <<'NODE'
import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
try {
  await db.connect();await db.query('BEGIN READ ONLY');
  console.log((await db.query("SELECT to_regclass('olos_http.capture_spool') AS spool_schema")).rows);
  console.log((await db.query(`SELECT id,state,processed_count,received_count,error_code,response_spool_read_id
    FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received') ORDER BY started_at`,[process.env.OLOS_SOURCE_KEY])).rows);
  console.log((await db.query(`SELECT r.id,r.state,r.processed_count,r.received_count,s.byte_size::text,s.state AS file_state,s.record_count
    FROM olos_http.reads r JOIN olos_http.capture_spool s ON s.read_id=r.response_spool_read_id
    WHERE r.source_key=$1 ORDER BY r.started_at DESC LIMIT 10`,[process.env.OLOS_SOURCE_KEY])).rows);
  await db.query('ROLLBACK');
} catch {console.error('READ_ONLY_DIAGNOSTIC_FAILED');process.exitCode=1;}
finally {await db.end();}
NODE
```

### Escrita: migration — exige autorização operacional separada

Executar somente com scheduler parado e conexão PostgreSQL autorizada a alterar o journal. Este comando usa as credenciais já existentes no ambiente, sem colocá-las na linha de comando ou no log. Não aplicar migrations corporativas.

```sh
docker exec -i "$ADMIN_CONTAINER" node --input-type=module <<'NODE'
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
try {
  await db.connect();
  await db.query(await readFile('migrations/012_capture_spool.sql','utf8'));
  console.log('CAPTURE_SPOOL_MIGRATION_APPLIED');
} catch {
  await db.query('ROLLBACK').catch(()=>{});
  console.error('CAPTURE_SPOOL_MIGRATION_FAILED');process.exitCode=1;
} finally {await db.end();}
NODE
```

### Escrita/consumo: uma captura controlada — não executar com a pendência histórica

Requer scheduler STOPPED, nenhum outro dono da origem e nenhuma leitura `reading`/`received`. O lock PostgreSQL também impede CLI concorrente. Os comandos usam a configuração e autenticação existentes; não passar segredos pela linha de comando.

```sh
docker exec "$ADMIN_CONTAINER" node dist/main.js check
docker exec "$ADMIN_CONTAINER" node dist/main.js status
docker exec "$ADMIN_CONTAINER" node dist/main.js capture-once
# Anotar o read_id retornado; deve estar received, com arquivo e recibo completos.
docker exec "$ADMIN_CONTAINER" node dist/main.js recover-local
docker exec "$ADMIN_CONTAINER" node dist/main.js status
```

Se houve falha de associação após publicação completa, em vez de nova captura:

```sh
docker exec "$ADMIN_CONTAINER" node dist/main.js recover-spool UUID_DA_NOVA_CAPTURA
docker exec "$ADMIN_CONTAINER" node dist/main.js recover-local
```

Confirmar `done`, `processed_count=received_count=record_count`, integridade do arquivo/recibo, ausência de duplicação de identidades, enfileiramento no mesmo outbox e contadores corporativos sem confirmação artificial. Só então solicitar RUNNING pelo controle administrativo existente, respeitando a decisão do operador. Quarentenas e recibos anteriores devem permanecer intactos.

## Incidente histórico: BLOQUEADO

`2523225a-a46d-407a-ad5a-d1ff771e576e`, de 12/11/2026, permanece `reading`, sem corpo e sem checkpoint recuperado. O intervalo oficial 51698102–51737251, Quantity 39150 e duas releituras `[]` **não provam cobertura**. O novo caminho só adota arquivos vinculados a novas intenções de spool; não cria evidência retroativa para essa leitura.

Não há bypass por argv/env nem autorização reutilizável para ignorar o parent. Uma nova chamada consumptiva com essa pendência exigiria evidência externa verificável de conclusão da operação e posição segura do cursor; recuperar os registros exige resposta oficial retida/releituras válidas e conferência das identidades efetivamente observadas. IDs ausentes continuam não comprovados; não resolver o parent por extremos/quantidade ou respostas vazias. Usar os mecanismos existentes de recuperação progressiva e verificação, sem alterar seu critério de prova.

## Interrupção e rollback

Interromper novas capturas em caso de montagem ausente, erro de fsync, disco abaixo da reserva, hash divergente, lock perdido, checkpoint divergente ou crescimento de RSS próximo ao orçamento de 2 GiB. Preservar banco e volume; nunca repetir POST para resolver erro ambíguo.

Rollback de código conserva a migration 012 e o volume. Antes de retornar ao binário antigo, terminar capturas `received` com o binário compatível, usando apenas recuperação local, e verificar ausência de pendências com referência a spool. Se não for possível, manter scheduler STOPPED e a imagem compatível para diagnóstico. O binário antigo não processa arquivos de spool: não liberar RUNNING nesse estado. Não executar DROP, remover arquivos ou limpar journal/outbox para permitir rollback.

## Evidências e limites da homologação local

Foram usados HTTP sintético e PostgreSQL 16 descartável em rede interna, sem portas publicadas. O teste de retomada transmite 67.136.897 bytes, perde o ACK de um lote confirmado, recria o consumidor e confirma 128 identidades exatas, sem segundo POST; também testa o modo corporativo com 128 pendências reais na outbox de teste e zero confirmações artificiais. HTTP isolado cobre 32/64/128 MiB com/sem Content-Length. A imagem foi exercitada com usuário node, rootfs somente leitura, limite de 2 GiB e volume nomeado em dois contêineres sucessivos; falta/readonly da montagem bloqueia a ativação.

Isso não comprova durabilidade do storage da VPS, comportamento WAN, retenção OLOS nem cobertura do incidente. A retenção de arquivos, backup e capacidade devem ser monitorados na instalação. A aprovação de homologação local do pipeline não autoriza retomar a origem histórica bloqueada.

Resultados finais locais (Node 24 / PostgreSQL 16):

| Verificação | Resultado |
| --- | --- |
| `npm run build` | Aprovado |
| `npm test` | 192/192 aprovados |
| Runner acima: spool + Store antigo + recuperação corporativa | 188/188 aprovados |
| Runner com `test/corporate-delivery.integration.ts` | 35 aprovados; 7 subtestes falhando + agregadora (8 falhas) |
| `npm run typecheck` | 17 diagnósticos preexistentes, todos em `test/corporate-delivery.integration.ts` |
| Build Docker / volume em dois contêineres / montagem ausente ou readonly | Aprovados |
| `git diff --check` | Aprovado |

As falhas corporativas foram reproduzidas em uma extração temporária do HEAD **compilado**, comparando o texto completo dos erros e locais de assertions/stack (somente timestamps removidos): duas de `assertHistoryReady` inexistente, uma de captura `history` com zero requisições em vez de uma, quatro de CLI `corporate-homologate` ausente. Os 17 diagnósticos TypeScript também são equivalentes por arquivo, linha, código e diagnóstico; apenas o prefixo temporário de caminho e a contagem truncada de propriedades do tipo Config foram normalizados. Não há aprovação integral dessas verificações globais.

No último teste conjunto, o processo da captura grande atingiu 402.169.856 bytes de maxRSS (aproximadamente 384 MiB). Isso é evidência sintética para a resposta de 64 MiB testada, não uma garantia de memória/tempo para todos os limites configuráveis.
