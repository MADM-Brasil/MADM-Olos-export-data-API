# Laboratório local OLOS + PostgreSQL + Prisma

Ambiente independente para homologar baseline, identidade, normalização, persistência e recuperação. **Não consome OLOS e não oferece comandos `start`, `once`, previous, re-read ou reset.** Não carrega o `.env` da raiz nem usa `DATABASE_URL`. Usa apenas `LOCAL_DATABASE_URL`, limitado ao banco/usuário/host locais esperados.

O banco persistente foi criado e migrado nesta entrega. Ele permanece vazio, sem baseline de produção. Fixtures e benchmark usam outro banco, `olos_http_local_test`, dentro do mesmo container isolado. Nenhum dado corporativo foi importado.

## Auditoria antes das alterações

| Componente existente | Conclusão / reaproveitamento |
|---|---|
| Auth, HTTP, TLS por agente, cache | Já implementados; nenhum novo cliente HTTP ou política TLS foi criado |
| `src/api.ts` | Parser de array JSON com números exatos preservados como strings, reutilizado |
| `src/mapping.ts` | Mapeamento candidato e validação temporal reutilizados, sem novas fontes de negócio |
| `src/store.ts` | Adapter `pg` para destino corporativo; permanece separado do adapter local, sem dupla escrita |
| Controle atual | `reads` guarda resposta/progresso e `records` deduplica; não existe cursor remoto controlado por nós |
| Lock | Operação existente extraída para `src/source-lock.ts`, usada pelos dois adapters |
| Docker atual | Não provisiona banco; não foi convertido em ambiente de laboratório |
| Contrato real | Auth/catálogo/estáticas homologados antes; resposta HTTP transacional não disponível |

O plano foi apresentado na conversa antes das edições: quatro modelos locais, Prisma isolado em `local/package.json`, PostgreSQL sem portas, baseline explícito, normalização versionada, checkpoints atômicos, reprocessamento offline e testes. O banco antigo e as migrations corporativas não foram modificados.

O adapter local substitui o corporativo **neste fluxo de homologação**. Ambos nunca são chamados para gravar o mesmo lote. Prisma e seus scripts/dependências ficam somente no módulo local; o package.json/lockfile do runtime principal não recebeu Prisma. O adapter PostgreSQL do Prisma reutiliza um único pool `pg`; uma conexão mantém o lock e as outras executam as transações ORM. Consulte a [documentação Prisma sobre driver adapters](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/database-drivers).

## Contrato e significado do baseline

Não há amostra HTTP real de AttemptsRawData no checkout. Não é permitido obter uma nova nesta tarefa. Por isso:

- O esquema Prisma não fixa novos tipos/colunas de negócio corporativos. `NormalizedRecord.document` é JSON versionado, derivado do mapper já existente.
- O normalizador v1 é **candidato** até conferir uma amostra real já autorizada: array direto, identidade, StartDate/formato/fuso, valores opcionais e campos adicionais. `inspect-contract` valida um arquivo local e mostra somente tipos dos campos conhecidos, contagens e digest; não mostra registros.
- O JSONB de cada registro é a representação parseada; números ficam como strings para preservar precisão. O **texto integral original** permanece em `IngestionRun.responseBody`, inclusive para JSON inválido, permitindo auditoria exata e reprocessamento.
- A observação de IDs distintos em uma amostra não comprova unicidade/imutabilidade global. `contractOrigin=observed` registra a procedência declarada pelo operador, não uma prova automática ou autorização remota.

Baseline significa: **chamadas com StartDate igual ou posterior ao instante de corte**. Não significa “tudo que a API disponibilizou depois de agora”. Exige offset explícito, evidência do corte, evidência do escopo de identidade, origem da amostra e digest. Uma vez criado para `LOCAL_SOURCE_KEY`, é imutável. O fuso de datas sem offset também fica vinculado ao baseline.

Registros anteriores ao corte permanecem brutos e recebem uma normalização classificada como `before_baseline`; não são elegíveis para exportação corporativa. Não há descarte nem reset remoto. Se a regra desejada for data de disponibilidade/exportação, e não StartDate, esse contrato deverá ser confirmado antes de mudar a política.

Chegadas tardias são avaliadas pelo instante da chamada, **sem filtrar por maior ID visto ou por um high-water mark temporal móvel**. Uma chamada com ID menor que outro já recebido continua elegível se estiver no período do baseline. Uma chamada anterior ao baseline continua classificada como excluída mesmo se chegar tarde. Os endpoints HTTP não aceitam o nosso baseline como cursor: no futuro, aplicar essa seleção local pode exigir receber backlog antigo e preservá-lo. Não se promete pular backlog na origem sem consumi-lo.

## Modelos e transações

| Modelo Prisma | Função |
|---|---|
| Checkpoint | Baseline/evidências; contagem de identidades confirmadas; execuções completas e último run completo |
| IngestionRun | Resposta original, hash, estado, erro sanitizado, progresso e contagens |
| RawRecord | Identidade `(sourceKey, sourceId)`, hash do payload completo, JSONB e referência à resposta original |
| NormalizedRecord | Documento por `(rawId, version)` e classificação `eligible`/`before_baseline` |

Uma importação faz:

1. Exige baseline e lock de sessão por origem. Bloqueia novo arquivo se existir execução pendente diferente.
2. Persiste a resposta integral via Prisma antes de parse/normalização. Importar a mesma resposta é idempotente pelo hash.
3. Valida a resposta inteira. JSON, ID, data ou conteúdo divergente para o mesmo ID causam bloqueio e preservam a resposta para investigação.
4. Em transações de até `BATCH_SIZE=500`: insere brutos novos, documentos normalizados, progresso da execução e contagem confirmada do checkpoint. Commit perdido é reconciliado por essas mesmas linhas no reinício.
5. Só a transação final incrementa `completedRuns` e altera `lastCompletedRunId`. Uma falha na segunda transação mantém apenas a primeira confirmada; não marca toda a resposta como concluída.

Não há INSERT assíncrono individual por registro. `createMany` faz os lotes; o reprocessamento usa um UPSERT SQL parametrizado dentro da transação Prisma, pois Prisma não oferece `upsertMany`. Dados existentes com o mesmo ID e payload diferente são bloqueados, nunca sobrescritos silenciosamente.

O checkpoint é um **comprovante de persistência local**, não a PK máxima da OLOS e não o estado de leitura remoto. `committedRecords` inclui brutos classificados antes do baseline; elegibilidade é atributo da normalização. `lastCompletedRunId` não avança com um lote incompleto. Reprocessamento não altera checkpoint.

`internal_id_olos` fica NULL no documento local: o UUID técnico local não será usado como ID corporativo. As quinze demais colunas seguem o mapper existente. CPF, e-mail, TMA e demais fontes não confirmadas continuam NULL. IDs/telefone continuam texto e StartDate preserva microssegundos no JSON. Sem snapshot de referências fornecido ao adapter, os nomes ficam NULL; o adapter aceita o mesmo tipo `Cache` existente. Não armazena Users nem Password. A CLI não consulta referências remotamente.

## Inicialização

Executar da raiz do projeto. A primeira execução de setup gera senhas aleatórias próprias, arquivo `local/.env` com `0600` e diretório privado de entrada. **Não sobrescreve configuração existente.** Nesta entrega o setup já foi executado.

```bash
# Somente na primeira instalação:
node local/scripts/setup.mjs

docker compose --env-file local/.env -f local/compose.yaml up -d --wait postgres
docker compose --env-file local/.env -f local/compose.yaml build lab

# Migration exclusivamente local; não usar as migrations da raiz neste laboratório:
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab npm --prefix local run migrate

docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js status
```

O comando Prisma `migrate deploy` **aplica migrations no banco local**, não publica/deploya serviços. Seu config rejeita host/usuário/database diferentes dos alvos locais permitidos. Não executar Prisma com URLs corporativas nem contornar essa validação.

Rede `olos-exportdata-local_local-only` interna, sem portas publicadas. Volume `olos-exportdata-local_local-postgres` persistente. PostgreSQL tem healthcheck; o lab usa perfil manual, roda uma operação e encerra. O papel `olos_local` não é superuser nem pode criar databases; possui DDL somente no seu banco de laboratório para migrations. A senha administrativa e a senha da aplicação são diferentes.

O laboratório força `OLOS_TLS_VERIFY=true`, não injeta credenciais OLOS e não tem rota de consumo HTTP. A conexão PostgreSQL usa a rede Docker interna não publicada, independentemente de qualquer configuração TLS da OLOS. A imagem contém Prisma CLI/testes por ser exclusiva de homologação, não a imagem corporativa de produção.

## Baseline, importação e reprocessamento

Exemplo **sintético**, opcional, em fonte local `olos-local-fixture`. Não representa baseline OLOS real:

```bash
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js inspect-contract local/fixtures/sample.json
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js baseline local/fixtures/baseline.json
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js import local/fixtures/sample.json
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js resume
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js reprocess
```

Para dados reais **já capturados e autorizados**, colocar arquivos privados em `local/inputs/`, montado read-only como `/inputs`. Usar uma origem diferente da fixture e um plano real com `baseline`, `baselineEvidence`, `identityEvidence`, `contractOrigin` e `sampleFile` relativo ao plano. Não inventar a evidência nem copiar a conexão/estado do worker antigo. A CLI limita respostas a 32 MiB. Não colocar amostras pessoais no Git ou na imagem.

`resume` continua a resposta local pendente; não chama a OLOS. `reprocess` percorre os brutos em lotes e regenera documentos da versão de normalização atual. A versão identifica o algoritmo: para alterar regras, incrementar `NORMALIZATION_VERSION` e adicionar os testes correspondentes. Versões anteriores permanecem; repetir a mesma versão atualiza deterministicamente seu resultado, sem alterar payload original ou checkpoint. Corrigir dados inválidos não autoriza apagar pendências nem avançar o checkpoint manualmente.

## Inspeção e limpeza

```bash
docker compose --env-file local/.env -f local/compose.yaml ps
docker compose --env-file local/.env -f local/compose.yaml run --rm --no-deps lab node local/dist/local/src/main.js status

# Somente agregados; não exibe payloads:
docker compose --env-file local/.env -f local/compose.yaml exec -T postgres psql -X -U local_admin -d olos_http_local -c \
  "SELECT state,count(*) FROM local_olos.ingestion_runs GROUP BY state; SELECT version,disposition,count(*) FROM local_olos.normalized_records GROUP BY version,disposition;"

# Para parar preservando o volume e os dados:
docker compose --env-file local/.env -f local/compose.yaml down

# Limpeza DESTRUTIVA somente deste laboratório, quando seus dados não forem mais necessários:
docker compose --env-file local/.env -f local/compose.yaml down --volumes
```

Não execute `down --volumes` em outro Compose nem apague checkpoint/marcadores isoladamente. Não removi o volume ao finalizar: o PostgreSQL local fica disponível. Exportar backup privado antes de limpar dados que precisem de auditoria. O banco de fixtures `olos_http_local_test` também reside nesse volume, mas não é o banco de homologação principal.

## Testes e desempenho

```bash
# Após qualquer alteração no módulo:
docker compose --env-file local/.env -f local/compose.yaml build lab
bash local/scripts/test.sh

# Desenvolvimento local, Node 24:
npm ci --prefix local
npm --prefix local run generate
npm --prefix local run validate
npm --prefix local run typecheck
npm --prefix local run build
```

O runner cria/migra `olos_http_local_test` no PostgreSQL isolado. A suíte recusa executar os testes de escrita no banco principal. Antes de cada teste remove somente fixtures do banco de teste. A suíte original continua em `npm test` e `bash scripts/test-integration.sh`.

Resultados e limites estão em [performance.md](performance.md). Cobertura: baseline imutável, dados anteriores e tardios, grandes IDs, duplicatas, JSON/datas inválidas, conteúdo divergente, falha parcial, reinício, perda de ACK de commit, concorrência, checkpoint e reprocessamento. Nenhum teste solicita dados à OLOS.

## Próxima etapa e transferência corporativa

Esta entrega prepara e executa a **homologação offline**. A aquisição HTTP incremental não foi ligada ao módulo local: os comandos de polling/consumo são rejeitados, há bloqueio de rede e não há credenciais OLOS. O contrato transacional real e o baseline real continuam pendentes. Para ativar aquisição futura, será necessário conferir amostra autorizada, escolher baseline/identidade/fuso e conectar o leitor existente ao adapter local, mantendo intenção durável antes do HTTP e tratamento de resultado remoto incerto. Não basta trocar uma flag para alegar que essas garantias foram provadas.

Plano futuro de transferência, sem executar nenhuma escrita corporativa agora:

1. Auditar novamente destino, constraints, geração do ID, tipos temporais e campos obrigatórios. Confirmar as fontes que hoje recebem NULL e a baseline do histórico já existente.
2. Congelar a versão de normalização e selecionar somente `eligible`, registrando origem, baseline, IDs, hashes e contagens em um manifesto privado. Não exportar `before_baseline` por acidente.
3. Usar o adapter corporativo existente após sua homologação, em lotes parametrizados. Destino gera `internal_id_olos`; não copiar UUID local nem equipará-lo automaticamente ao ID OLOS.
4. Marcador corporativo e escrita devem ser atômicos. O hash local cobre todo o payload, enquanto o adapter atual calcula hash das colunas conhecidas: reconciliar explicitamente essas duas finalidades, não copiar hashes entre contratos diferentes.
5. Comparar identidade/contagem/hashes, provar repetição idempotente e registrar recibo de transferência antes de considerar o lote migrado. SSE, filas ou serviços novos não são necessários.
6. Só então solicitar autorização para uma leitura real controlada e, separadamente, para polling. O lock PostgreSQL coordena apenas processos no mesmo banco/chave; coordenar operacionalmente worker antigo e outros consumidores. Nem o checkpoint local nem o lock garantem atomicidade entre OLOS e banco.
