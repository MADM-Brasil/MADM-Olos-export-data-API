# Autoridade corporativa v2 — candidata, sem aprovação de publicação

## Diagnóstico e limites da evidência

A auditoria fornecida pelo operador registra 696 colisões, todos os IDs já ocupados no MADM, identidades diferentes, allocator `legacy`, 57.208 confirmações e 1.162 pendências. A reversão `138fd602-7838-4662-bc48-04fe71746979` foi informada como `completed`, envolvendo 12.270 registros. São números desse snapshot informado, não uma consulta atual realizada nesta implementação. Autoria dos registros históricos, `validated_at` da reversão e compatibilidade de outros produtores não foram presumidas.

O código anterior atribui `records.target_id`/`outbox.target_id` por `nextLegacyId()` quando o allocator está ausente, em legacy ou em reversão. O lock e a busca de ocupação são locais; não reservam esse número no MADM. O destino usa o número como `internal_id_olos`, independente de `raw_olos_call_id`, que é outra identidade. Isso explica o mecanismo de reutilização demonstrado pela auditoria. Ele não comprova quem produziu as chamadas que ocupavam esses IDs.

O registry anterior protege o número, mas não registra a identidade lógica inteira. Sua chave de idempotência por role/binding/source_id não impede duas solicitações diferentes de reservar números distintos para a mesma chamada. A guarda anterior também não cobre alterações isoladas das colunas de identidade. O contrato v2 fecha esses caminhos sem alterar a comparação dos payloads de entrega.

## Contrato único

`allocationPolicy()` é a decisão única para IDs novos: legacy/adopting apenas admitem na fila durável; active pode reservar; ausência de preparação ou estado reverting bloqueiam. Nenhum caminho executa `nextval()` para novos IDs corporativos. O entrypoint antigo `nextLegacyId` recusa a operação. O comando de reversão conserva leitura/idempotência de uma reversão já concluída enquanto ainda legacy, mas não materializa outra reversão.

O fluxo é o existente: captura/streaming → `corporate_id_admissions` com UUID/hash → reserva no MADM → `corporate_id_assignments` + records + outbox, na transação local → comparação/INSERT remoto → COMMIT remoto reconhecido → recibo local. Captura não conecta ao MADM. Pausa, bloqueio e backoff agora impedem também novas reservas/materializações; admissions continuam duráveis. Não há outro scheduler ou caminho de entrega.

A migration corporativa 002 usa o mesmo `counter`, `registry`, função `reserve` e trigger. `identities` é o índice de identidade dessa autoridade, não outro alocador. A chave lógica continua sendo `olos_call_id`, `data_ligacao`, `telefone`, `id_campanha_olos`, convertidos pelos tipos SQL do destino; timestamptz é canonizado em UTC. O SHA-256 indexa a chave e o JSON completo é conferido para não aceitar uma colisão de hash como equivalência. Timestamp sem zona continua usando a projeção e a confirmação de zona existentes.

Identidades históricas repetidas são registradas uma única vez em `identities`, com `ambiguous_raw_ids` contendo todos os membros ordenados. Nesse registro não há `internal_id`, `used_raw_id` ou proprietário escolhido. O `registry` continua ocupando cada ID não nulo, inclusive todos os IDs de um grupo ambíguo; linhas com ID nulo permanecem preservadas. Nenhuma linha de `raw.olos_calls` é alterada pelo bootstrap. O snapshot mais recente informado pelo operador contém 95.264 linhas, 94.958 IDs preenchidos distintos, 306 IDs nulos e 6.751 pares de identidades repetidas; esses números não foram consultados em produção.

Reserva, registro histórico, reconhecimento e INSERT dependentes de uma identidade ambígua falham com `AMBIGUOUS_LOGICAL_IDENTITY` (`P3110`). O matching consulta a mesma autoridade por `assert_unambiguous(jsonb)` antes de comparar candidatos. O marcador permanece mesmo se um escritor remover um membro: não há resolução automática ou escolha de principal. Identidades distintas continuam usando a reserva existente. Se o histórico do próprio worker depender de um desses grupos, a readoção fica bloqueada; a instalação do schema, por si só, não resolve esse vínculo nem autoriza alterar recibos ou quarentenas.

Collations não determinísticas nas colunas de identidade são recusadas na instalação e na verificação do contrato: sua igualdade SQL pode divergir da igualdade dos valores JSON. A prontidão da captura corporativa verifica o contrato local antes de consumir uma chamada; a integração HTTP e o scheduler permanecem os existentes.

A reserva grava identidade, origem, source_id, hash de origem, request UUID, ID e token. Há unicidade de `(source_key,source_id)`, identidade e ID. Origem, binding, role, hash, UUID ou identidade divergentes impedem replay. O contador transacional e as constraints arbitram o acesso; não há `MAX(id)+1`, ajuste de sequência ou uma consulta de disponibilidade separada da reserva. O algoritmo percorre lacunas reais do registry e nunca reutiliza uma reserva confirmada.

O trigger participa da mesma ordem de locks para INSERT/COPY de outros produtores, inclusive IDs explícitos. Ele exige o token correto e a identidade correspondente para consumir uma reserva. Registros existentes não têm ID/identidade modificados por essa implementação. Alterar essas colunas após a instalação é recusado; atualizações de outros campos continuam sujeitas ao contrato já existente. Identidades completas com ID NULL também ficam registradas e impedem criar a mesma chamada sob outro ID. Exclusão por outro produtor deixa o registry ocupado: não libera números automaticamente.

## Escritores externos: condição de ativação

É obrigatório inventariar roles, permissões, INSERT, COPY, UPSERT, UPDATE de IDs/identidade, jobs de importação e replicação. Role de aplicação não pode ser dona das tabelas/funções nem poder desabilitar triggers, alterar o registry/counter/identities ou elevar privilégios. O trigger é ALWAYS, mas superusuário/owner ou outro agente autorizado a mudar DDL pode contornar o contrato. O software não prova a ausência desses agentes.

INSERT explícito em ID livre continua possível e fica registrado atomicamente. ID reservado/ocupado e identidade já registrada geram erro; UPSERT que dependia de passar pelo INSERT conflitante pode falhar antes de chegar ao UPDATE. Atualização de identidade/ID é incompatível com este contrato. Não adaptar esses escritores silenciosamente, não desligar o trigger para acomodá-los. Homologar cada escritor ou manter a publicação bloqueada. Sem essa prova não declarar o ambiente livre de colisões ou compatível com todos os produtores.

## Pendências, quarentena e reversão anterior

A readoção existente valida o predecessor, sua reversão, manifestos, batches, hashes e a validação administrativa persistida. `completed` isoladamente não basta. A geração nova tem UUID próprio; não reativa a adoção antiga. A barreira de geração e o registro histórico por lotes continuam protegidos pelos locks 5/6/8 e pelos triggers da 011. Admissions novas podem aguardar sem IDs antes da barreira; não pertencem ao manifesto fechado da reversão antiga.

Para os registros antigos, há tratamentos explícitos:

| Categoria comprovada | Tratamento |
| --- | --- |
| Confirmado, payload e raw ID remoto exatos | Preservar ID/recibo; registrar o vínculo histórico sem reentregar. |
| Pendente, ID livre e identidade ausente | Reservar atomicamente o ID já congelado; entregar pelo fluxo existente. |
| Colisão formalmente em quarentena | Preservar todos os dados e a exclusão; registro legacy com token NULL não é posse do ID remoto. |
| Identidade histórica ambígua | Preservar todos os membros e IDs; bloquear reconhecimento, reserva e entrega, inclusive registro histórico isolado. |
| Identidade em outro ID, divergência de payload, referência incompleta ou outro caso sem prova | Bloquear e exigir decisão/reconciliação específica, sem remapeamento. |

Os 696 itens informados permanecem isolados. As guardas atuais congelam records, outbox, assignments, manifestos de reversão e quarentena. Não existe evidência suficiente aqui para provar que todas as referências formais e informais podem ser remapeadas, nem para escolher outra representação de uma identidade já existente. Por isso não foi implementado um remapeamento especulativo. O relacionamento original source_id → target_id, os hashes e a evidência de colisão permanecem íntegros. Esta limitação é deliberada; a correção não promete entregar automaticamente esses 696 itens.

Reutilizar `corporate-verify-pending`, `corporate-quarantine-collisions` e `corporate-recover-collision` para diagnóstico, isolamento explícito e liberação da fila comprovadamente consistente. Eles mantêm verificação por digest, idempotência por UUID e COMMIT incerto. Uma reserva de ID histórico que não pertença à mesma chamada nunca remove uma quarentena nem gera recibo.

## Pré-requisitos e publicação — somente procedimento futuro

1. Aprovar integrações PostgreSQL completas, incluindo as fixtures antigas que ainda pressupõem alocação legacy. Confirmar Node 24/PostgreSQL 16 e dimensionar o volume. Não publicar apenas porque o build passou.
2. Inventariar/homologar os escritores e seus privilégios. Identificar exatamente os bancos, roles e serviço `admin` da implantação Dokploy; não criar outra instância coletora. Confirmar backups restauráveis do local e MADM, incluindo spool, journals, outbox e ledgers.
3. Pausar Corporate Delivery e parar o scheduler pelo controle existente; aguardar requisições e transações em voo terminarem. Não matar uma transação remota como prova de rollback. Registrar snapshots de IDs, hashes, contadores, receipts, quarentenas, predecessor e manifestos.
4. No local, confirmar 008–011 e a reversão `completed`, `validated_at`/digest e evidência de recuperação correspondente. Se incompletos, usar o procedimento administrativo anterior antes de instalar a autoridade remota; não preencher a prova por SQL manual. Nenhuma generation antiga pode estar ativa. Validar os 696 itens pelo ledger, não pelo número informado.
5. No MADM, confirmar ausência de `olos_delivery_ids`. A 002 é instalação completa e atômica; **não aplicar 001 antes dela**. Se já houver namespace/autoridade, inclusive após ACK perdido de uma migration, parar e inspecionar o contrato. Não apagar reservas ou tentar reaproveitar uma autoridade v1 desconhecida.
6. Aplicar, em janela autorizada, `migrations/014_corporate_authority.sql` no banco local e `migrations/corporate/002_identity_authority.sql` no MADM. São transações com pré-condições explícitas e sem reaplicação silenciosa. Não executam UPDATE de IDs corporativos. A 002 bloqueia escritores durante a indexação e registra grupos históricos ambíguos sem escolher um membro nem liberar seus IDs. Uma instalação anterior da candidata 002 tem outro contrato/hash: não reaplicar esta migration ou reescrever hashes congelados para atualizá-la; manter a entrega parada até existir um procedimento de atualização validado. A 014 mantém o bloqueio local mesmo se um binário antigo tentar atribuir IDs.
7. Conceder somente os privilégios necessários. No local, SELECT da nova `corporate_authority_contract`, mantendo os privilégios existentes. No MADM, USAGE do schema e EXECUTE em `reserve(text,jsonb,boolean)` e `assert_unambiguous(jsonb)` ao role da entrega. Não conceder DML nos ledgers de autoridade nem EXECUTE público. A instalação das funções e tabelas precisa usar o mesmo owner administrativo. Manter o processo parado até concluir DDL e grants.
8. Disponibilizar a versão revisada no mesmo serviço, por publicação separadamente autorizada. A captura pode voltar a admitir sem IDs quando o contrato local estiver validado, mas a entrega fica pausada até a readoção completar. Não reverter a captura histórica ou suas autorizações para liberar esse processo.

Usar URIs sem senha e `PGPASSFILE` privado (0600), explicitando `--dbname` e `ON_ERROR_STOP`. Não colocar uma URI apenas em `PGDATABASE`. Os comandos abaixo são exemplos não executados:

```sh
psql --dbname="$LOCAL_URI_SEM_SENHA" -X -v ON_ERROR_STOP=1 -f migrations/014_corporate_authority.sql
psql --dbname="$MADM_URI_SEM_SENHA" -X -v ON_ERROR_STOP=1 -f migrations/corporate/002_identity_authority.sql
```

## Ativação e reinício

Preservar source/binding, UUID novo e referência real de evidência. Gerar o UUID uma vez, guardá-lo e reutilizar exatamente a mesma requisição nas retomadas. O consentimento de continuidade de captura é um contrato separado, não uma autorização de entrega ou de mudança de IDs.

```sh
export OLOS_CORPORATE_READOPTION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION
export OLOS_CORPORATE_READOPTION_ACTIVATION_CONFIRMATION=AUTHORIZE_CORPORATE_ID_READOPTION_ACTIVATION
node dist/main.js corporate-prepare-id-readoption --confirm-source olos-production --request-id "$REQUEST_UUID" --evidence "$EVIDENCE_REF"
node dist/main.js corporate-validate-id-readoption --confirm-source olos-production --request-id "$REQUEST_UUID" --evidence "$EVIDENCE_REF"
node dist/main.js corporate-id-readoption-status --confirm-source olos-production --request-id "$REQUEST_UUID"
```

Copiar o `validation_digest` efetivamente retornado. Não inventar nem recalcular um digest para forçar validação. Estado `ready` não é ativo:

```sh
node dist/main.js corporate-activate-id-readoption --confirm-source olos-production --request-id "$REQUEST_UUID" --evidence "$EVIDENCE_REF" --validation "$VALIDATION_DIGEST" --max-batches 10
node dist/main.js corporate-reconcile-id-readoption --confirm-source olos-production --request-id "$REQUEST_UUID" --evidence "$EVIDENCE_REF" --validation "$VALIDATION_DIGEST" --max-batches 10
node dist/main.js corporate-id-readoption-evidence --confirm-source olos-production --request-id "$REQUEST_UUID"
```

Em `activating`, repetir apenas a reconciliação da mesma geração. Em falha local de COMMIT, consultar status/evidência em nova sessão; nunca criar outra geração ou resetar o contador. Reservations remotas são recuperadas com o mesmo source/request; uma transação concorrente ainda em curso precisa terminar antes que a chave possa ser reconciliada. Falha de registro não autoriza reutilizar os IDs em outra chamada.

Após `active`, conferir quarentenas/receipts, executar `corporate-verify-pending` e `corporate-check`. Se existir bloqueio de colisão, usar a recuperação explícita existente com o digest verificado; `corporate-resume` não ignora esse bloqueio. Somente então usar `corporate-resume` com as autorizações de escrita existentes. O próximo ciclo materializa um lote limitado e entrega pelo mecanismo habitual. Nenhuma etapa chama a API OLOS para recuperar ou reinterpretar dados antigos.

## Auditoria e monitoramento

Usar `corporate-status`, `corporate-id-readoption-status/evidence` e os eventos `corporate_id_allocation_commit_unknown`, `corporate_id_allocation_deferred`, `corporate_id_reservation_completed`, `corporate_id_materialization_completed`, `corporate_delivery_deferred` e `corporate_delivery_confirmed`. Não expor payloads/tokens em logs. Monitorar admissions sem materialização, outbox pendente, quarentena, confirmações, ocupação do int32, falhas de identidade/contrato e duração das reservas.

Consultas administrativas somente leitura:

```sql
-- Local
SELECT state,request_id,contract_hash FROM olos_http.corporate_id_allocator;
SELECT paused,blocked,last_code,confirmed_count,id_allocator_generation FROM olos_http.corporate_control;
SELECT materialized,count(*) FROM olos_http.corporate_id_admissions GROUP BY materialized;
SELECT state,count(*) FROM olos_http.corporate_outbox GROUP BY state;
SELECT code,count(*) FROM olos_http.corporate_collision_quarantine GROUP BY code;
-- MADM: metadados de reserva e consumo; não publicar tokens.
SELECT r.internal_id,r.state,r.request_id,i.source_key,i.source_id,r.used_raw_id,
       encode(sha256(convert_to(r.token::text,'UTF8')),'hex') AS token_hash
FROM olos_delivery_ids.registry r LEFT JOIN olos_delivery_ids.identities i USING(internal_id)
WHERE i.source_key='olos-production' ORDER BY r.internal_id LIMIT 1000;
SELECT next_candidate FROM olos_delivery_ids.counter;
SELECT identity_hash,cardinality(ambiguous_raw_ids) AS members,ambiguous_raw_ids
FROM olos_delivery_ids.identities WHERE ambiguous_raw_ids IS NOT NULL
ORDER BY identity_hash LIMIT 1000;
```

Registro remoto `used` não é, sozinho, recibo local: comparar a chamada completa e reconhecer o COMMIT da verificação. Falha de conexão mantém admissions/outbox. Após reinício não gerar UUIDs novos para os itens que já possuem request/token. Não remover reservas “antigas”, inclusive as de chamadas posteriormente puladas pela política.

## Rollback operacional

Antes da barreira, `corporate-abort-id-readoption` pode encerrar uma requisição prepared/validating/ready, mantendo admissions e migrations. Não desfazer a 014 para voltar a atribuir números localmente.

Depois de qualquer reserva ou da barreira, pausar Corporate Delivery, parar o scheduler se necessário e aguardar as transações conhecidas; consultar a geração por UUID e reconciliar COMMITs desconhecidos. Preservar namespace, trigger, registry, identities, tokens, assignments, outbox, batches e receipts. A geração ativa é monotônica. A reversão antiga não pode ser executada novamente para materializar novos IDs locais.

Se precisar reverter o binário, usar apenas uma versão compatível com o contrato v2 ou manter o processo parado/read-only. Binário v1/legacy não é um rollback operacional suportado: a 014 bloqueia sua atribuição local e a 002 rejeita reservas sem identidade. Não remover guardas para fazê-lo rodar. Não restaurar apenas um dos bancos a um snapshot anterior às reservas: isso perde o vínculo entre autoridade e recibos e exige reconciliação coordenada antes de retomar.

## Testes e aceite ainda pendente

```sh
node --import tsx --test --test-isolation=none test/corporate-authority.test.ts test/corporate-delivery.test.ts test/corporate-recovery.test.ts
OLOS_DIRECT_TEST_FILES='test/corporate-authority.integration.ts test/corporate-authority-flow.integration.ts' bash scripts/test-corporate-delivery.sh
npm run build
npm run typecheck
git diff --check
```

O runner usa PostgreSQL 16 descartável e dados sintéticos. A integração da autoridade cobre agora grupos com IDs internos diferentes, grupos com IDs nulos, preservação integral das linhas, bloqueio de reconhecimento/reserva/INSERT e reserva idempotente de uma chamada distinta. A integração do fluxo instala a autoridade com um grupo histórico externo ambíguo, preserva esse grupo durante o fluxo normal e verifica que uma admission ambígua não materializa records/outbox/assignment mesmo após reinício. Os cenários anteriores de concorrência, COMMIT incerto, receipts, quarentena e reversão permanecem. Nenhum transporte real OLOS é utilizado.

Validação desta alteração, Node 24.16.0:

| Verificação | Resultado |
| --- | --- |
| Build e `git diff --check` | Aprovados. |
| Unitários diretamente afetados | 18 aprovados, zero falhas/skips. |
| Typecheck completo | 17 diagnósticos preexistentes, idênticos ao baseline; nenhum novo. Globalmente reprovado. |
| Duas integrações PostgreSQL solicitadas | Runner interrompido antes de criar recursos: acesso negado a `/var/run/docker.sock`. Não executadas nesta revisão. |

Os 23/23 PostgreSQL informados pelo operador referem-se à candidata anterior e não validam esta alteração. Parsing/execução da migration revisada, constraints canônicas, concorrência e fluxo integrado ainda precisam passar em PostgreSQL 16. A candidata não está aprovada para publicação. Também permanece necessária a homologação dos escritores externos e a identificação de eventuais vínculos do worker com grupos ambíguos; não liberar automaticamente tais vínculos para concluir a ativação.

O bootstrap e a reserva serializam escritores no contador. A memória da captura continua limitada pelos mecanismos existentes; os lotes de reserva têm teto de 2.000 e o registro da readoção usa paginação. Auditorias antigas de quarentena/predecessor ainda leem manifestos inteiros; volume extremo desses ledgers e desempenho sob todos os escritores precisam de medição própria. Não aumentar timeout como prova de capacidade.
