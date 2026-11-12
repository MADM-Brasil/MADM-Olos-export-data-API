# Readoção da autoridade corporativa de IDs

Implementação local no repositório `exportdata-clone/MADM-Olos-export-data-API`, branch preservado `main`. Não foi acessada produção. O [runbook](id-allocator-readoption-runbook.md) depende de revisão técnica, homologação e aprovação do DBA. [Resultados reproduzíveis](../evidence/corporate-id-readoption.json).

## Causa e escopo

A sequência local não conhece a ocupação de `madm.raw.olos_calls`. Validar o espaço local ou isolar colisões já encontradas permite recuperação operacional, mas não concede exclusividade corporativa. A preparação da migration 010 tampouco muda a autoridade: `prepared` e `ready` ainda operam no legado.

A readoção cria uma geração independente, ligada por FKs à reversão concluída e à adoção original. Não substitui `corporate_id_allocator.request_id`. Preserva a evidência de reversão, validação, admissões, IDs históricos, payloads, hashes, recibos e quarentenas. A ativação não corrige conflitos históricos automaticamente nem libera a entrega.

## Estados e recuperação

| Origem → destino | Pré-condições e efeito persistido | Recuperação |
| --- | --- | --- |
| Ausente → `prepared` | UUID novo, origem/binding/destino exatos, entrega pausada, legado após reversão concluída e validada, admissões anteriores materializadas. Nenhuma mudança de autoridade. | Repetir a preparação com os mesmos argumentos; UUID com argumentos diferentes é rejeitado. |
| `prepared` → `validating` | Intenção de validação confirmada antes da conexão remota. | Repetir a validação com o mesmo UUID. |
| `validating` → `ready` | Contrato local e remoto, privilégios, schema corporativo, reversão e quarentena comprovados. Selos e referências imutáveis persistidos. | Repetição é idempotente. `ready` não significa autoridade ativa. |
| `ready` → `activating` | Autorização adicional e digest exato; pré-condições revalidadas; COMMIT conjunto do modo `adopting`, geração atual, corte histórico, `required=true` e barreira SQL. | Consultar o UUID; continuar com `reconcile`, conservando o digest. Não voltar ao legado. |
| `activating` → `activating` | Registrar os IDs históricos em lotes limitados, mantendo seus valores, e confirmar assignments/checkpoint/evidência local após COMMIT da reserva remota. | Repetir o mesmo UUID. Reserva já confirmada retorna a mesma associação/token. |
| `activating` → `active` | Corte inteiramente registrado, cadeia de lotes/counters coerentes, contratos ainda iguais, predecessores e quarentena íntegros. Modo `active`, contrato e timestamp confirmados juntos. | Consultar e repetir idempotentemente. A entrega continua pausada e conserva seu bloqueio. |
| `prepared`, `validating`, `ready` → `aborted` | Operação administrativa explícita, antes da barreira. Evidências anteriores permanecem. | Outra solicitação pode ser preparada com outro UUID após diagnóstico. Nunca gerar outro UUID para contornar resultado incerto. |

`active` e `aborted` são terminais. Falhas recuperáveis conservam o estado/checkpoint e registram `last_error`; não exigem estados adicionais. Divergências de identidade, contrato ou evidência exigem intervenção sobre sua causa, mantendo a barreira. Falha de confirmação de COMMIT não reescreve o resultado incerto: primeiro consultar o UUID. Há unicidade de geração aberta por origem e exclusão administrativa por lock de sessão.

## Ponto de linearização e compatibilidade com escritores anteriores

O ponto de mudança de autoridade é o COMMIT da barreira local. A transação adquire exclusivamente `(17320914,5)` e atualiza a geração, o modo e a linha `corporate_allocation_fence` de forma atômica. Inserções/alterações de IDs, admissões e assignments usam o mesmo protocolo em modo compartilhado. A linha da barreira é independente de `corporate_control`: uma entrega lenta, que prende o controle, não prende a captura por causa dessa linha.

Triggers `ENABLE ALWAYS` protegem `records`, destino local e metadados. Cada escritor também bloqueia a linha da barreira com `FOR SHARE`. Uma transação antiga em REPEATABLE READ não pode usar seu snapshot anterior para aceitar um ID legado: a versão alterada provoca erro de serialização. Escritores que terminam antes da barreira pertencem ao conjunto histórico fixado por ela. Escritores posteriores não podem confirmar atribuição local sem assignment.

O runtime compatível, ao observar `adopting`, confirma somente a admissão durável; não chama `nextLegacyId()`. O materializador espera `active`. Em `active`, usa `reserveIds()` e o UUID original da admissão. Não existe fallback para `nextval()`. O trigger sobre `raw.olos_calls` impede que binários anteriores gravem diretamente um novo ID local após a barreira. Um binário anterior pode consumir um valor de sequência no DEFAULT antes de receber a rejeição, pois sequências PostgreSQL não são transacionais; esse valor não se torna uma atribuição confirmada. A aplicação nova não chama a sequência nesse caminho. Não reajustar a sequência para compensar valores consumidos.

O latch não pode ser apagado, trocado de origem/binding/destino ou desligado depois da barreira. Guardas também impedem alteração dos predecessores, assignments e evidências históricas. Não há proteção contra um superusuário/owner que deliberadamente desabilite triggers ou altere o protocolo; os privilégios operacionais devem impedir esse contorno.

## Autoridade MADM e operação contínua

A migration corporativa `001_id_allocator.sql`, sujeita ao DBA, registra os IDs não nulos já ocupados. Não altera chamadas nem sequências existentes. IDs nulos continuam nulos. O contador é uma indicação de busca, e não uma sequência local ou uma suposição de que o maior ID determina o próximo valor.

`reserve()` serializa alocadores pelo contador e usa a PK do registry para arbitrar escritores corporativos concorrentes. Procura uma lacuna real no registro; não usa `MAX(id)+1` nem faixa arbitrária. A reserva liga papel corporativo, binding, identidade de origem, hash, UUID da admissão e token. A mesma identidade/UUID retorna a associação anterior; outra identidade não pode reutilizá-la. O trigger corporativo exige ownership/token para consumir uma reserva e registra também IDs de outros escritores. IDs usados permanecem ocupados mesmo que outro escritor remova ou troque o ID de sua chamada.

Antes da barreira, a validação examina corpos das funções, SECURITY DEFINER/search_path/owner, trigger ALWAYS, tipos/defaults/constraints/índices, privilégios e schema de chamadas. Os hashes são fixados na geração e revalidados durante registro e ativação. Layout remoto incompatível bloqueia. O runtime continua verificando o contrato remoto em seus lotes; não faz varredura histórica global a cada ciclo.

O materializador confirma a reserva remota antes da associação local. As duas transações não são atomicidade distribuída: se a conexão cair entre elas, a admissão e seu UUID persistem e a próxima execução recupera exatamente a reserva já feita. Se o COMMIT local ocorreu e sua confirmação se perdeu, `materialized=true`, `records`, outbox e assignment persistidos impedem duplicação. Outage, timeout ou exaustão int32 conservam a admissão, sem retorno ao legado. O worker e seu scheduler existentes continuam sendo os únicos consumidores.

## Classificação e integridade histórica

| Classe | Regra |
| --- | --- |
| Confirmados | Registrar a ocupação, comparar identidade/payload/recibo MADM, conservar ID/hash/recibo local. Sem novo INSERT. |
| Pendentes válidos | Registrar/reservar o ID já atribuído; preservar payload/hash e permitir entrega após verificação e liberação explícita. |
| Colisão confirmada | Bloquear; somente a recuperação seletiva existente pode isolá-la com diagnóstico e autorização próprios. |
| Quarentena | Validar integralmente com `quarantineMembers()`, registrar ocupação histórica, conservar `pending` e exclusão da seleção. Nunca remapear/liberar automaticamente. |
| Inelegíveis/`skipped` anteriores | Preservar filtros/estado/payload e reservar a ocupação do ID histórico; não entregar. |
| Admissões posteriores à barreira | Manter duráveis sem ID enquanto `activating`; reservar/materializar em `active`. |
| Reserva remota sem associação local | Recuperar pelo mesmo binding, identidade/hash e UUID da admissão; persistir o mesmo ID/token. |

O registro histórico usa cursor indexado, limite `OLOS_CORPORATE_BATCH_SIZE` (1–2000) e corte fixado na barreira. A leitura do maior ID somente delimita o conjunto existente; não aloca IDs. Cada lote tem checkpoint, manifesto de IDs/hashes/classificação e cadeia de hashes. Não expõe payloads nem tokens na CLI; a evidência armazena hash do token. Contadores e cursor são conferidos contra os cabeçalhos dos lotes. A prova completa da reversão é feita na validação e antes da barreira; depois, guardas imutáveis e selos permitem verificações pequenas dos predecessores.

Colisões descobertas durante `activating` podem passar pelo diagnóstico e quarentena existentes, vinculados à geração. Apenas acréscimos formalmente auditados nessa mesma geração são aceitos; alterações no conjunto inicial, vínculo, payload, hash ou contagem são rejeitadas. A liberação é recusada até `active`. Após ativação, novas colisões continuam bloqueando e conservando o lote pendente. Adoção não autoriza sobrescrever chamadas corporativas.

## Migrations e publicação

`010` permanece inalterada, de aplicação única; ausência/presença deve ser verificada antes da execução. `011` é expansiva e reexecutável para o contrato esperado: acrescenta metadados, FKs, índice de unicidade de geração aberta, journal e barreira. Substitui somente CHECKs/índice de estados da preparação. Divergência do contrato deve ser diagnosticada; `IF NOT EXISTS` não autoriza reparar um schema desconhecido. Locks/timeouts limitam espera e falhas revertem a transação.

A versão compatível deve ser publicada no mesmo serviço antes de `011`. O startup reconhece exclusivamente o trigger local conhecido e verifica o protocolo, preservando a rejeição de triggers desconhecidos. Migrations não são executadas automaticamente. Novas tabelas/funções devem receber os privilégios do papel já vinculado antes do COMMIT da migration local, caso esse papel não seja o owner. Não trocar papéis/endpoints para a CLI: eles compõem o binding. A migration MADM exige aprovação do DBA e compatibilidade de todos os escritores. O contrato foi exercitado em PostgreSQL 16; outra versão/deparser precisa de homologação.

Antes da barreira é possível abortar a solicitação; isso não desinstala a autoridade remota nem autoriza downgrade do binário. Depois dela, a recuperação é para frente, com a mesma geração. Pausar somente a entrega e corrigir o impedimento conserva a captura/admissões. Não executar down migration, reset de controle, limpeza de registry/quarentena ou renumeração.

## Comparação solicitada com o worktree separado

Leitura feita em `~/madm/exportdata-id-authority`, sem alterações, merge, cherry-pick ou cópia de arquivos. O único módulo adicional encontrado foi `id-authority-transition.ts` (42 linhas), acompanhado por seis testes unitários. `canActivateAuthority()` aceita seis booleanos e retorna uma decisão; seus únicos consumidores são os testes. Não possui migration, I/O, locks, barreira, tokens, journal ou integração com captura/entrega.

As condições úteis já estão cobertas por provas persistidas na implementação principal: modo legado validado, reversão comprovada, contrato remoto real, registro histórico e quarentena íntegros. O booleano `legacyPendingResolved` não distingue pendências válidas de conflitos isolados e não deve substituir essa classificação. Não foi demonstrada melhoria para incorporar; nenhum arquivo desse worktree foi reutilizado. Há uma única implementação efetiva, no repositório original.

## Evidência e limites do aceite

Resultados iniciais e hashes daquele momento estão no [relatório de validação inicial](../evidence/corporate-id-readoption.json). Os 72 testes anteriores de recuperação foram mantidos; a execução inicial da suíte dirigida terminou com 98/98. A [revisão técnica final](id-allocator-final-review.md) registra os defeitos comprovados/corrigidos e a nova execução de 101/101. Inclui barreira com escritores antigos e snapshots antigos, captura concorrente com entrega, UUID concorrente, rollback, perda de ACK de COMMIT em várias fases, queda após reserva, retomada parcial, limites int32, 50 mil IDs ocupados, worker/reinício e fluxo HTTP sintético → PostgreSQL → reserva → entrega → recibo. Uma sessão local sem ownership também concluiu validação/ativação com os privilégios revisados e recebeu rejeição ao tentar desabilitar a barreira ou desligar a autoridade.

Build estrito de produção e build/typecheck do admin aprovados na execução inicial. O typecheck global mantém 17 erros anteriores em testes de histórico; sua saída é idêntica à linha de base capturada antes das alterações. A integração geral inicial terminou com 178 aprovados e 8 falhas; após a revisão, 181 aprovados e as mesmas 8 falhas, com os sete cenários anteriores de histórico/homologação e seu pai. Esses problemas não foram ocultados, pulados nem corrigidos mediante alteração de APIs fora do escopo. Portanto o requisito de suíte/typecheck globais inteiramente aprovados continua pendente.

Não houve teste em MADM real, OLOS real, volume de milhões de registros, WAN ou outage real. O HTTP OLOS dos testes é loopback sintético e os bancos são descartáveis em rede Docker interna. A medição com 50 mil IDs demonstra a busca de lacuna no cenário executado, não throughput/SLA de produção. Aprovação DBA, capacidade int32/armazenamento, privilégios, janela de instalação do trigger e homologação dos escritores são condições de implantação. Não declarar implantação aprovada nem prometer resolução de conflitos históricos.
