# Worker OLOS ExportDataV3 HTTP

Worker independente, Node.js 24 LTS + TypeScript strict + PostgreSQL. Um processo, um consumidor de `AttemptsRawData`, sem Redis, filas distribuídas ou SQL Server. A aplicação está implementada e testada localmente; a liberação corporativa depende da validação descrita abaixo. **Não há garantia de entrega exatamente uma vez na fronteira HTTP → PostgreSQL.**

## Instalação e validação local

```bash
nvm use
npm ci
npm run typecheck
npm test
bash scripts/test-integration.sh
npm run build
docker build -t olos-http-worker:local-validation .
bash scripts/test-docker.sh
```

O script de integração cria e remove **somente seu próprio PostgreSQL descartável**, em porta aleatória de loopback. Usa respostas sintéticas, nunca `DATABASE_URL` nem OLOS real. Requer Docker. `test/fixture.sql` cria a tabela exclusivamente nesse banco de teste; não é migration corporativa.

Credenciais: configurar as variáveis de `.env.example` no Dokploy ou em arquivo privado, fora do Git, com permissão `0600`. A CLI não carrega `.env` implicitamente. No Node 24, usar `node --env-file=/caminho/privado.env dist/main.js <comando>`. Evitar senha como argumento do shell. Nunca copiar segredos de containers para o checkout.

`OLOS_TLS_VERIFY=true` é o padrão. Somente o valor explícito `false` desabilita a validação do certificado no agente HTTP OLOS e emite `olos_tls_verification_disabled` com nível `warn`. Não altera TLS global, PostgreSQL ou outros clientes HTTP. Preferir o hostname oficial com certificado válido. A exceção desabilita a validação do certificado inteiro, não apenas a comparação do hostname. O Compose lê `.env` para interpolação e repassa essa variável; a CLI exige `--env-file`. Nunca colocar credenciais reais em `.env.example`.

## Auditoria antes de migrations

1. Confirmar a conexão, schema/tabela e que nenhum outro consumidor SQL/HTTP avança a mesma origem.
2. Exportar somente metadados, sem consumir OLOS:

```bash
node --env-file=/caminho/privado.env dist/main.js inspect-schema /caminho/privado/audit-schema.json
```

3. Revisar geração de `internal_id_olos`, constraints, índices, tipos, permissões, triggers e RLS. O arquivo de saída é criado com `0600` e não sobrescreve arquivos.
4. Aplicar `migrations/001_ingestion.sql` manualmente, com o papel administrador escolhido pelo DBA. A migration usa transação, cria apenas `olos_http.reads` e `olos_http.records` e seus índices. Não altera/cria a tabela corporativa. Uma segunda aplicação falha e faz rollback; não é executada no boot.
5. Conceder ao papel do worker `USAGE` nos schemas, `SELECT/INSERT/UPDATE` nas duas tabelas de controle e no destino, e `USAGE` na sequence **real** do ID de destino. Não fornecer papel superuser ao serviço. Executar `check` com esse papel.

```bash
# Com PG* ou PGSERVICE configurado privadamente para o administrador correto:
psql -X -v ON_ERROR_STOP=1 -f migrations/001_ingestion.sql
node --env-file=/caminho/privado.env dist/main.js check
```

O destino suportado tem PK bigint `internal_id_olos` gerada por sequence/identity, `data_ligacao` timestamptz e os campos do mapeamento anuláveis. Campos textuais admitem text/varchar; os campos sem fonte `tma_origem` e `raw_olos_call_id` também admitem tipos legados numéricos porque recebem NULL. Nenhuma conversão destrutiva é feita. Timestamp sem fuso, ID sem geração, coluna obrigatória desconhecida, índices únicos/constraints adicionais, triggers ou RLS interrompem o preflight e exigem adaptação revisada. Índices comuns sem unicidade são preservados e aceitos.

**Destino com dados preexistentes:** a aplicação exige correspondência com `olos_http.records`. Não tenta deduzir identidade por `CallId` nem inserir por cima de um histórico sem marcadores. É necessário reconciliar uma baseline com evidência dos IDs de origem antes da ativação. Não há ferramenta de preenchimento automático dessa baseline. O ID do destino não será equiparado ao ID de origem.

O [relatório de auditoria](docs/audit.md) registra o banco local inspecionado e as incompatibilidades observadas. Esse banco não foi declarado destino corporativo.

## Arquitetura e integridade

```text
preflight PostgreSQL + lock exclusivo por origem
  → autenticação + catálogo + cache estático
  → intenção durável (reading)
  → HTTP read-data-current-day
  → resposta integral durável (received)
  → validação e mapeamento
  → transações em lotes: marcador + UPSERT destino + progresso
  → done → espera intervalo persistido → próximo ciclo
```

Uma conexão do pool mantém `pg_try_advisory_lock` de sessão até o encerramento. Os demais comandos operacionais usam o mesmo lock. Antes de outra leitura, o worker verifica PostgreSQL e leituras pendentes. A perda de sessão interrompe a execução e aborta HTTP. Um reinício reencontra a intenção durável. O lock coordena somente instâncias com o mesmo `OLOS_SOURCE_KEY` **e o mesmo banco**; não exclui o worker SQL antigo, ferramentas externas ou instâncias usando outro banco/chave. Essa coordenação é operacional e precisa ser confirmada.

`olos_http.reads` armazena intenção, operação/data/faixa, horários, resposta, progresso e erro sanitizado. A resposta é salva como texto antes do parse, preservando inclusive JSON inválido. Não há Promise de INSERT por registro. A resposta HTTP tem limite de bytes e cada transação usa até `BATCH_SIZE` registros. SQL parametrizado e `jsonb_to_recordset` fazem as escritas em lote.

`olos_http.records` relaciona `(source_key, AttemptsRawDataID)` ao ID gerado pelo banco, hash dos campos de origem e IDs de referência. Marcadores, destino e progresso são gravados na **mesma transação**. `CallId` não é chave única. IDs JSON grandes são lidos sem passagem por `Number`, evitando arredondamento. IDs de origem repetidos com conteúdo divergente bloqueiam o lote para investigação. A resposta fica preservada; não se escolhe arbitrariamente uma versão.

O UPSERT altera apenas nomes de referências quando há um valor conhecido diferente. Nunca apaga nomes usando cache ausente, nem sobrescreve CPF/e-mail preenchidos por outro fluxo. A alocação dos IDs usa a sequence do destino; um lock curto de tabela durante cada lote impede confundir uma colisão de sequência/escritor concorrente com uma linha pertencente ao worker. Esse lock pode competir com outros escritores e deve ser medido na homologação.

**Janela residual:** a OLOS pode marcar o lote lido antes de a resposta chegar ou antes de o PostgreSQL confirmar seu armazenamento. A intenção torna a tentativa visível, mas não recupera bytes que nunca chegaram. Falha de rede, 500, resposta grande demais ou morte do processo nessa janela bloqueiam novo consumo. Retomar depende de `log-read-data`, `re-read-data`, retenção e atribuição confiável de data/faixa. Não se executa reset automático nem se afirma perda zero.

## Mapeamento

As fontes abaixo seguem o PRD; ainda precisam ser confirmadas em uma resposta HTTP real autorizada. Os testes usam fixtures sintéticas.

| Destino | Regra implementada |
|---|---|
| internal_id_olos | Sequence/identity do próprio destino; nunca AttemptsRawDataID |
| olos_call_id | CallId, preservado como texto |
| data_ligacao | StartDate, com offset explícito; se ausente, exige SOURCE_TIME_ZONE confirmada |
| telefone | OriginalPhoneNumber, sem normalização |
| nome_agente | Users.UserName por AgentId |
| id_campanha_olos | CampaignId como texto |
| nome_campanha_olos | Campaign.Description |
| id_tabulacao_olos | DispositionId como texto |
| nome_tabulacao_olos | Disposition.Description |
| cpf | NULL; fonte não confirmada |
| lead_id_origem | NULL; fonte não confirmada |
| tma_origem | NULL; semântica não confirmada |
| razao_desligamento | NULL; fonte não confirmada |
| email | NULL; fonte não confirmada |
| raw_olos_call_id | NULL; significado não confirmado; não usa CallIdTelecom/AttemptsRawDataID |
| telefone_match_key | NULL; regra de normalização não confirmada |

`CampaignData` não é interpretado como fonte de CPF/e-mail. Datas preservam até seis casas de microssegundos. Datas locais inexistentes/ambíguas em transição de horário de verão são rejeitadas. CPF, telefone e IDs textuais não são convertidos em inteiros. Os registros sem referência mantêm seus IDs e nomes NULL.

Users, Campaign e Disposition são carregadas na inicialização e a cada `STATIC_CACHE_TTL_MS` (padrão 1 hora). A troca do cache só ocorre quando as três leituras funcionam. Apenas IDs/nomes são mantidos; `Users.Password` nunca é colocado no cache, banco ou log. Nomes ausentes são reconciliados por SQL em lote após atualização do cache ou pelo comando `reconcile-names`.

## Tokens, polling e erros

`OlosAuthManager` mantém tokens apenas em memória. O primeiro grant é `password`; os seguintes usam `refresh_token`. A validade é calculada com `expires_in` real, a partir do início da requisição, e a margem é `min(60 segundos, 10% da validade)`. Há uma única autenticação/renovação em andamento. Novo refresh token substitui o anterior; ausência de novo token preserva o existente. Rejeição 400/401 do refresh provoca uma autenticação por senha. Falhas de rede/500 no auth não são confundidas com revogação. Após reinício, autentica novamente.

401 invalida o access token usado e permite **uma** repetição autenticada. 400 interrompe por contrato; 403 interrompe por permissão. 429 respeita `Retry-After` (segundos ou data HTTP). HTTP de referências/catálogo/auditoria admite até três tentativas com backoff; a autenticação indisponível suspende o ciclo, sem consumir origem. O loop tolera `MAX_RETRY_ATTEMPTS` falhas consecutivas transitórias, com backoff até 60 segundos (ou mais se `Retry-After` exigir), e então encerra com erro. Sucesso zera o contador. Não há retry infinito agressivo.

**Exceção necessária:** 500/rede em endpoint consumidor não têm retry automático, pois podem ter avançado o consumo. 400/401/403/429 são tratados como rejeições sem lote consumido; esse comportamento HTTP deve ser homologado com a OLOS. Falha PostgreSQL interrompe o processo; respostas já persistidas são recuperáveis localmente, e intenções sem resposta exigem reconciliação.

`POLL_INTERVAL_MS=120000` inicializa o intervalo em 2 minutos quando ainda não há configuração salva. O agendador dinâmico admite intervalos de 1 a 60 minutos **após terminar o ciclo**, aplicados pelo painel sem reiniciar o container. Cache, HTTP, escrita e retries fazem parte do ciclo, sem sobreposição. O intervalo não equivale à latência ponta a ponta: disponibilidade da origem, backlog e tempos de processamento precisam ser medidos.

## Comandos e recuperação

Todos os comandos abaixo são `node dist/main.js <comando>` com configuração privada carregada. Comandos HTTP alteram/leem a origem conforme indicado; sua existência não constitui autorização para executá-los em produção.

| Comando | Efeito |
|---|---|
| inspect-schema CAMINHO | Somente metadados PostgreSQL; não exige migrations nem OLOS |
| check | Preflight local, sem HTTP e sem escrita de negócio |
| status | IDs/estados das leituras locais pendentes, sem resposta/PII |
| once | Uma leitura corrente, consumo real quando autorizado |
| start | Polling contínuo de current-day |
| admin | Painel administrativo e o mesmo agendador dinâmico; ver migration/configuração específicas |
| capture-once | Uma captura bruta em `received`, sem normalização ou retry transacional; bloqueia qualquer pendência |
| previous | Uma leitura de dias anteriores, pelo mesmo pipeline e deduplicação |
| recover-local | Reprocessa respostas locais recebidas; nenhum HTTP; nomes podem ficar NULL |
| log-read DATA CAMINHO | Audita log oficial e salva resposta em arquivo privado 0600 |
| reread DATA PK_INICIAL PK_FINAL | Recuperação oficial de faixa; mesmo pipeline; aceita pendência remota prévia |
| reconcile-names | Atualiza referências e reconcilia nomes locais; não consome AttemptsRawData |
| resolve READ_UUID EVIDENCIA | Reconhecimento administrativo de uma intenção sem resposta, após conciliação externa |

Para a primeira captura bruta, seguir [capture-once](docs/capture-once.md), incluindo inspeção de metadados e recuperação sem normalização prematura. O procedimento abaixo se aplica ao pipeline de ingestão já homologado.

O comando `start` agora usa o [agendador dinâmico e painel administrativo](admin/README.md), com intervalo persistido de 1 a 60 minutos. A nova migration é manual e obrigatória para `start`/`admin`; os comandos de captura/check continuam independentes dela. A documentação administrativa detalha pausa, parada, credenciais, segurança, publicação controlada e rollback.

Procedimento:

1. Parar o serviço e manter apenas um operador/consumidor ativo. Preservar banco, marcadores e respostas; não apagar controles para liberar o loop.
2. Executar `status`. Se a resposta está `received`, corrigir o erro local e usar `recover-local`; depois `reconcile-names` se necessário. Commit cuja confirmação se perdeu será reconhecido pelo progresso/marcadores transacionais.
3. Para `reading` sem resposta, confirmar com a OLOS que a operação remota terminou. Consultar `log-read` das datas pertinentes (inclusive virada do dia, no fuso de exportação confirmado).
4. Correlacionar horário, identidade de consumo, tabela, data, faixa e quantidade com a tentativa local. Se a atribuição for ambígua ou a retenção tiver expirado, manter o bloqueio e escalar. Não presumir que o próximo current-day devolve o lote perdido.
5. Com a faixa confirmada e autorização, executar `reread DATA INICIO FIM`. O worker valida IDs retornados dentro da faixa. **Não presume contiguidade das PKs nem calcula a quantidade esperada pela diferença entre limites.** Não presume que StartDate seja a data de exportação. Conferir contagem/IDs com a evidência oficial e o destino.
6. Uma releitura bem-sucedida não encerra automaticamente a intenção original. Após conciliação completa, `resolve UUID 'ticket: faixa, contagens e conclusão remota verificadas'`. Esse comando registra a declaração do operador; não verifica a evidência externa nem é prova de ingestão. Respostas `received` inválidas não podem ser descartadas por esse comando.
7. `check` e `start` após resolver todas as incertezas. Executar `previous` de forma controlada para backlog, períodos de indisponibilidade e virada de dia; **não há backfill automático**. Drenar repetindo até `[]`, conforme contrato homologado. O polling de current-day sozinho não cobre registros que ficaram no dia anterior.

## Dokploy / Docker

1. Criar um serviço Compose com este checkout. Configurar rede que alcance o PostgreSQL existente e a URL HTTPS OLOS. Não publicar portas: o worker não oferece HTTP/healthcheck artificial.
2. Informar variáveis no painel, usar um único replica e `WORKER_COMMAND=check` inicialmente. O Compose não provisiona nem migra PostgreSQL.
3. Inspecionar esquema e aplicar somente a migration de controle aprovada. Resolver incompatibilidades/baseline e conferir permissões do papel de runtime.
4. Homologar catálogo, formatos de resposta, unicidade global e estabilidade de `AttemptsRawDataID` entre dias, fuso, semântica de consumo, 401/429, retenção/releitura. Só então configurar `SOURCE_ID_UNIQUENESS_CONFIRMED=true` com evidência externa; a flag não constitui prova automática.
5. Sob autorização, executar `once`, comparar a amostra com o destino e testar renovação por vários vencimentos, backfill e recuperação em ambiente controlado.
6. Definir `WORKER_COMMAND=start` e iniciar uma única instância. `docker compose up -d --build worker` é o comando equivalente fora do Dokploy. Logs: `docker compose logs -f --tail=100 worker`. Parada: `docker compose stop worker`.

O Compose usa `restart: "no"` deliberadamente: encerramento após erro persistente requer atenção operacional, sem reinícios infinitos ignorando bloqueios. O processo retenta erros transitórios dentro do limite. Configurar alerta do Dokploy para container parado e logs `recovery_required`/`worker_stopped`/`scheduler_error`. Nos comandos `start`/`admin`, SIGTERM/SIGINT aguardam o ciclo atual; operações CLI de captura preservam seu comportamento de abortar HTTP em sinais. Preferir parar pelo painel e aguardar `STOPPED` antes de encerrar o container; SIGKILL ou grace period insuficiente ainda podem exigir recuperação.

O Dockerfile tem build multi-stage, dependências fixadas no lockfile e runtime não-root. A imagem usa a linha Node 24, ainda suportada no [calendário oficial](https://github.com/nodejs/Release#release-schedule); atualizar/pinar digest conforme política corporativa. Nenhuma credencial é incluída na imagem. O Compose limita memória a 512 MiB e CPU a 1; ajustar com medidas reais.

## Observabilidade, capacidade e retenção

Logs JSON incluem horário, tabela, read_id técnico, received/inserted/updated/duplicates, request_ms, persistence_ms, duration_ms e códigos de erro. `duplicates` conta registros já conhecidos (podem também receber atualização de nome). Não incluem corpo HTTP, mensagem bruta do PostgreSQL, URL com senha, tokens ou dados pessoais. O tempo de persistência inclui staging/validação/mapeamento e escrita; os logs não são métricas de disponibilidade upstream.

A resposta inteira é limitada por `MAX_RESPONSE_BYTES` (32 MiB por padrão) antes de parse. Não há parser streaming: corpo bruto, JSON e registros mapeados usam memória durante o ciclo. Uma resposta acima do limite bloqueia por incerteza; ajustar com volumes reais e margem de memória. Não há promessa de throughput corporativo baseada em fixtures.

As respostas de AttemptsRawData contêm dados pessoais e ficam no PostgreSQL, portanto o banco e backups precisam de acesso restrito e retenção corporativa. **Marcadores em `records` são permanentes enquanto houver possibilidade de releitura.** Apagá-los quebra deduplicação. `reads` inclui leituras vazias, então também precisa de retenção. Não há limpeza automática de evidência. Depois da janela de auditoria aprovada, o DBA pode remover em lotes apenas leituras `done` antigas; nunca `reading`/`received` nem marcadores. Definir retenção/backup antes de ativar serviço prolongado.

## Evidência e limitações de liberação

Consultar [auditoria e plano de homologação](docs/audit.md) e [resultado da validação local](docs/validation.md). O formato de `available-tables` ainda não foi observado por HTTP: o parser admite arrays de `{TableName, Columns: [nome | {ColumnName}]}` ou linhas `{TableName, ColumnName}`. Outro envelope bloqueia antes do consumo. Não consulta outras tabelas transacionais.

A [auditoria de homologação](docs/homologation-audit.md) contém a reinspeção do destino local, os bloqueios atuais, a prova de `check` sem HTTP e o comando `scripts/homologate-http.mjs` para testar apenas autenticação/catálogo/estáticas. Essa etapa passou em 40 testes locais; não executou OLOS real.

A [primeira homologação HTTP real](docs/real-homologation.md) registra autenticação, refresh, catálogo e três estáticas aprovados com a exceção TLS OLOS explicitamente autorizada. O PostgreSQL corporativo continua sem configuração disponível; nenhuma leitura transacional foi executada.

O [laboratório local com Prisma](local/README.md) é independente do destino corporativo: PostgreSQL isolado com volume persistente, baseline explícito, resposta original, normalização versionada, checkpoint atômico e reprocessamento offline. Não tem polling ou aquisição HTTP habilitados e não herda a configuração TLS/credenciais da raiz.

Nenhuma chamada real OLOS, migration corporativa, commit, push ou deploy faz parte desta entrega. O banco corporativo, amostras HTTP reais e semântica dos campos pendentes continuam necessários para liberação.
