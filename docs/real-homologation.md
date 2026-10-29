# Homologação HTTP real — 28/10/2026

## Resultado

Autenticação, renovação de token, catálogo e as três tabelas estáticas passaram **contra a API real configurada**, com `OLOS_TLS_VERIFY=false` explicitamente autorizado nesta tarefa. Nenhuma chamada transacional foi feita. PostgreSQL permanece bloqueado por falta de `DATABASE_URL`.

| Operação | HTTP | Duração | Resultado |
|---|---|---|---|
| POST auth, password | 200 | 2818 ms | JSON objeto; access_token e refresh_token presentes; expires_in=3599 |
| POST auth, refresh_token | 200 | 358 ms | JSON objeto; access_token e refresh_token presentes; expires_in=3599 |
| GET available-tables | 200 | 59 ms | Parser existente aceitou o catálogo; quatro tabelas e colunas exigidas presentes |
| POST read-data Disposition | 200 | 109 ms | Array JSON, 126 registros |
| POST read-data Campaign | 200 | 39 ms | Array JSON, 51 registros |
| POST read-data Users | 200 | 50 ms | Array JSON, 588 registros |
| PostgreSQL check | Não aplicável | Não houve conexão | CONFIG_REQUIRED_DATABASE_URL |

As três estáticas apresentaram zero registros sem as propriedades exigidas e zero IDs com nomes divergentes para os mapeamentos avaliados: DispositionId → Description, CampaignId → Description e AgentId → UserName. CampaignCode e UserId também estavam presentes. O resultado comprova o formato do catálogo aceito pelo código, não o comportamento de leituras transacionais, a unicidade entre dias ou a completude de recuperação.

Foram descartadas por projeção imediata todas as colunas não necessárias das estáticas, incluindo Password de Users. Não foram impressos valores de registros nem tokens, nem salvos corpos HTTP. As únicas saídas da homologação foram status, durações, contagens e indicadores de formato. Tokens ficaram apenas em memória até o encerramento do processo.

## TLS e Postman

A falha anterior foi `ERR_TLS_CERT_ALTNAME_INVALID`: o endereço configurado é um IP; o certificado apresenta dois SANs DNS e nenhum SAN IP. Na inspeção anterior a validade temporal estava vigente. Nesta execução a validação normal novamente confirmou incompatibilidade de identidade.

Um SAN é wildcard; o outro não resolveu para o IP configurado na verificação efetuada. Nenhum hostname oficial dessa API foi confirmado por evidência independente. Não foi inventado um hostname a partir do certificado nem alterado o destino da requisição.

Foram localizados perfis do Postman no Linux e no Windows e inspecionadas configurações legíveis. Não foi localizada evidência conclusiva da opção SSL certificate verification aplicada à requisição usada pelo usuário. **Seu estado no Postman permanece indeterminado.** HTTP 200 não demonstra que o Postman validou ou deixou de validar o certificado. A [documentação oficial do Postman](https://learning.postman.com/latest-v-12/docs/getting-started/installation/settings/general-settings) descreve a opção; a configuração efetiva da requisição deve ser conferida no aplicativo.

A alteração foi restrita ao `Agent` particular de `HttpTransport`: `connect.rejectUnauthorized` recebe a configuração explícita. O padrão permanece `true`; valores diferentes das strings `true`/`false` são rejeitados. Com `false`, o aviso JSON `olos_tls_verification_disabled`, nível `warn`, escopo `OLOS_HTTP_ONLY`, é emitido ao criar o agente.

Configuração efetiva nesta homologação: **false**. Isso desabilita validação de cadeia/validade/identidade do certificado apenas nesse agente, não apenas a checagem do IP. Não foi configurado `NODE_TLS_REJECT_UNAUTHORIZED`, não foi modificado o dispatcher global nem o cliente PostgreSQL. Teste com HTTPS local comprova que o agente OLOS com exceção conecta, o agente padrão rejeita e outro cliente HTTPS continua validando.

## Organização das configurações

- Credenciais que estavam preenchidas em `.env.example` foram movidas para `.env`, com modo `0600`, ignorado por Git e Docker build context. Nenhuma credencial foi impressa.
- `.env.example` agora contém placeholders para credenciais/URL e defaults não sensíveis, incluindo `OLOS_TLS_VERIFY=true` e `WORKER_COMMAND=check`.
- `.env` usa `OLOS_TLS_VERIFY=false` explicitamente para esta homologação, com comentário de escopo, e `WORKER_COMMAND=check`.
- O Compose lê `.env` para interpolação e agora repassa `OLOS_TLS_VERIFY`. A validação da composição confirmou comando `check`, opção TLS false e presença das cinco configurações OLOS. Foi usado um DATABASE_URL sintético **somente para resolver a configuração Compose**, sem conectar ou iniciar serviços; não é configuração de banco real.
- `DATABASE_URL` real continua vazia. Não foi copiada a conexão do worker anterior. A tentativa de `check` encerrou antes de conectar.

As credenciais estiveram em arquivo versionável: **tratá-las como potencialmente expostas e recomendar rotação das senhas/client secrets aplicáveis e revogação de tokens conforme suporte da OLOS**. O checkout não apresenta commit rastreando esses arquivos; isso não prova ausência de cópias, compartilhamentos ou exposição fora deste Git. Rotação não foi executada automaticamente.

## Validação e limites

- Typecheck e build aprovados.
- 42 testes aprovados: 21 unitários/HTTP/TLS e 21 integração com PostgreSQL descartável.
- Novos testes validam default TLS seguro, rejeição de configuração inválida, aviso explícito, exceção por agente e isolamento dos demais clientes.
- Comando real executado: `node --env-file=.env scripts/homologate-http.mjs`.
- Comando PostgreSQL tentado: `node --env-file=.env dist/main.js check`; falhou por configuração ausente. Não há evidência nova de compatibilidade do destino corporativo.
- Nenhuma chamada current-day, previous-days, re-read ou reset; nenhum polling, migration corporativa, alteração no worker antigo, commit, push ou deploy.

## Bloqueios para primeiro consumo transacional

1. Informar a conexão privada do PostgreSQL correto e inspecionar as 16 colunas, constraints, índices, geração do ID, timezone e permissões exclusivamente em leitura. Não extrapolar o banco local legado para o destino corporativo.
2. Resolver incompatibilidades que forem confirmadas, sem DDL automático. Preparar controles e baseline comprovada se houver histórico, sob autorização separada.
3. Confirmar unicidade/estabilidade de AttemptsRawDataID, exclusividade de consumo e procedimento oficial para recuperação de resultado remoto incerto. O catálogo estático não prova essas garantias.
4. Preferir hostname/certificado válidos para retornar a `OLOS_TLS_VERIFY=true`. A exceção atual foi explicitamente autorizada; não foi feita uma troca silenciosa de política.
5. Obter autorização explícita para a primeira leitura transacional controlada. O polling permanece desativado.
