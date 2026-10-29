# Homologação: integração e persistência — 28/10/2026

## Conclusão

A configuração corporativa do **novo worker não está disponível** neste checkout/ambiente: não há `.env`, `DATABASE_URL` exportada ou credenciais HTTP. O `.env.example` é apenas um modelo. Nenhum container do novo worker está em execução. A conexão privada e o manual HTTP foram solicitados; não foram recebidos durante esta auditoria.

Foi revalidado o banco local acessível do projeto antigo, **sem presumir que ele seja o destino corporativo**. Nenhuma escrita, migration, chamada OLOS real, commit, push ou deploy foi executado. O worker antigo não foi alterado. Testes com DDL/DML foram restritos a um PostgreSQL novo e descartável.

## Evidência PostgreSQL atual

Alvo local: container `olos-worker-postgres`, database `olos_worker`, tabela `raw.olos_calls`. Sessão `BEGIN TRANSACTION READ ONLY`, `statement_timeout=10s`, `transaction_read_only=on`, encerrada com `ROLLBACK`. Foram consultados metadados e agregados, sem exibir linhas ou dados pessoais. A sessão administrativa local não comprova permissões de um futuro papel corporativo de runtime.

| Coluna exigida | Tipo observado | Resultado |
|---|---|---|
| internal_id_olos | bigint NOT NULL, PK | Tipo correto; **sem default/identity/sequence** |
| olos_call_id | text NULL | Compatível |
| data_ligacao | timestamp(6) without time zone NULL | **Não é timestamptz** |
| telefone | text NULL | Compatível |
| nome_agente | text NULL | Compatível |
| id_campanha_olos | text NULL | Compatível |
| nome_campanha_olos | text NULL | Compatível |
| id_tabulacao_olos | text NULL | Compatível |
| nome_tabulacao_olos | text NULL | Compatível |
| cpf | text NULL | Compatível com NULL, fonte pendente |
| lead_id_origem | text NULL | Compatível com NULL, fonte pendente |
| tma_origem | integer NULL | Diferente do numeric sugerido; **NULL atual é compatível** |
| razao_desligamento | text NULL | Compatível com NULL, fonte pendente |
| email | text NULL | Compatível com NULL, fonte pendente |
| raw_olos_call_id | bigint NULL | Diferente do text sugerido; **NULL atual é compatível** |
| telefone_match_key | text NULL | Compatível com NULL, regra pendente |

As 16 colunas existem, sem colunas extras. A ordem é diferente do PRD, mas os INSERTs nomeiam as colunas: isso não bloqueia a integração. Há somente PK/índice único em `internal_id_olos`, sem triggers de usuário, sem RLS, sem colunas generated/identity. `pg_get_serial_sequence(...)` retornou NULL. Os controles `olos_http.reads` e `olos_http.records` não existem neste banco.

Agregados: 570 linhas, 570 IDs internos distintos, zero CallId NULL e zero grupos de CallId repetidos nessa amostra. **Esses números não comprovam unicidade global de CallId nem de AttemptsRawDataID por HTTP.**

### Correções mínimas de persistência, condicionadas ao destino confirmado

1. **ID:** o código exige a sequence/identity do destino para reservar IDs e relacioná-los ao marcador. Nesse banco, falharia com `DESTINATION_ID_GENERATOR_REQUIRED`. Confirmar primeiro o significado e os escritores existentes. Se o ID deve ser local, o DBA pode aprovar geração compatível e coordenada com o histórico; não usar `max(id)+1` a cada insert nem reaproveitar automaticamente AttemptsRawDataID. Uma sequence adicionada sem coordenar o escritor antigo pode colidir com IDs que ele ainda produzirá. Nenhum DDL foi proposto como executável automático.
2. **Data:** o código exige timestamptz. `timestamp without time zone` não identifica um instante por si só; `SET TIME ZONE UTC` não resolve a semântica do histórico. Confirmar fuso da origem e significado do destino. A menor adaptação possível, se o contrato corporativo exige manter timestamp local, é uma conversão explícita para o fuso aprovado no adapter e no preflight, com teste de instante/hora local. Alternativamente, uma conversão de coluna exige análise e aprovação do DBA sobre todos os consumidores. **Não remover o guard nem fazer cast implícito.**
3. **Dedup/baseline:** o marcador novo usa `(source_key, AttemptsRawDataID)`, separado de `internal_id_olos`, atomicamente com a gravação. Isso está validado em PostgreSQL descartável. No alvo local há histórico e nenhum marcador: após os dois bloqueios anteriores, ainda seriam necessários controles e baseline comprovada dos 570 registros, incluindo origem/ID/hash. Não fabricar marcadores por CallId ou por igualdade presumida de IDs. Se este não for o destino escolhido, inspecionar o destino correto antes de qualquer decisão.
4. **Sem alteração necessária hoje:** `tma_origem` integer e `raw_olos_call_id` bigint aceitam os NULLs atuais. Não migrar esses tipos apenas para igualar a sugestão do PRD. Os sete campos sem fonte continuam sem fonte; todas essas colunas são anuláveis no alvo observado.

## Contrato OLOS: o que foi e não foi comprovado

Manual disponível: `/home/madm/worker-olos-export-data/docs/reference/olos-exportdata-v3.pdf`, 33 páginas, SHA-256 `db4f934af564f0e5a3bb244cdb056e50e8b294dfcf6f94c25d14987ee95c1b71`.

O documento descreve **procedures SQL**, não o contrato WebApiExportData. Página 4: ReadData de tabela estática. Páginas 16–17: AttemptsRawData, referências AgentId/CampaignId/DispositionId, StartDate datetime e AttemptsRawDataID como PK. Página 30: Users estática, UserId, AgentId e UserName. Isso sustenta o significado dos campos, mas não prova formato JSON, OAuth, parâmetros HTTP ou garantias de consumo da instalação atual.

| Operação | Implementação | Evidência / pendência |
|---|---|---|
| Auth inicial | POST `/api/auth`, multipart, cinco campos do PRD | Conforme PRD; não documentado no PDF SQL |
| Renovação | Mesmo endpoint, grant refresh_token, refresh_token/client_id/client_secret | Fluxo testado localmente; confirmar contrato HTTP real |
| Authorization | Bearer token; expires_in real; retry único de 401 | Conforme PRD e mocks |
| available-tables | GET; exige TableName e colunas | Envelopes aceitos são **candidatos**, ainda não observados por HTTP |
| Estáticas | POST `/api/export-data/read-data`, multipart TableName | Tabelas/semântica SQL conhecidas; envelope HTTP array direto pendente |
| Current/previous/reread | Rotas e parâmetros do PRD | Revisados no código; nenhuma chamada real executada |
| Reset | Não implementado | Nenhuma chamada executada |

Não foi encontrado manual HTTP oficial utilizável na busca pública. A lista/forma exata do catálogo, rotação real de tokens, 401/429 sem avanço de consumo, unicidade entre dias e recuperação HTTP permanecem pendentes. O manual declarar uma PK SQL não comprova estabilidade global após rollover/retenção nem atribuição de recuperação por consumidor.

### Correção local comprovada

A versão instalada do Undici tem um caminho de retry implícito para 421 em `fetch` quando o corpo é reproduzível. O teste local original recebeu **uma requisição** e devolveu `NETWORK_OR_RESPONSE_FAILURE` em vez de `HTTP_421`. Não há prova de dois POSTs nem de duplicação em produção.

`src/http.ts` agora codifica o mesmo multipart, envia um stream de uso único com Content-Type/Content-Length explícitos e impede essa repetição interna para POST. O teste confirma uma requisição e preservação de `HTTP_421`; o controle de retries continua no OlosApi. O comentário do catálogo foi corrigido para não chamar um formato candidato de documentado. Nenhuma regra de destino ou contrato de negócio foi afrouxada.

## Segurança do comando check

No Compose, `WORKER_COMMAND=check` é interpolado para `node dist/main.js check`. `main.ts` retorna logo após `Store.open()`, **antes** de construir o cliente HTTP. `open()` executa metadados/SELECTs, lock consultivo de sessão e `SET TIME ZONE`; não executa INSERT/UPDATE/DDL/nextval nem consome OLOS. O lock é liberado ao fechar a conexão.

Teste novo com o executável compilado, PostgreSQL configurado com `default_transaction_read_only=on` e servidor HTTP sentinela: sucesso, **zero requisições HTTP**, zero linhas criadas nas três tabelas e sequence não utilizada. Isso verifica comportamento com esquema válido; não prova que o esquema corporativo desconhecido passará no preflight.

**Distinção operacional:** `WORKER_COMMAND` é variável de interpolação do Compose, não seletor lido por `main.ts`. `npm start` e o CMD padrão do Docker executam `start`. Para homologação fora do Compose, passar o argumento `check` explicitamente; somente definir a variável de ambiente não muda esses comandos.

## Testes HTTP não transacionais preparados

`scripts/homologate-http.mjs` reutiliza o transporte/auth existentes e limita as requisições a:

1. POST auth com password; invalidação apenas local do access token e uma tentativa de refresh.
2. GET available-tables.
3. POST read-data somente para Disposition, Campaign e Users, nessa ordem.

Não conecta ao PostgreSQL, não escreve no destino, não salva respostas e não oferece parâmetro para escolher outra tabela/endpoint. Não chama current-day/previous-days/re-read/reset/log-read. Saída: resultados, contagens, campos esperados ausentes e IDs de referência ambíguos. Nenhum valor de registro, token, senha, nome ou campo Password de Users é impresso. Um array vazio é válido, mas não comprova o layout de linhas; o relatório marca `layout_observed=false`.

O script foi validado com servidor local: exatamente password, refresh, catálogo e as três estáticas. O teste verifica ausência de tokens, senhas e nomes na saída. **Não foi executado contra OLOS real por falta de configuração.** Autenticação pode emitir/rotacionar tokens na API; o teste é não transacional quanto ao consumo de dados, não uma promessa de zero estado no serviço de identidade.

## Comandos de homologação

Os caminhos `/caminho/privado/...` abaixo devem apontar para configuração autorizada fora do Git; nunca colar credenciais no terminal/log. A inspeção é somente leitura e o teste HTTP não tem endpoints transacionais.

```bash
nvm use
npm run typecheck
npm run build
npm test
bash scripts/test-integration.sh

# Configuração: DATABASE_URL, OLOS_SOURCE_KEY e destino real.
node --env-file=/caminho/privado/worker.env dist/main.js inspect-schema /caminho/privado/schema-homologacao.json
node --env-file=/caminho/privado/worker.env dist/main.js check

# Somente OLOS_BASE_URL/USERNAME/PASSWORD/CLIENT_ID/CLIENT_SECRET; não precisa de DATABASE_URL.
node --env-file=/caminho/privado/olos-http.env scripts/homologate-http.mjs
```

O teste HTTP pode ser executado independentemente de o preflight PostgreSQL passar. Não usar `reconcile-names` como teste estático: esse comando também escreve no destino. Não usar `once` para testar autenticação: ele consome AttemptsRawData.

Para serviço Compose já existente e autorizado, o equivalente explícito é `docker compose run --rm --no-deps worker node dist/main.js check`; nenhuma execução desse comando ou deploy foi feita nesta auditoria. O script HTTP está no checkout, não é um comando do runtime Docker.

## Sequência mínima para produção

1. Fornecer a conexão privada do **destino correto**, a configuração HTTP e o manual HTTP/Swagger. Repetir somente inspeção e teste estático nesse ambiente. Resolver apenas divergências efetivamente observadas.
2. Definir a geração do ID interno e a semântica temporal sem quebrar o histórico/escritores. Aprovar separadamente qualquer DDL necessário; esta auditoria não o executa. Confirmar permissões do papel de runtime.
3. Validar origem/identidade global, provisionar controles e baseline comprovada onde houver histórico, sob autorização específica. Coordenar um único consumidor efetivo; o advisory lock do novo worker não controla o antigo nem consumidores em outro banco.
4. Exigir preflight e testes estáticos aprovados. Ajustar o parser do catálogo somente se o formato real exigir; não adivinhar wrappers. Confirmar recuperação e atribuição de faixa com a OLOS.
5. Obter autorização explícita para uma primeira leitura transacional controlada. Conferir persistência e dedup antes de autorizar polling. A ativação contínua, backfill e testes remotos de recuperação não estão autorizados nesta etapa.

Validação desta auditoria: **40 testes aprovados (19 unitários/HTTP + 21 integração PostgreSQL), typecheck e build aprovados**. Os três testes novos cobrem 421, check sem HTTP/DML e homologação estática sem exposição. Nenhum teste comprova o contrato corporativo ausente.
