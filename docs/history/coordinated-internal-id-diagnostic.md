# Migração coordenada de internal_id_olos: impedimento e plano condicionado

> Atualização: a implementação posterior e o procedimento vigente de migração coordenada estão em [original-identity-migration-v1.md](original-identity-migration-v1.md). Após a adoção, a entrega exige IDs originais; diagnósticos e resultados anteriores abaixo permanecem como evidência histórica.

## Resultado e escopo

Base conferida: `feature/exportdata-history`, HEAD `d1b60bf96288db019676be533a2da9d83697a99b`. Alterações locais anteriores preservadas. Esta entrega acrescenta diagnóstico, plano e testes descartáveis; **não implementa comando de renumeração, journal operacional ou migration executável**. Não há alteração de código de produção, schema corporativo, Billing, branch main ou worktree original.

A evidência de produção fornecida pelo usuário é:

| source_id / novo internal_id_olos | internal_id_olos antigo | raw_olos_call_id estável | CallId esperado |
| --- | --- | --- | --- |
| 47558756 | 724892 | 73757 | 1031754587 |
| 47559439 | 724965 | 73758 | 1031754969 |
| 47561569 | 725262 | 73759 | 1031756916 |

A ausência pontual de colisões não é autorização para escrever e não elimina corridas. Não houve conexão de produção nesta sessão. Os CallIds vêm do escopo de homologação existente; telefone, data, campanha e demais campos devem ser obtidos da evidência congelada, nunca inferidos dessa tabela. Todos os IDs propostos cabem em int4; qualquer outro ID, quantidade ou contrato deve ser recusado na primeira homologação.

## Impedimento comprovado

`test/fixture.sql` define a PK local como `internal_id_olos bigint GENERATED ALWAYS AS IDENTITY`. `src/schema.ts` exige PK bigint e gerador existente. O PostgreSQL 16 rejeita `UPDATE` dessa identity para um valor explícito com **SQLSTATE 428C9**, inclusive dentro de transação, com a mensagem de que só pode ser atualizada para DEFAULT.

`OVERRIDING SYSTEM VALUE` é uma opção de INSERT e não permite esse UPDATE. DEFAULT usa o gerador: não garante o AttemptsRawDataID. Não é permitido apagar/reinserir a linha, alterar temporariamente ALWAYS para BY DEFAULT, retirar/restaurar identity, manipular sequência para forçar DEFAULT, desativar triggers/regras ou editar catálogos para contornar a proteção. Nenhum desses artifícios foi implementado.

Logo, **a renumeração coordenada pelo modelo atual não é executável sob essas restrições**. Fazer COMMIT primeiro na MADM deixaria o estado local impossível de finalizar pelo procedimento permitido. Alterar apenas outbox/mapping não resolve: a linha física local ficaria associada ao ID antigo, os consumidores continuariam inconsistentes e a checagem de órfãos pode bloquear o Store. `ctid` não é identificador estável para migração; os testes o usam somente para comprovar que a tentativa rejeitada não tocou a linha.

O critério de parada já foi atingido. Deve-se manter os três IDs antigos até uma decisão explícita sobre um modelo local compatível e sobre os consumidores. Uma futura revisão de schema/local ou de requisito é trabalho separado, exige aprovação própria e novos testes; não é uma etapa implicitamente autorizada deste plano. Uma alternativa de arquitetura seria conservar o ID físico legado local e representar separadamente a identidade corporativa versionada no journal. Isso não exige renumerar a PK, mas exige redesenhar e provar todos os vínculos entre records, outbox, recibos, adoção legado, reconciliação e consumidores: hoje o código exige igualdade entre record_target_id e target_id. Não basta relaxar essa igualdade ou mudar apenas a outbox. Essa alternativa é um projeto separado de compatibilidade, não um migrador fornecido nesta entrega. Não iniciar a etapa corporativa enquanto não houver uma finalização local comprovadamente compatível.

## Dependências auditadas e limites da evidência

| Componente | Dependência / consequência |
| --- | --- |
| `olos_http.records` | PK por source_key/source_id e UNIQUE por target_table/target_id; precisa conservar correspondência com a linha local e source_hash. |
| `raw.olos_calls` local | PK identity ALWAYS; FKs de consumidores podem apontar ao ID antigo. A linha precisa permanecer existente, sem DELETE/INSERT. |
| `olos_http.corporate_outbox` | target_id int4 único; payload inclui o ID; hash e recibo confirmado vinculam ID antigo ao raw_olos_call_id. FK por source_key/source_id não valida a relação numérica com a linha raw. |
| `corporate_sync.receipts` e `control` | Recibo é indexado pelo ID antigo; pending, last_confirmed_id e contagens têm semântica incremental. Não substituir checkpoint por MAX dos IDs renumerados. |
| Journals seletivos, de operador e de drenagem | Contêm IDs/hashes congelados. Não editar evidência histórica nem reutilizar uma autorização antiga para nova identidade. Resolver incertezas antigas antes de planejar a transição. |
| `local-consumers.ts` | Guarda existente bloqueia fontes associadas a Billing. Não modificar Billing ou desativar essa guarda. |
| `contract.ts` / reconciliação seletiva | Compara ID, identidade lógica completa e payload. Uma linha com mesma identidade em outro ID produz `LOGICAL_CALL_AT_DIFFERENT_ID`; não é reconhecida automaticamente como recibo renumerado. |
| MADM | PK estável raw_olos_call_id bigint identity ALWAYS; internal_id_olos int4 com índice único parcial. A fixture mantém telefone, Kommo, datas e metadados. O índice parcial sozinho não pode ser alvo de FK PostgreSQL; isso não prova ausência de consumidores por ID. |

Inventário obrigatório de cada ambiente, antes de qualquer autorização futura: todas as FKs recebidas/emitidas (ações ON UPDATE, deferrability, valid), índices/UNIQUE/exclusion, identity/defaults/sequence ownership, particionamento/herança, triggers e funções chamadas, regras/views/materialized views e dependências em pg_depend/pg_rewrite, RLS, permissões, publications/replica identity e CDC. Comparar definições e hashes sob locks para rejeitar DDL concorrente. Um trigger de UPDATE que altere updated_at, telefone, Kommo ou outro campo fora do escopo é impedimento, mesmo que seja automático; não desativá-lo.

Também exigir inventário e aceite dos responsáveis por jobs, ETLs, relatórios, caches, integrações e referências em texto/JSON ou aplicações externas. Catálogos não conseguem provar todas essas dependências. Os testes acrescentam FK local pelo ID antigo, FK corporativa pelo raw_olos_call_id e consumidor sem FK para demonstrar essa diferença. **Dependências reais não foram verificadas**, por restrição de acesso; portanto não se declara compatibilidade de produção.

## Protocolo futuro, condicionado à remoção legítima do impedimento

### Admissão e journal durável

1. Escopo fechado nos três pares e raw IDs da tabela; contrato v1, limite três, sem modo geral. Vincular autorização a source_key, binding de ambos os bancos, versão do protocolo, IDs, parâmetros/timeouts, digest do manifesto e inventário de dependências. Não reutilizar a confirmação de entrega seletiva ou de drenagem.
2. Admin inativo, scheduler desabilitado/STOPPED, escrita geral false e Corporate Delivery pausado. Adquirir locks existentes de origem, Corporate Sync, Delivery e histórico na ordem compatível com o código, mais uma exclusão de migração. Todos os consumidores existentes precisariam reconhecer a quarentena de migração, inclusive após reinicialização; um journal novo sozinho não bloqueia os comandos antigos.
3. Rejeitar qualquer COMMIT incerto/intent pendente ou plano de drenagem conflitante. Conservar intacta a leitura `132eb226-f4e4-419d-b79f-21dd0e6e64c1`: estado reading, erro RESPONSE_TOO_LARGE, datas, corpo, contadores e todos os demais atributos. A exceção futura deve autorizar somente a operação de renumeração desses três registros; não ampliar a exceção de captura/entrega existente. Zero HTTP à OLOS.
4. Depois de uma pré-validação somente leitura, gravar e confirmar **journal local dedicado** antes de qualquer DML corporativo. O journal proposto teria intenção imutável e eventos append-only, com estado controlado por CAS/generation, chave idempotente única e no máximo uma transição não resolvida. Ele ainda não existe e não foi criado por esta entrega.

Campos mínimos da intenção: operation_id, protocol_version, escopo/autorização/digest, source_key e source_id, antigo/novo internal_id_olos, raw_olos_call_id, AgentId e identidade lógica (CallId/data/telefone/campanha), source_hash, payloads v1 completos antigo/proposto e seus hashes, snapshots completos dos recibos/linhas locais e remotas, checkpoints/journals relacionados, inventário de dependências/schema, snapshot da leitura interrompida e estado operacional, geração/fences e timestamps. Snapshots contêm dados pessoais e devem ter acesso restrito; progresso operacional mostra somente IDs de operação, contagens, estado e códigos, sem payloads.

O source_hash continua o mesmo. O payload_hash **necessariamente muda** porque internal_id_olos integra o payload: preservar o hash antigo como evidência, calcular o proposto pelo algoritmo v1 existente e versionar ambos. Nunca editar o hash isoladamente ou atribuir o hash antigo ao novo payload. Journal de entrega antigo permanece imutável; o journal de transição o referencia.

### Transação corporativa e confirmação

5. Abrir uma única transação corporativa SERIALIZABLE com timeouts finitos (por exemplo lock_timeout 1s, statement_timeout 5s e limite total 15s, sujeitos à homologação). Adquirir o fence remoto já usado pelas entregas/reconciliação e um lock de tabela `SHARE ROW EXCLUSIVE` com limite curto, além de locks das três linhas por raw_olos_call_id. Advisory lock sozinho não exclui escritores externos; SERIALIZABLE sozinho não congela consumidores não cooperantes. Se não for aceitável bloquear DML por esse período, pausar o plano, não remover o lock.
6. Sob a mesma transação e locks, repetir validação de schema/dependências e identidade completa, verificar cada par antigo/novo e todas as identidades lógicas (não só CallId), colunas não gerenciadas e recibos. Verificar colisões locais também sob os locks locais; ausência anterior não vale. Recusar ID novo ocupado, ID antigo divergente, identidade duplicada, troca/ciclo, consumidor não auditado ou mudança de evidência. A PK remota estável deve ser exatamente 73757/73758/73759 para os pares respectivos.
7. Somente com a finalização local já comprovadamente viável: alterar exclusivamente internal_id_olos na linha identificada por raw_olos_call_id e ID antigo, usando CAS sobre toda a evidência necessária. Exigir três linhas e comparar snapshots integrais pós-escrita: a única diferença permitida é internal_id_olos. Nenhum INSERT/DELETE, ON CONFLICT para mascarar colisão ou DDL corporativo. Revalidar ownership, pausas e evidência local após awaits e imediatamente antes do COMMIT; persistir o evento de intenção de COMMIT e a quarentena local antes de emitir COMMIT remoto.
8. Recibos locais não mudam antes de prova de COMMIT. Após confirmação, finalizar em uma única transação local versionada a correspondência da linha física, records/outbox/recibos e dependências aprovadas; conservar evidência anterior e contagens de chamadas confirmadas (não contar nova entrega). Essa etapa **não é realizável com a identity atual** e é o motivo para impedir a etapa 5 em operação. Falha da finalização mantém quarentena e requer reconciliação; não desfaz automaticamente o remoto.

### COMMIT incerto, reinicialização e idempotência

Estados propostos: PREPARED -> COMMIT_INTENT -> REMOTE_CONFIRMED -> LOCAL_FINALIZED. Qualquer falha ambígua após COMMIT_INTENT mantém COMMIT_UNKNOWN; uma falha local posterior ao COMMIT remoto mantém REMOTE_CONFIRMED/LOCAL_PENDING. Eventos antigos não são apagados. Não oferecer retry automático do UPDATE nem liberar entregas na reinicialização.

Reconciliação exige autorização própria ligada à operation_id e ao digest. Reabrir conexões, readquirir locks/fence remoto e esperar a transação anterior terminar antes de inferir presença/ausência. Conferir schema, identidade, raw IDs, versões locais e os dois conjuntos de IDs em snapshot consistente:

| Evidência remota | Decisão |
| --- | --- |
| Os três raw IDs mantêm IDs antigos e snapshots completos esperados; IDs novos livres | Prova de não aplicação, após fence. Registrar NOT_APPLIED. Não executar UPDATE como parte da reconciliação. Nova tentativa exige nova autorização. |
| Os três raw IDs têm IDs novos e snapshots esperados, com apenas internal_id_olos diferente | Prova de aplicação. Registrar REMOTE_CONFIRMED; finalizar local uma única vez por CAS, apenas se o impedimento local já estiver resolvido legitimamente. |
| Mistura, ausência de raw ID, ID antigo reutilizado, novo ocupado por outra linha, identidade/Kommo/metadados divergentes ou prova incompleta | Manter bloqueio para investigação. Não tentar compensar, inserir ou trocar IDs. |
| Intenção já LOCAL_FINALIZED e provas locais/remotas concordam | Reexecução é somente leitura e retorna o recibo existente, sem DML nem incremento de contagem. |

A reconciliação seletiva atual comprova entregas pelos IDs antigos; **não é reconciliador de renumeração**. Os testes demonstram que um COMMIT somente remoto preserva os outros campos, mas passa a falhar com LOGICAL_CALL_AT_DIFFERENT_ID, mantendo journal/recibos locais e bloqueio após reinicializações. Não relaxar essa validação para aceitar a divergência.

## Homologação, pausa e rollback

A primeira homologação futura deve limitar-se aos três registros e começar com manifesto somente leitura; uma auditoria antiga não substitui as verificações transacionais. Antes de qualquer escrita real, exigir revisão do procedimento local compatível, consumidores, journal/fences e todos os casos de falha em PostgreSQL descartável. Hoje a decisão é **NÃO EXECUTAR**.

Pausar antes de escrita em qualquer colisão, dependência desconhecida, trigger incompatível, estado operacional divergente, timeout ou prova insuficiente. Falha anterior ao COMMIT remoto permite ROLLBACK da transação e registro do aborto, mantendo os IDs e recibos antigos. Após emissão de COMMIT incerto, a única ação é reconciliar. Após COMMIT confirmado não existe rollback automático entre dois bancos: uma compensação seria outra operação autorizada, com nova checagem dos IDs antigos/novos, consumidores e journal; não fornecer SQL genérico de reversão. Nunca apagar linhas/recibos ou rebaixar confirmado para pendente.

## Testes e limitações

Os testes diagnósticos usam PostgreSQL descartável e as fixtures do contrato v1, com os três raw IDs e mappings informados. Reproduzem o bloqueio 428C9 sem mudança física, reexecução bloqueada, referências locais/corporativas, consumidor sem FK, colisão surgida após auditoria, exclusão de escritor concorrente, desconexão antes/depois do COMMIT remoto e incompatibilidade da reconciliação antiga. Preservam evidências/hashes/Kommo e leitura histórica. Os novos cenários não instanciam cliente HTTP nem invocam captura.

A suíte existente cobre entrega idempotente, intenção durável, COMMIT incerto, reconciliação autorizada, reinicialização, locks e zero HTTP nos comandos seletivos. Isso **não valida um migrador coordenado**, que não foi implementado devido ao impedimento. Nenhuma prova de dependências/capacidade de produção é inferida dos testes.

Validação em 2026-11-03, com Node 24 e ambiente de testes isolado:

- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm test`: **103/103** aprovados.
- `bash scripts/test-corporate-delivery.sh`: **133/133** aprovados, incluindo os quatro novos diagnósticos, Store/Admin e regressões de entrega/reconciliação; PostgreSQL 16 descartável, rede interna e zero portas publicadas.
- `bash scripts/test-corporate-sync.sh`: **39/39** aprovados em PostgreSQL descartável.
- `git diff --check`: aprovado.

Sem acesso a produção/VPS/MADM/OLOS reais, mudanças operacionais, migration real, commit, push ou deploy. A leitura histórica real não foi acessada ou modificada. Nenhuma homologação real foi executada.
