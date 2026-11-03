# Relatório — entrega corporativa integrada ao ExportDataV3

Implementação local concluída em 30/10/2026. Nenhum banco real foi acessado/modificado, nenhum Environment do Dokploy foi alterado e nenhum serviço operacional foi iniciado/parado. Sem commit, git add, push, publicação ou deploy.

## Arquitetura entregue

O processo ExportDataV3 e seu agendador existentes continuam capturando OLOS. No modo corporativo, o Store grava a resposta original e uma outbox durável no PostgreSQL local; a entrega usa conexão MADM separada dentro do mesmo processo. Captura e entrega têm estados/contadores independentes. Nenhum novo worker, scheduler, Compose ou container operacional foi criado.

O término de um ciclo admite uma tentativa limitada de entrega. A promessa é acompanhada pelo Store, usa outra conexão local para não reter a captura e é aguardada na pausa/desligamento. Backoff, bloqueio e pausa da entrega ficam no banco local. Não existe novo polling da tabela local. Os INSERTs MADM omitem identity, telefone_match_key e Kommo; os defaults/trigger corporativos são preservados.

## Arquivos modificados

| Arquivo | Alteração |
| --- | --- |
| `src/store.ts` | ramo de persistência para outbox, manutenção dos IDs/marcadores, ownership, admissão e encerramento da entrega |
| `src/mapping.ts` | cálculo exato em microssegundos e TMA half-away somente no novo modo; comportamento local anterior preservado |
| `src/config.ts` | apenas import e campo `corporateDelivery`; flags próprias sem substituir DATABASE_URL |
| `src/worker.ts` | verificação de prontidão local, contador queued e admissão de entrega no final do ciclo existente |
| `src/main.ts` | comandos administrativos de conciliação, diagnóstico, pausa/retomada e tentativa pontual no executável existente |
| `src/scheduler.ts` | pausa/stop suspendem admissão e aguardam entrega em andamento; sem novo timer |
| `src/admin/consumer.ts` | integra prontidão e ciclo de vida da entrega ao consumidor existente |
| `src/admin/repository.ts` | observação de queued e de estado corporativo independente |
| `src/admin/events.ts` | whitelist dos eventos e contagens de entrega, sem payloads |
| `src/errors.ts` | preserva códigos fixos das validações corporativas sem expor erros brutos |
| `src/corporate-sync/worker.ts` | guarda contra execução após adoção pelo modo direto, sem remover o módulo antigo |
| `test/capture.test.ts` | mock reconhece a nova consulta somente leitura de ownership; mantém as demais proibições de SQL |

`src/schema.ts` e `src/admin/main.ts` foram auditados; suas implementações existentes foram mantidas. O preflight local permanece aplicável e o bootstrap administrativo já propaga o Config ao consumidor.

## Arquivos criados

- `src/corporate-delivery/config.ts`
- `src/corporate-delivery/contract.ts`
- `src/corporate-delivery/reconcile.ts`
- `src/corporate-delivery/delivery.ts`
- `src/corporate-delivery/commands.ts`
- `src/corporate-delivery/local-consumers.ts`
- `src/corporate-sync/ownership.ts`
- `migrations/002_corporate_delivery.sql`
- `test/corporate-delivery.test.ts`
- `test/corporate-delivery.integration.ts`
- `scripts/test-corporate-delivery.sh`
- `docs/corporate-delivery/environment.example`
- `docs/corporate-delivery/README.md`
- `docs/corporate-delivery/validation.md`

## Testes e builds executados

| Verificação | Resultado final |
| --- | --- |
| `npm run typecheck` em Node 24 | passou |
| `npm run build` em Node 24 | passou |
| `tsc -p tsconfig.corporate-sync.json` | passou; módulo preservado compila |
| `npm test` em Node 24 com OpenSSL, sem rede externa | **102/102 passaram**, zero skips |
| `bash scripts/test-corporate-delivery.sh` | **72/72 passaram**, zero skips |
| `bash scripts/test-corporate-sync.sh` | **39/39 passaram**, zero skips; testes sintéticos do módulo preservado, sem iniciar seu serviço |
| `docker build -f Dockerfile -t olos-exportdata-v3:direct-local-test .` | passou; imagem existente construída apenas localmente |

Os 72 testes PostgreSQL incluem Store, Billing, administração e os novos cenários de entrega. O runner provisiona bancos exclusivamente descartáveis, PostgreSQL 16 com certificado sintético, rede interna sem portas publicadas e Node 24. A conexão corporativa do runtime valida CA e hostname mesmo nos testes. Os testes Billing existentes foram executados sem alterar seus arquivos; o runner provisionou previamente seu schema no banco descartável separado.

Os totais acima não devem ser somados como testes distintos: a suíte Corporate Sync inclui testes unitários também presentes na suíte geral.

A primeira execução identificou um teste novo que esperava o bloqueio de mapping ausente na conciliação; o preflight do Store corretamente o bloqueava antes. A asserção foi ajustada para cobrir essa proteção antecipada. O mock antigo de captura também passou a reconhecer a nova consulta de ownership. Não houve enfraquecimento dos guards nem mudança em testes Billing.

## Cobertura dos requisitos obrigatórios

| Requisito | Evidência em PostgreSQL descartável |
| --- | --- |
| Persistência direta | captura entra na outbox; raw local não recebe nova linha; MADM recebe após entrega |
| Identity automática | fixture começa raw_olos_call_id em 8 bilhões; novo registro recebe a PK automática, distinta do ID interno |
| Normalização por trigger | telefone_match_key é produzido pela função/trigger da fixture, sem inclusão no INSERT |
| TMA | 0.499999 resulta em 0 e 0.500000 em 1; testes unitários também cobrem empates negativos e política fixa |
| Existente idêntico | reconhecido sem novo INSERT nem consumo da sequence corporativa |
| Existente divergente | lote fica pendente/bloqueado, chamada preservada e novas capturas continuam |
| Falha de conexão | conexão recusada deixa fila intacta; restauração permite confirmar uma única vez |
| COMMIT ambíguo | falha após COMMIT sem SQLSTATE registra UNKNOWN e não confirma localmente; replay reconhece resultado remoto |
| Não duplicação | repetição de IDs de origem preserva target_id; confirmação/replay não criam novas chamadas |
| Kommo | valores corporativos sentinela permanecem iguais após reconhecimento |
| Captura durante falha | agendador/Worker real continuam gravando novas respostas e filas enquanto MADM está indisponível |
| Pausa/retomada/stop | controles de entrega operam com lock de captura ativo; scheduler pausa/retoma; close espera transação remota em andamento |
| Sem Corporate Sync paralelo | grafo de imports não alcança worker/CLI separado; advisory lock e marcador persistente impedem coexistência/retomada acidental |
| Estado anterior | **12.105 recibos sintéticos** adotados; todos os mappings e checkpoints antigos permanecem; contagem e sequence remota não avançam |

Também foram testados: backlog legado sem recibo, ausência de prova corporativa, sequência local atrasada, migração idempotente, escrita desabilitada, colisão de ID interno, identidade em outro ID, falta de mapping, hash incorreto, pending antigo, contagem incorreta, schema alterado, TLS inválido, rollback remoto e falha de confirmação local seguida de reinício.

A revisão final também cobriu uma corrida administrativa: resume adquire o lock da linha de controle antes de verificar o bloqueio. Uma falha estrutural descoberta pela entrega em andamento não pode ser apagada por um resume concorrente. O teste PostgreSQL dessa corrida passou.

## Preservação das alterações locais

Os arquivos de `src/billing/`, `docs/billing/` e `migrations/billing/` mantiveram seus hashes SHA-256 originais. Nenhum arquivo Billing foi editado.

Em `src/config.ts`, removendo apenas as duas linhas acrescentadas nesta tarefa (import e campo independente), o conteúdo final coincide byte a byte com a cópia inicial. As linhas em branco preexistentes foram preservadas. O `git diff --check` global aponta somente o EOF preexistente desse arquivo, que não foi normalizado para evitar alteração fora do escopo.

Não houve alteração de Compose, Dockerfile, pacote/dependências, credenciais ou configuração Dokploy. A imagem local usou o Dockerfile operacional já existente, sem executar seu entrypoint em ambiente real.

## Riscos, bloqueios e limites de validação

**Incompatibilidade estrutural identificada:** o Billing atual marca conflito quando um target de `olos_http.records` não existe em `raw.olos_calls` local. A persistência direta deixa de criar essas linhas locais. Uma dependência Billing registrada para a mesma origem causa `BILLING_LOCAL_CALLS_DEPENDENCY` e impede a transição/admissão/retomada/entrega. O teste de bloqueio passou sem modificar Billing. A presença dessa configuração real não foi consultada; precisa ser verificada em homologação. Não contornar o bloqueio apagando sua configuração; exige decisão de arquitetura específica fora desta alteração.

1. **Os 12.105 reais não foram consultados.** A homologação deve comprovar cada mapping, hash, identidade e chamada corporativa, além da contagem. Não basta preencher flags para declarar o legado conciliado.
2. Um hash legado produzido por outro contrato de projeção, enriquecimento posterior, mapping ausente, pending antigo ou divergência corporativa impede adoção. Não há fallback que ignore essa prova.
3. O schema real, funções do trigger, defaults, privilégios, CA/TLS e tipo/fuso temporal precisam de homologação autorizada. Nenhuma migração corporativa é exigida ou aplicada.
4. A sequência local é a mesma já usada, mas não reserva uma faixa perante outros produtores corporativos. Colisões observadas bloqueiam sem remapear/alterar dados. Validar disponibilidade de IDs integer e convivência antes de ativar.
5. A fila armazena payloads congelados e respostas; requer retenção, capacidade de disco e backups coordenados. Alterações posteriores não são propagadas para registros corporativos.
6. A guarda persistente depende desta versão de código. Uma imagem antiga não passa a conter essa proteção automaticamente; desligar/impedir a retomada do serviço anterior faz parte da janela autorizada. O advisory lock já usado pelo Sync protege contra coexistência enquanto os processos cooperam com esse lock.
7. Desempenho WAN, volume real, duração de locks, falhas reais de infraestrutura e restauração coordenada não foram homologados. Os testes são evidência de comportamento em fixtures, não certificação de produção.

Escrita desabilitada por padrão; adoção começa pausada. O [procedimento de homologação, ativação e rollback](README.md) mantém todas as operações reais para uma janela explicitamente autorizada, sem modificar produção nesta entrega.

## Atualização da expectativa legada para 12.605 — 30/10/2026

Esta seção complementa a evidência histórica acima, sem substituir os resultados anteriores com 12.105 registros. O padrão de `expectedLegacyCount` e o exemplo de ambiente passam a **12605**, conforme auditoria operacional da VPS fornecida pelo usuário após a conclusão do último lote legado de 500 registros via `once`. Nenhum banco real foi consultado nesta atualização.

A auditoria reportou `corporate_sync.control` com version 1, generation 27, last_confirmed_id e confirmed_count 12605, pending NULL; 12605 recibos distintos entre 1 e 12605; 725284 registros rastreados; sequência local em 725284 com is_called true; e zero registros em `olos_billing.sources`. Esses valores são contexto operacional informado, não resultados dos testes desta atualização.

### Escopo desta atualização

- `src/corporate-delivery/config.ts`: padrão alterado de 12105 para 12605; nenhuma mudança na lógica de conciliação.
- `docs/corporate-delivery/environment.example`: exemplo com `OLOS_CORPORATE_LEGACY_EXPECTED_COUNT=12605`.
- `test/corporate-delivery.test.ts`: expectativa do novo padrão e preservação do override explícito para 12105.
- `test/corporate-delivery.integration.ts`: novo cenário de 12605 recibos; cenário anterior de 12105 preservado byte a byte.
- `docs/corporate-delivery/README.md`: novo esperado, origem da auditoria e limites da evidência sintética.
- `docs/corporate-delivery/validation.md`: este adendo, preservando integralmente o relatório histórico.

O novo cenário prepara 12605 recibos sintéticos e três registros pendentes, com IDs OLOS diferentes dos IDs internos. Verifica adoção, hashes de origem e payload, relacionamentos e PKs corporativas; compara snapshots completos dos controles antigos, recibos, registros rastreados, respostas e chamadas corporativas; compara ambas as sequências; repete a conciliação e mantém o backlog pendente durante a pausa. Também exige rejeição para expectativas 12105, 12604 e 12606, sem adoção parcial. Não simula o volume operacional de 725284 registros.

A comparação estrita entre contagem de recibos, `confirmed_count` e expectativa permanece inalterada em `reconcile.ts`: divergências bloqueiam com `LEGACY_STATE_NOT_RECONCILED`. A atualização do padrão não concilia dados, não habilita escrita e não modifica checkpoints.

### Validação desta atualização

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | passou, Node 24 |
| `npm run build` | passou, Node 24 |
| `node --import tsx --test test/corporate-delivery.test.ts` | **4/4 passaram**, zero skips |
| Integração Corporate Delivery em PostgreSQL descartável | **22/22 cenários passaram**, incluindo 12105 e 12605 |
| Runner direcionado: integração + unitários Corporate Delivery | **27/27 passaram**, zero falhas, cancelamentos ou skips; inclui o teste pai da integração e os quatro unitários |
| Regressão de 12105 registros | código preservado byte a byte e reexecutado com sucesso |

Inicialmente, typecheck, build e quatro testes unitários passaram em container Node 24 com rede desabilitada. A integração ficou pendente porque seu `reset()` executa SQL de migrations. Após autorização específica do usuário para preparar exclusivamente bancos descartáveis, a integração foi executada em 30/10/2026 às 18:21 UTC, com sucesso na primeira execução. Typecheck e build foram repetidos e passaram novamente, em container sem rede.

O runner temporário `/tmp/test-legacy-count-authorized.sh`, derivado do runner existente, selecionou somente `test/corporate-delivery.test.ts` e `test/corporate-delivery.integration.ts`, sem provisionar bancos ou executar suítes adicionais de Billing/administração/Store. O comando do Node foi `node --import tsx --test --test-concurrency=1 test/corporate-delivery.test.ts test/corporate-delivery.integration.ts`. A duração reportada dos testes foi 17,744 segundos. Não foi necessário alterar código ou testes nesta execução autorizada; somente este relatório foi atualizado.

Antes de criar os bancos e executar as migrations das fixtures, o runner verificou por inspeção Docker: rede interna, zero portas publicadas, identificação de PostgreSQL temporário e conexão exclusiva à rede criada. Os dois bancos sintéticos, `olos_direct_test` e `madm`, foram criados no mesmo container PostgreSQL 16 descartável, com dados em tmpfs. O nome sintético `madm` atende ao contrato da aplicação e não identifica uma conexão ao MADM real. As URLs de teste foram fornecidas explicitamente como `127.0.0.1/olos_direct_test` e `localhost/madm`; o container Node 24 compartilhou exclusivamente o namespace de rede desse PostgreSQL temporário. Nenhuma URL real ou arquivo de ambiente foi carregado. O runtime de entrega validou CA e hostname usando certificado sintético.

O cenário de 12605 comprovou preservação dos hashes, recibos, checkpoints, relacionamentos, chamadas corporativas, sequências/identity e três itens de backlog. Nenhuma chamada existente foi reinserida. As expectativas divergentes 12105, 12604 e 12606 bloquearam a conciliação com `LEGACY_STATE_NOT_RECONCILED`, sem adoção parcial. O teste histórico de 12105 também passou sem reinserção nem avanço da identity. Esses resultados validam fixtures sintéticas; não constituem auditoria dos bancos reais nem teste de volume dos 725284 registros operacionais.

O container `olos-direct-test-1793384463-403269`, sua rede temporária e os certificados foram removidos ao final. A ausência desses recursos e de containers remanescentes nessa rede foi verificada após o término com código zero. As migrations foram executadas somente nos bancos descartáveis autorizados. O bloqueio anterior da execução dos testes está resolvido; nenhuma ativação operacional foi realizada. Os resultados históricos das demais suítes acima permanecem históricos e não foram reexecutados nesta etapa.

Nenhum arquivo Billing, Corporate Sync antigo, `src/config.ts`, migration, Compose ou configuração operacional foi modificado nesta atualização. Nenhum checkpoint real foi alterado; nenhum banco real foi acessado. Alterações preexistentes foram preservadas. Sem commit, git add, push ou deploy.

## Entrega seletiva — 03/11/2026

> Relatório da primeira implementação. O tratamento de COMMIT incerto e a ausência
> de migration nova descritos nesta seção foram substituídos pela correção abaixo.
> Os testes originais aceitavam reexecução sem reconciliação e não provavam quarentena.

Implementação no worktree `/home/madm/madm/export-data-v3-history`, branch
`feature/exportdata-history`, baseada em `b95d62c`. O checkout começou limpo.
Nenhum acesso à VPS, OLOS real ou MADM real; nenhuma homologação operacional,
migração real, alteração do checkout original, Billing ou main, commit, push ou
deploy. Publicação permanece sujeita a revisão e autorização separadas.

### Implementação e arquivos

- `src/main.ts`: comando `corporate-deliver-selected`, validação de parâmetros e
  consentimento antes das conexões, execução no Store existente, sem API/scheduler.
- `src/corporate-delivery/selection.ts`: limite fixo de três IDs, formato canônico,
  rejeição de duplicatas, autorização vinculada à lista e escrita geral desabilitada.
- `src/corporate-delivery/delivery.ts`: protocolo transacional comum ao `tick()` e
  à seleção; locks de entrega/histórico, verificação dos mappings, seleção exata,
  revalidação de confirmados e erro de CLI em falhas remotas.
- `test/corporate-delivery.test.ts` e `test/corporate-delivery.integration.ts`:
  regressões de autorização, escopo, recibos, deduplicação, falhas e concorrência.
- `docs/corporate-delivery/README.md` e este arquivo: procedimento futuro,
  pré-condições, garantias, limites da evidência e rollback.

### Validação executada

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` e `npm run build`, Node 24.16.0 | passaram |
| `node --import tsx --test test/*.test.ts`, Node 24.16.0, ambiente limpo | 92/92 passaram, zero skips |
| `node --import tsx --test test/corporate-delivery.test.ts`, após revisão final | 6/6 passaram, zero skips |
| `bash scripts/test-corporate-delivery.sh`, PostgreSQL 16 e Node 24 | 84/84 passaram, zero skips, 30,609 s |
| `git diff --check` | passou |

O runner de integração existente cria PostgreSQL em tmpfs, rede Docker interna,
zero portas publicadas e certificado/CA sintéticos. O Node compartilha somente o
namespace de rede desse PostgreSQL; nenhuma configuração real é carregada.
Migrations/DDL de preparação e testes de incompatibilidade ocorreram exclusivamente
nesses bancos descartáveis. A API é simulada; a CLI seletiva fez **zero requisições**
ao servidor simulado e preservou integralmente `worker_settings`.

A primeira tentativa unitária em `node:24-bookworm-slim --network none` teve
91/92 sucessos: a fixture TLS não pôde iniciar porque `openssl` não existe nessa
imagem. A suíte inteira foi repetida com Node 24.16.0 local e ambiente limpo,
com `openssl` disponível, passando 92/92. Não foi necessário modificar o teste TLS.
Uma primeira integração passou 83/83; após acrescentar a interrupção real da sessão
PostgreSQL no COMMIT e concluir os ajustes, o runner final passou 84/84.

Os **13 novos cenários de integração seletiva** comprovaram:

1. Exatamente os três source IDs informados, associados aos targets 725285–725287
   e CallIds 35458016–35458018; sete pendências anteriores e dois recibos legados
   permaneceram integralmente iguais. Pausa mantida antes/durante/depois do COMMIT.
2. Reexecução idempotente, sem duplicação, recontagem ou alteração dos recibos
   já confirmados; `tick()`/`kick()` continuam sem enviar a fila geral.
3. COMMIT remoto efetivado com confirmação perdida mantém recibos pendentes;
   reexecução reconhece as linhas completas, preserva campos corporativos e identity.
4. Rollback remoto e falha antes do COMMIT local não produzem recibos falsos;
   reexecução controlada completa a confirmação sem duplicação.
5. Interrupção real da sessão remota via `pg_terminate_backend` no ponto anterior
   ao COMMIT produz `CORPORATE_COMMIT_UNKNOWN`, sem confirmação local.
6. Conexão recusada não envia dados e retorna falha.
7. Colisão de identidade bloqueia o conjunto inteiro; nova execução respeita o bloqueio.
8. ID ausente, hash de origem divergente e origem diferente de `capture` impedem escrita.
9. Hash/payload inválido e schema remoto incompatível impedem entrega parcial.
10. Recibo confirmado sem prova remota bloqueia sem reinserção.
11. Locks de origem, Corporate Sync, histórico e entrega rejeitam concorrência.
12. Duas tentativas no mesmo Store são rejeitadas; outro Store e alteração da pausa
    não atravessam a transação ativa.
13. Intenção histórica pendente, controle não pausado/bloqueado e autorização
    ausente/incorreta bloqueiam; a CLI retorna erro em conflito, não chama a API
    e não modifica o scheduler.

### Garantias e limites

A seleção não usa o LIMIT da fila geral nem `SKIP LOCKED`. Todos os IDs precisam
estar presentes e válidos; nenhum registro selecionado é descartado para avançar
os demais. O destino é `madm.raw.olos_calls`, validado antes de INSERT pelo mesmo
contrato corporativo existente. Apenas novos recibos pendentes são confirmados,
e somente após COMMIT remoto reconhecido. Não existe retry automático do comando,
retomada da fila, migration nova ou mudança permanente de configuração.

Os 709.682 registros pendentes e os três mappings operacionais são informações
fornecidas pelo solicitante, não evidência coletada em produção. A preservação foi
verificada por snapshots completos de uma fila sintética menor; não houve ensaio
de volume com 709.682 registros. Na operação autorizada, confirmar novamente a
contagem inicial e a redução esperada para 709.679, sem alterações dos demais itens.

Permanecem sem homologação o schema/privilégios/TLS reais, latência WAN, volume e
convivência com produtores corporativos externos aos locks cooperativos. Não há
atomicidade distribuída: falha após COMMIT remoto pode deixar recibo local pendente;
uma falha na confirmação do COMMIT local também exige verificar o estado durável.
Bloqueios não devem ser removidos nem recibos alterados para forçar avanço. O
[procedimento e rollback](README.md#entrega-administrativa-seletiva-até-três-registros)
preservam evidências e exigem autorização separada para qualquer ação real.


## Correção da quarentena de COMMIT seletivo incerto — 03/11/2026

### Auditoria e reprodução antes da alteração

O fluxo existente tratava o COMMIT incerto seletivo com a mesma expressão de
retry da entrega geral: `terminal = !(commitIssued || retryable(error)) || failures >= maxRetries`.
Na primeira falha, `blocked=false`. A seleção ignorava `retry_wait`, e a próxima
invocação podia consultar/inserir no destino sem uma reconciliação distinta.
`corporate-resume` também admitia limpar bloqueios cujo código fosse
`CORPORATE_COMMIT_UNKNOWN`. Não havia garantia equivalente de quarentena.

Antes de modificar o código, build e o runner descartável original foram
executados: **84/84 passaram**. Os logs registraram `CORPORATE_COMMIT_UNKNOWN`,
`blocked=false` nos testes de confirmação perdida e sessão remota interrompida;
os próprios testes então reexecutaram a seleção com sucesso. Esse resultado
reproduziu o defeito, em vez de demonstrar a garantia agora exigida.

### Correção restrita à seleção

- `src/corporate-delivery/selective-commit.ts` (novo): locks de sessão locais,
  fence transacional remoto, leitura exata dos recibos, evidência de IDs/hashes e
  persistência/finalização da intenção seletiva.
- `migrations/003_selective_commit.sql` (nova, **somente local e manual**): journal
  de tentativas, com uma única intenção não resolvida, UUID, binding, schema hash,
  evidência congelada e resultado por registro. Não altera estrutura corporativa.
- `src/corporate-delivery/delivery.ts`: grava intenção e bloqueio antes de emitir
  COMMIT remoto; revalida controle, recibos e payload depois do COMMIT local da
  intenção. COMMIT incerto e falhas posteriores mantêm intenção não resolvida.
  Implementa reconciliação com leitura remota e resolução local atômica.
- `src/corporate-delivery/selection.ts` e `src/main.ts`: comando administrativo
  `corporate-reconcile-selected`, autorização diferente da entrega, vinculada a
  UUID e lista exata de 1–3 IDs; rejeição antes das conexões quando não autorizado.
- `test/corporate-delivery.test.ts` e `test/corporate-delivery.integration.ts`:
  substituem as expectativas inseguras anteriores e cobrem persistência e recuperação.
- `docs/corporate-delivery/README.md` e este relatório: pré-requisito local,
  procedimento de reconciliação, limites e rollback revisados.

O protocolo de retry da entrega geral não foi alterado. Suas regressões continuam
passando sem aplicar a migration 003 nas respectivas fixtures. Para a seleção,
o código persistido `SELECTIVE_COMMIT_RECONCILIATION_REQUIRED` não pertence aos
motivos que o `resume` existente permite desbloquear; portanto não foi necessário
mudar globalmente o `resume`. O erro de execução incerta continua sendo
`CORPORATE_COMMIT_UNKNOWN`. O journal é persistido **antes** do COMMIT remoto para
não depender de conseguir gravar um bloqueio depois de perder a conexão local.

No sucesso normal, a intenção passa a `acknowledged` junto com os recibos, após
COMMIT remoto reconhecido. Depois de uma falha, reiniciar ou repetir entrega não
resolve a intenção: só a reconciliação autorizada pode fazê-lo. Isso também cobre
interrupção antes do COMMIT remoto e falha de confirmação local após sucesso remoto,
com bloqueio conservador. Não há timer, scheduler ou retry novo.

A reconciliação usa `READ COMMITTED READ ONLY`, exige que o fence remoto da
transação original esteja livre e faz a leitura de dados depois desse fence. Isso
impede considerar ausente uma linha cujo COMMIT original ainda pode ocorrer.
Verifica schema, binding, mappings, hashes, identidade, campos gerenciados e PK dos
recibos confirmados. Divergências preservam o bloqueio; linhas idênticas permitem
confirmar exclusivamente os recibos selecionados; ausentes ficam pendentes sem
INSERT. Resolução do journal, recibos, contadores e desbloqueio são uma única
transação local, mantendo `paused=true`. A entrega posterior exige outra invocação
autorizada. Campos corporativos não gerenciados e itens fora da seleção ficam intactos.

### Validação final

Os comandos usam Node 24.16.0 para build/unitários e Node 24/PostgreSQL 16 no
runner descartável existente, com rede Docker interna, zero portas publicadas,
CA/hostname sintéticos e API simulada. Nenhuma variável operacional real é carregada.
A migration 003 foi aplicada exclusivamente nas fixtures locais de entrega seletiva.

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | passou |
| `npm run build` | passou |
| `node --import tsx --test test/*.test.ts` | 93/93 passaram, zero skips |
| `bash scripts/test-corporate-delivery.sh` | 92/92 passaram, zero skips |
| `git diff --check` | passou |

A primeira rodada da correção passou 91/91 integrações. A revisão acrescentou a
revalidação do payload após o COMMIT local da intenção e um teste de alteração
concorrente nesse intervalo; o runner final passou 92/92. A suíte unitária final
passou 93/93. Casos relevantes executados:

- COMMIT remoto efetivado com resposta perdida: nenhuma confirmação local;
  bloqueio persiste ao fechar/reabrir Store e ao invocar a CLI em novo processo.
- Sessão PostgreSQL remota interrompida no COMMIT: ausências só liberadas pela
  reconciliação explícita, sem envio; nova entrega é uma ação separada.
- Perda da sessão proprietária local após COMMIT remoto e interrupção após gravar
  a intenção: bloqueio sobrevive sem depender do handler conseguir salvar a falha.
- `corporate-resume`, `tick()` e nova seleção não removem a quarentena.
- Consentimento errado, UUID errado, seleção parcial ou fora da tentativa: rejeição.
- Identidade remota divergente, hashes/payload local alterados ou schema incompatível:
  nenhum recibo confirmado e nenhum desbloqueio; dados divergentes preservados.
- Fence remoto ocupado: nenhuma inferência de ausência ou desbloqueio.
- Falha na conclusão da leitura remota ou antes do COMMIT local de reconciliação:
  rollback de recibos, resolução e desbloqueio; intenção original permanece igual.
- Reconciliação bem-sucedida mantém pausa, não chama API nem altera scheduler,
  preserva identity/campos corporativos e recibos fora da seleção autorizada.
- Reconciliação já concluída não é reaplicada; contadores não são duplicados.
- Migration ausente e UNKNOWN antigo sem journal: rejeição segura da seleção.
- Regressão da entrega geral continua reconhecendo seu COMMIT incerto conforme
  o comportamento preexistente, sem depender do journal seletivo.

### Limites e operação futura

A migration local e privilégios SELECT/INSERT/UPDATE na nova tabela precisam de
revisão/aplicação explícita antes de usar o comando em ambiente operacional.
Nenhuma migration de produção foi executada. O journal não substitui backup;
seu histórico resolvido deve ser preservado. Estado antigo `CORPORATE_COMMIT_UNKNOWN`
sem journal não permite inferir seleção/UUID e exige procedimento manual específico,
separadamente autorizado; não há backfill, limpeza de flags ou desbloqueio automático.

Não há atomicidade distribuída. Se a confirmação do COMMIT local de reconciliação
for perdida, consultar journal/recibos antes de repetir: ele pode já estar resolvido.
O fence remoto coordena estas transações seletivas; produtores externos que não
respeitam os locks continuam fora dessa garantia. O ambiente real, volume operacional,
latência WAN e privilégios/TLS corporativos não foram homologados.

Rollback exige manter pausa/escrita geral desabilitada e preservar o journal.
Não retornar ao seletor anterior nem limpar flags enquanto houver `unresolved`.
Não apagar chamadas/recibos ou desfazer somente um dos bancos. Incerteza remota
precisa de reconciliação antes de qualquer retomada.

Trabalho restrito ao worktree `export-data-v3-history`, branch
`feature/exportdata-history`; alterações anteriores e o arquivo não rastreado `=`
foram preservados. Sem commit, push, deploy, acesso à VPS ou MADM real, alteração da
branch main, Billing ou worktree original.
