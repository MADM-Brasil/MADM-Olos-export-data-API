# Sincronização local → corporativo

Serviço independente de `AttemptsRawData`, `DynamicScheduler`, `Store`, autenticação OLOS e Billing. A entrada é `src/corporate-sync/cli.ts`; não importa a configuração nem o bootstrap operacional. Usa exclusivamente variáveis `CORPORATE_SYNC_*`. A implementação não foi conectada ao PostgreSQL corporativo.

## Contrato e limites

Sincroniza **novas chamadas por INSERT**, preservando `internal_id_olos`. Não replica UPDATE/DELETE da origem. A projeção de cada chamada fica congelada quando o lote pendente é persistido; enriquecimentos posteriores na origem não alteram o destino. Isso também vale para alterações de nome, tabulação, CPF, e-mail ou telefone depois da confirmação. Validar a prontidão dos dados na origem antes de habilitar o serviço.

O controle local tem dois componentes:

- `corporate_sync.control`: vínculo da configuração, geração, contagem confirmada, último ID confirmado e lote pendente durável.
- `corporate_sync.receipts`: um recibo por `internal_id_olos`, hash SHA-256 da projeção e instante de confirmação.

A seleção incremental usa anti-join com recibos, ordenado pelo ID e limitado pelo tamanho do lote. **Não usa `id > checkpoint`**: sequências podem ser alocadas antes do commit, e chamadas com IDs menores podem aparecer mais tarde. `last_confirmed_id` é informativo e pode diminuir. Não excluir recibos para economizar espaço: a retenção faz parte do contrato de entrega.

Uma única instância detém um advisory lock de sessão no banco local. A linha de controle também permanece bloqueada durante a entrega e confirmação de cada lote. Usar conexão direta ou pool em modo sessão; PgBouncer em modo transação é incompatível. A conexão local não é substituída silenciosamente após falha, evitando continuar com um lock perdido. Os locks são exclusivos deste módulo e não interferem nos locks OLOS/Billing.

## Mapeamento e colisões

Campos transferidos: `internal_id_olos`, `olos_call_id`, `data_ligacao`, `telefone`, `nome_agente`, `id_campanha_olos`, `nome_campanha_olos`, `id_tabulacao_olos`, `nome_tabulacao_olos`, `cpf`, `lead_id_origem`, `tma_origem`, `razao_desligamento`, `email`.

`raw_olos_call_id` e todos os `kommo_*` são omitidos do INSERT. Em chamadas existentes, esses campos são ignorados na comparação e permanecem intactos. Não existe UPDATE/DELETE corporativo nem ajuste de sequence.

A identidade lógica proposta é a tupla **(`olos_call_id`, `data_ligacao`, `telefone`, `id_campanha_olos`)**, na projeção temporal de destino. Os quatro campos são obrigatórios e não vazios. É um contrato que exige confirmação de negócio; não é uma afirmação de unicidade já comprovada nos dados reais. CallId isolado nunca determina igualdade. Não normalizamos telefone nem removemos zeros de identificadores textuais.

- Mesmo ID e identidade diferente: `INTERNAL_ID_COLLISION`; bloqueia o lote inteiro.
- Mesma identidade e algum campo transferido divergente: `EXISTING_CALL_DIVERGES`; não sobrescreve.
- Mesmo ID e todos os campos transferidos iguais: reconhece como existente e confirma o recibo.
- Mesma identidade encontrada em outro ID: `LOGICAL_CALL_AT_DIFFERENT_ID`; não realoca IDs automaticamente.
- Identidades repetidas dentro do lote: `DUPLICATE_LOGICAL_IDENTITY`.

A PK corporativa continua sendo a autoridade contra conflitos de ID. Transações de destino usam SERIALIZABLE e a verificação é repetida após INSERTs com `ON CONFLICT (internal_id_olos) DO NOTHING`. Não se cria constraint para a identidade composta. Escritores externos com outro protocolo podem introduzir duplicatas lógicas; a aplicação não promete unicidade global sem constraint corporativa. Homologar a convivência com esses escritores.

## TMA e timestamps: decisões obrigatórias

Os **11.406 registros com frações** foram informados no pedido; não houve recontagem no ambiente real. A origem aceita numeric/int4/int8 e o destino precisa ser int4. A conversão usa aritmética decimal/BigInt, sem arredondamento binário intermediário.

| Política | Resultado para 10.6 / -10.6 | Confirmação exigida para escrita |
| --- | --- | --- |
| `reject` (padrão) | bloqueia qualquer fração não zero | `CONFIRM_TMA_reject` |
| `truncate` | 10 / -10, truncamento em direção a zero | `CONFIRM_TMA_truncate` |
| `round-half-away` | 11 / -11; empate .5 afasta de zero | `CONFIRM_TMA_round-half-away` |

NULL só é aceito quando a coluna de destino permite NULL. `10.000` é inteiro exato. Após conversão, valida o intervalo `[-2147483648, 2147483647]`. Bigint também é validado sem passar por Number. `NaN`, infinito, notação exponencial e valores malformados são rejeitados. Políticas de conversão de frações exigem confirmação também em dry-run.

A origem deve ter `data_ligacao timestamptz`. Um destino timestamptz recebe instantes UTC. Para destino `timestamp without time zone`, exigir `CORPORATE_SYNC_TIMESTAMP_ZONE` com o fuso de negócio e `CORPORATE_SYNC_TIMESTAMP_CONFIRMATION=CONFIRM_TIMESTAMP_<fuso>`. A conversão ocorre no PostgreSQL com `AT TIME ZONE`, preservando microssegundos; não usa o timezone do sistema operacional. O contrato deve considerar ambiguidades de horário local em transições de DST. Precisão insuficiente no destino, datas fora de 0001–9999 e perda de frações de segundo bloqueiam o lote.

## Configuração e autorização

Copiar `docs/corporate-sync/environment.example` para um arquivo privado `.env.corporate-sync` (permissão 0600). Não carregar o `.env` operacional. URLs devem conter usuário, host e banco; não aceitar parâmetros de URL que possam substituir as opções TLS. Senhas precisam de percent-encoding quando necessário.

TLS é obrigatório por padrão em cada conexão, com validação de certificado. CA privada usa `CORPORATE_SYNC_SOURCE_CA_FILE` / `CORPORATE_SYNC_DESTINATION_CA_FILE` e montagem somente leitura no serviço. `*_TLS=false` é opção explícita para ambientes que tenham essa configuração aprovada; não ocorre fallback automático. Não há opção `rejectUnauthorized=false`.

| Variável | Padrão / finalidade |
| --- | --- |
| `CORPORATE_SYNC_SOURCE_URL` | conexão própria ao PostgreSQL local Dokploy |
| `CORPORATE_SYNC_DESTINATION_URL` | conexão própria ao PostgreSQL MADM; dispensada em `migrate` |
| `CORPORATE_SYNC_BATCH_SIZE` | 250; intervalo permitido 1–2000 |
| `CORPORATE_SYNC_INTERVAL_MS` | 30000; espera quando não há novas chamadas |
| `CORPORATE_SYNC_TIMEOUT_MS` | 15000; conexão, statement e lock timeout |
| `CORPORATE_SYNC_MAX_RETRIES` | 3; tentativas adicionais para falhas transitórias remotas |
| `CORPORATE_SYNC_BACKOFF_MS` | 500; backoff exponencial com jitter e componente exponencial limitado a 60 s |

Para `once` e `start`, todas estas configurações são exigidas **antes de abrir conexão**:

```dotenv
CORPORATE_SYNC_ENABLED=true
CORPORATE_SYNC_WRITE_CONFIRMATION=AUTHORIZE_CORPORATE_SYNC
CORPORATE_SYNC_IDENTITY_CONFIRMATION=CALL_ID_TIME_PHONE_CAMPAIGN_V1
CORPORATE_SYNC_TMA_POLICY=reject
CORPORATE_SYNC_TMA_CONFIRMATION=CONFIRM_TMA_reject
```

Esse exemplo confirma a política de rejeição, portanto continuará bloqueando chamadas fracionárias. Não habilitar escrita até o responsável escolher e confirmar a política, validar a identidade, aprovar origem/destino e concluir a homologação. Se o destino usar timestamp sem fuso, a confirmação temporal também é exigida no preflight. A configuração entregue mantém `ENABLED=false` e confirmações vazias.

O controle fica vinculado a endpoints, usuários, bancos, política TMA, fuso e versão do mapeamento/identidade. Trocar a senha não altera esse vínculo. Trocar política/destino depois de criar o controle causa `CHECKPOINT_BINDING_MISMATCH`. Não editar o vínculo nem apagar controle para contornar o bloqueio; primeiro reconciliar lote pendente e recibos com a configuração original, preservar evidência e planejar a mudança explicitamente.

## Schema e permissões

O preflight lê catálogos e exige tabela comum `raw.olos_calls`, PK não diferível exclusivamente em `internal_id_olos bigint`, campos textuais text/varchar compatíveis, TMA int4 e timestamp compatível. Antes de cada transação de destino, o schema é validado novamente sob lock que impede DDL incompatível com INSERT. Limites de varchar, NOT NULL, limites numéricos e precisão temporal são validados antes do envio.

Triggers, regras, RLS, constraints adicionais, índices únicos adicionais, domínio, colunas geradas, defaults/identity nas colunas transferidas e colunas extras obrigatórias/com default bloqueiam a escrita para revisão. Mesmo `kommo_*` obrigatório ou com default requer revisão: o módulo não presume o efeito desses defaults. Colunas extras anuláveis sem comportamento automático são permitidas. Nunca corrigir schema corporativo automaticamente.

O destino precisa somente de USAGE no schema e SELECT/INSERT na tabela; isso foi testado com papel sem UPDATE/DDL. A implementação não concede permissões. Se o papel real não tiver os privilégios necessários, registrar o bloqueio para o responsável pelo banco. A origem precisa SELECT em `raw.olos_calls` e acesso aos controles locais. Aplicar a migration local com identidade autorizada a criar o schema; o runtime usa SELECT/INSERT/UPDATE no controle e SELECT/INSERT nos recibos. Não conceder permissões novas no corporativo durante esta entrega.

## Comandos e Dokploy

Build independente, sem compilar/importar os outros módulos:

```bash
./node_modules/.bin/tsc -p tsconfig.corporate-sync.json
node --env-file=.env.corporate-sync dist/corporate-sync/cli.js check
node --env-file=.env.corporate-sync dist/corporate-sync/cli.js dry-run
```

| Comando | Efeito |
| --- | --- |
| `check` (padrão) | conecta aos dois bancos em transações READ ONLY; valida schema, destinos distintos e vínculo do controle se existente; não certifica aprovação nem todos os dados |
| `dry-run` | READ ONLY nos dois bancos; valida o próximo lote ou o pendente e compara com o destino; não migra, insere nem avança checkpoint |
| `migrate` | somente conexão local; aplica migration idempotente de controle, com lock; nunca conecta ao destino |
| `once` | um lote; exige confirmações e migration local prévia |
| `start` | processa lotes enquanto há backlog e aguarda o intervalo quando vazio; mesma autorização de `once` |

Dry-run cobre somente o próximo lote, limitado por `BATCH_SIZE` (ou o lote já congelado), e não constitui auditoria completa do histórico. Repeti-lo sem escrita mantém a mesma seleção. `audit-source.sql` fornece contagens agregadas locais para a análise completa de TMA/identidade, sem imprimir dados pessoais.

O arquivo `compose.corporate-sync.yaml` é **standalone**, não override do Compose operacional. No Dokploy, criar aplicação Compose própria usando esse arquivo e `Dockerfile.corporate-sync`, fornecer o arquivo de ambiente privado e conectividade às redes autorizadas. Não associar ao serviço de ingestão, não alterar seu comando e não publicar portas. Ajustar rede/CA via configuração do serviço independente.

Comandos para futura execução autorizada:

```bash
docker compose -f compose.corporate-sync.yaml build
docker compose -f compose.corporate-sync.yaml run --rm corporate-sync check
docker compose -f compose.corporate-sync.yaml run --rm corporate-sync dry-run
docker compose -f compose.corporate-sync.yaml run --rm corporate-sync migrate
docker compose -f compose.corporate-sync.yaml run --rm corporate-sync once
```

O comando padrão continua sendo `check`. Para operação contínua, definir `CORPORATE_SYNC_COMMAND=start` no ambiente de interpolação do Compose/Dokploy, além das confirmações no serviço. O arquivo `.env.corporate-sync` usado por `env_file` não altera sozinho a interpolação de `command`. `restart: "no"` evita loops automáticos em bloqueios. SIGTERM/SIGINT interrompem backoff/espera e impedem novos lotes; uma consulta ativa fica limitada pelo timeout. Antes do commit remoto, aborta com rollback; depois do commit confirmado, conclui o checkpoint local. Se houver SIGKILL/perda de conexão, o lote pendente permite replay.

## Recuperação e rollback

1. Persistir projeção do lote em `control.pending` e confirmar a transação local.
2. Abrir transação local e bloquear o controle; abrir transação SERIALIZABLE no destino.
3. Validar schema/identidade, inserir sem sobrescrever e verificar novamente os resultados.
4. Confirmar COMMIT corporativo.
5. Somente após sucesso, inserir recibos e avançar geração/contagem/último ID, limpar pending e confirmar tudo em uma única transação local.

Falha entre 4 e 5 mantém o lote original no banco local. No reinício, o mesmo lote é comparado com o corporativo; correspondência exata permite reconhecimento sem duplicar. Confirmação remota incerta segue esse mesmo protocolo de replay. Qualquer divergência bloqueia e preserva evidência, em vez de assumir sucesso. Não há promessa de transação distribuída atômica.

Falhas transitórias remotas de conexão, serialização, deadlock e lock podem tentar novamente com backoff limitado. Erros de schema, política, identidade e dados são terminais. Falha local termina o processo; não reconectar continuando uma execução que perdeu sua exclusividade. A próxima execução adquire novamente os locks e reconcilia o pending.

Para rollback operacional, parar **somente** o serviço corporate-sync, definir `ENABLED=false` e restaurar a imagem anterior se necessário. Preservar `corporate_sync.control`, `receipts`, backups e evidências. Não existe down migration automática: removê-los destrói o histórico de entrega. Não apagar chamadas corporativas nem tentar desfazer INSERTs automaticamente. Reversão de dados corporativos exige análise e autorização específica, fora deste módulo. Nunca limpar pending, alterar ID, pular erro ou avançar checkpoint manualmente para retomar.

Backup/restauração de origem, controle e destino deve ser coordenado. Se o destino for restaurado para um ponto anterior aos recibos, o serviço não detectará automaticamente as chamadas apagadas: interromper e reconciliar antes de retomar. Enriquecimentos corporativos nos campos transferidos de um pending tornam o replay divergente; preservar o bloqueio e investigar. Alterações em `kommo_*` não impedem replay.

## Homologação e observabilidade

```bash
./node_modules/.bin/tsc --noEmit
bash scripts/test-corporate-sync.sh
docker build -f Dockerfile.corporate-sync -t olos-corporate-sync:local-test .
```

O script cria PostgreSQL 16 descartável, dois bancos, rede Docker interna sem portas expostas e testes em Node 24. Não lê `.env`, `DATABASE_URL` ou credenciais operacionais. Remove container e rede ao terminar. INSERT/UPDATE/DDL/GRANT dos testes se restringem a esse ambiente sintético.

Antes de operação real: confirmar schema/permissões atuais em sessão autorizada, contagens de frações/identidades incompletas, política TMA, semântica temporal, tamanho do lote, custo das consultas e convivência com escritores existentes. A consulta de identidade composta pode exigir leitura extensa no destino sem índice adequado; nenhum índice é criado por esta entrega. Homologar volume, latência, locks, TLS, restauração coordenada e plano de retenção. Os testes descartáveis não comprovam esses aspectos corporativos.

Logs JSON incluem apenas horário, módulo, evento, contagens, tentativa e código fixo. Não incluem IDs de chamadas, hashes, URLs, SQL, erros brutos de PostgreSQL, CPF, e-mail, telefone ou credenciais. `batch_committed` só aparece após confirmação local; `existing` contabiliza reconhecimentos idempotentes. Após retry de commit incerto, `inserted` pode ser zero, pois representa a última tentativa confirmada. Um evento `checked` comprova somente o preflight descrito acima.

O lote pendente contém dados pessoais para permitir replay exato. Restringir acesso às tabelas/backup locais, criptografar armazenamento conforme a política existente e não exportar pending para logs/tickets. O recibo guarda apenas ID interno, hash e data; não é uma auditoria imutável contra manipulação administrativa. A entrega não altera permissões de bancos reais.
