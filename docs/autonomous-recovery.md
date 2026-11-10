# Recuperação autônoma do scheduler

## Diagnóstico e decisão

O journal já preserva intenção (`reading`), resposta (`received`) e checkpoints transacionais. A causa estrutural estava no desacoplamento incompleto entre esse journal e o scheduler: o consumer recusava qualquer pendência, ERROR exigia intervenção e o desligamento apagava RUNNING desejado. A API ainda repetia POSTs consumidores em 401/429 e resolvia leituras por status, sem prova contratual de ausência de consumo.

A correção reutiliza `Store.drain()`, os locks de sessão PostgreSQL e a máquina de estados existente. Não acrescenta tabela, migração, serviço ou fila. HTTP consumidor faz uma única tentativa; apenas falha de autenticação anterior à invocação do transporte permite resolver automaticamente a intenção. Status HTTP, timeout e contagem zero não autorizam resolução.

## Janelas de falha

| Janela | Risco / evidência durável | Operação permitida / condição de retomada |
|---|---|---|
| 1. Antes da intenção | Sem POST consumidor; falha local/auth/referências | Retry limitado, novo lock e preflight |
| 2. Intenção confirmada, antes de transmitir | `reading` não distingue esta janela das próximas | Bloquear; só AuthUnavailable originado antes do transporte comprova ausência de envio |
| 3. Durante HTTP | Pode ter consumido; `reading` | RECONCILIATION_REQUIRED, sem replay |
| 4. OLOS processou, resposta perdida | Cursor pode ter avançado; `reading` | Reconciliação explícita com evidência externa |
| 5. Resposta em memória, sem stage | Corpo não sobrevive ao restart; `reading` | Bloquear, mesmo se processed_count=0 |
| 6. Persistência de received / ACK perdido | Consultar o estado em nova sessão sob lock | `received`: drain; `reading`: bloquear; nunca repetir POST para descobrir |
| 7. Lotes | Corpo + processed_count; marker/destino/outbox e checkpoint na mesma transação | Reabrir sob lock, drain a partir do checkpoint, validar hashes |
| 8. COMMIT / ACK local | COMMIT pode ter ocorrido | Reconsultar corpo/checkpoint; repetir somente processamento local. Recibos corporativos continuam sob o mecanismo existente |
| 9. Reinício | desired_state separado de runtime_state e journal | RUNNING revalida origem e pendências; PAUSED/STOPPED não criam consumer |
| 10. Perda PostgreSQL | Lock deixa de existir; sessão antiga perde autoridade | Abortar HTTP em perda detectada; fechar consumer; readquirir lock administrativo e da origem, reconsultar journal antes de consumir |

Uma conexão prévia bem-sucedida não prova que o POST seguinte não foi enviado. Falhas ambíguas continuam bloqueantes, inclusive erros HTTP 4xx/5xx. O código mantém RECOVERY_REQUIRED como sinal interno de revalidação; o consumer transforma `reading` em RECONCILIATION_REQUIRED, terminal até ação explícita.

## Agendamento e posse

Falhas classificadas como conectividade/transação, autenticação recuperável, reinício inesperado ou RECOVERY_REQUIRED recebem tentativas limitadas por MAX_RETRY_ATTEMPTS (configuração existente), com atraso pelo menos igual ao intervalo e backoff limitado a 60s dentro desse cálculo. Ao esgotar o orçamento, ERROR permanece visível; start explícito reinicia o orçamento. Erros estruturais não são repetidos automaticamente. Recriar o consumer não zera o orçamento; um ciclo concluído zera.

O consumer recupera respostas duráveis em `received` antes de ser devolvido ao scheduler. Depois do await, o scheduler relê desired_state antes do próximo POST. Não cria novas capturas históricas/reread nem altera a autorização desses comandos; apenas processa respostas já duráveis quando não existe `reading` bloqueante. A recuperação depende das leituras idempotentes do catálogo e referências, como recover-local atual. Não dispara Corporate Delivery durante o preflight.

O lock `olos-http:AttemptsRawData:<source_key>` permanece na sessão que registra intenção e processa dados; outra instância não pode assumir essa mesma origem enquanto a sessão existe. Se perder a sessão depois da intenção, o journal impede o novo proprietário de consumir. O lock administrativo também precisa ser readquirido após desconexão. Sem nova necessidade demonstrada de fencing adicional. Isso pressupõe um único PostgreSQL primário consistente, sem split-brain. Corporate Delivery ainda possui coordenação singleton/global própria; este patch não afirma suportar múltiplas origens corporativas simultâneas.

O shutdown preserva desired_state; portanto reiniciar container com RUNNING desejado autoriza retomada após preflight. PAUSED/STOPPED persistidos continuam respeitados.

## Garantias externas pendentes

Não foi encontrada garantia oficial pública suficiente na busca por ExportDataV3/read-data-current-day/re-read-data/log-read-data. Os endpoints presentes no código não provam completude, retenção, limites exatos do intervalo perdido, atomicidade do cursor, nem ausência de consumo em erros HTTP. Não há base para resolver automaticamente reading. Solicitar à OLOS contrato versionado sobre esses pontos, identidade do cursor e comportamento de chamadas ainda em voo. `log-read-data`, reread e resolve permanecem explícitos; nenhuma inferência por tempo ou contagem foi introduzida.

## Publicação e rollback

Somente procedimento, sem execução: validar suites/build no ambiente de homologação, guardar imagem anterior, pausar pelo painel, aguardar ciclo/delivery em voo, inventariar reading/received/outbox/recibos e fazer backup. Publicar imagem com Node 24 e a mesma configuração/banco, sem migrações novas. Restaurar RUNNING apenas quando desejado pelo operador e verificar eventos de recuperação e ausência de bloqueios. Para rollback, pausar e aguardar encerramento, restaurar imagem anterior preservando integralmente banco/journal/outbox/recibos; não apagar reading nem reexecutar POST. A versão anterior pode voltar a exigir recover-local e start explícitos.

## Validação local (Node 24.16.0)

- `npm test`: 111 aprovados, zero falhas. Relógio controlado e gates para retomada, orçamento finito, PAUSED/STOPPED durante preflight, restart e ausência de sobreposição.
- `bash scripts/test-integration.sh`: 29 aprovados, zero falhas, duas suites corporativas puladas porque possuem runners próprios. API simulada local e PostgreSQL descartável; inclui timeout pré-intenção, resposta não persistida, ACK de stage perdido, checkpoints, COMMIT local incerto e unicidade.
- `bash scripts/test-admin.sh`: 16 aprovados. Perda real de sessão PostgreSQL com evento de erro aguardado, readquisição e recusa ao antigo proprietário quando outra instância assumiu.
- `npm run test:admin-ui`: 10 aprovados; `npm run typecheck:admin`, `npm run build` e `git diff --check` passaram.
- TypeScript do escopo (todos os fontes, testes unitários, store.integration e admin.database) passou usando configuração temporária que estende tsconfig.json. `npm run typecheck` global conserva 17 erros em corporate-delivery.integration.ts; saída idêntica à de uma cópia limpa do HEAD `f54cbefb1f1acaa2197bd05d0f0109d32ee77542`.
- Runner corporativo com PostgreSQL/TLS descartáveis: 73 aprovados e oito falhas (sete subtestes de histórico/homologação e a suíte agregadora). A cópia limpa do HEAD teve as mesmas oito falhas, com 64 aprovados. Não há aprovação integral dessa suíte nem validação de produção.

A disponibilidade inicial de PostgreSQL antes de `AdminRepository.open()` depende do reinício do processo pelo orquestrador; compose.dokploy.yaml já usa `unless-stopped`. O compose.yaml genérico usa restart=no. Não foram alteradas políticas de deploy. Após esgotar o orçamento de retries, a retomada exige start explícito. A recuperação local ainda depende de catálogo/referências OLOS disponíveis, como o recover-local existente. Não se afirma validação de WAN, retenção OLOS, split-brain PostgreSQL ou escala corporativa multi-origem.


## Revisão final contra f54cbef

Três defeitos reproduzidos antes da correção: P1, ACK perdido de PAUSED/STOPPED deixava ERROR sem reler intenção persistida (scheduler.ts:66); P1, COMMIT administrativo sem código do driver não era elegível à reconciliação (repository.ts:63); P2, AuthUnavailable não retryable era readmitido pela lista de códigos (errors.ts:32). Corrigidos com uma releitura após comandos administrativos, ADMIN_COMMIT_UNKNOWN com descarte da conexão incerta, e respeito ao atributo retryable. Seis cenários de regressão novos passaram, incluindo RUNNING com ACK de estado perdido e falha anterior ao COMMIT que não pode rearmar ERROR. A mutação administrativa incerta não é repetida.

Comparação corporativa em duas execuções novas, com bancos/TLS descartáveis: candidata 73 aprovados/8 falhas; base 64 aprovados/8 falhas. Os sete subtestes abaixo têm os mesmos diagnósticos/assertions e local de falha; a oitava falha é a suíte agregadora com sete filhos falhando. Comparação desconsiderou somente timestamps e frames internos do Node:

| Subteste em corporate-delivery.integration.ts | Diagnóstico equivalente na base e candidata |
|---|---|
| history exige exclusividade com o Admin (129) | s.assertHistoryReady não existe |
| history bloqueia estados corporativos inválidos e leituras pendentes (185) | unauthorized.assertHistoryReady não existe |
| history falha remota não repete consumo após reinício (335) | actual=0, expected=1, strictEqual |
| homologation CLI confirms exactly five... (386) | corporate-homologate encerra com código 1, COMMAND_INVALID |
| homologation CLI excludes independent source... (463) | assert.rejects: predicado false para erro da mesma CLI |
| homologation holds pause against concurrent resume... (477) | assert.rejects: predicado false para erro da mesma CLI |
| homologation without authorization... (487) | assert.rejects: predicado false para erro da mesma CLI |

Os 17 diagnósticos TypeScript foram comparados integralmente (arquivo, linha, coluna, código e mensagem), sem diferenças: TS2353 historyCaptureAuthorized em 125/192; TS2339 assertHistoryReady em 129/136/137/185/195/204/214/220/228/236/247; TS2322 history em 244/331/343/360. Todos em corporate-delivery.integration.ts. Build e typecheck do escopo passaram. As suites globais continuam sem aprovação integral; a classificação de impacto e a decisão para publicação controlada constam abaixo. Nenhuma regressão adicional identificada no escopo executado; isso não constitui validação de produção.


## Decisão final: GO para publicação controlada

Não há bloqueador real demonstrado para o Autonomous Recovery no escopo de ingestão agendada existente. A equivalência à base foi verificada por teste e diagnóstico, não apenas por contagem. Isso não aprova integralmente a suíte nem os fluxos históricos/homologação ausentes.

Todas as oito falhas corporativas abaixo são classificadas como **PREEXISTENTE SEM IMPACTO DEMONSTRADO NA FEATURE**:

| Teste exato | Sobreposição e razão da exceção |
|---|---|
| history exige exclusividade com o Admin | Usa AdminRepository e Store alterados; falha porque Store.assertHistoryReady não existe, antes de validar exclusividade histórica. Locks administrativos e de ingestão possuem testes diretos aprovados. |
| history bloqueia estados corporativos inválidos e leituras pendentes | Usa Store alterado; mesmo método histórico inexistente, antes das validações pretendidas. Não evidencia alteração de outbox/recibos pelo scheduler. |
| history falha remota não repete consumo após reinício | Usa Worker/OlosApi/Store alterados, mas passa kind=history, fora do ReadSpec existente; contador da rota previous permanece 0. O scheduler usa current; previous/current e bloqueio reading possuem cobertura aprovada. |
| homologation CLI confirms exactly five, remains paused, never calls OLOS and never drains a second batch | CLI corporate-homologate não está registrado em src/main.ts (inalterado). Encerra com COMMAND_INVALID antes da entrega pretendida. A recuperação agendada não usa esse comando. |
| homologation CLI excludes independent source, Admin and Corporate Sync lock owners | O mesmo wrapper CLI falha antes dos guards de homologação; não testa efetivamente os locks esperados nessa execução. A exclusão mútua do consumer/scheduler passou em testes próprios. |
| homologation holds pause against concurrent resume, blocks another CLI and permits only one attempt per instance | O mesmo wrapper CLI falha antes da asserção esperada. Os testes diretos de pausa, interrupção e COMMIT da entrega/homologação passaram. |
| homologation without authorization, without pause or with a structural conflict fails closed | O mesmo wrapper CLI falha antes da autorização esperada. O caminho de ingestão/recuperação não depende desse comando; demais verificações diretas corporativas aprovadas não são invalidadas por esse diagnóstico. |
| direct corporate delivery in disposable PostgreSQL with verified TLS | Suíte agregadora: falha porque sete subtestes falharam. Os demais subtestes foram executados, inclusive entrega, recibos, COMMIT incerto, hashes e scheduler durante indisponibilidade corporativa. |

Os **17 erros TypeScript** também são **PREEXISTENTE SEM IMPACTO DEMONSTRADO NA FEATURE**: estão exclusivamente em test/corporate-delivery.integration.ts (contratos historyCaptureAuthorized/assertHistoryReady/kind=history ausentes). Não há diagnóstico em src nem nos testes alterados. O Dockerfile usa npm run build/tsconfig.build.json, que inclui src e exclui test; esse build passou novamente nesta decisão. Typecheck global permanece falhando e sua exceção deve constar da publicação, sem suprimir diagnósticos.

As garantias externas de retenção/reconstrução do cursor OLOS e o comportamento real de WAN são **INDETERMINADO**. Não são usados como premissa de sucesso automático: reading permanece bloqueado e exige reconciliação. Não há autorização para habilitar os fluxos históricos/homologação ausentes ou usar resolve sem evidência como parte desta publicação.

Evidência crítica reaproveitada da auditoria imediatamente anterior, sem alterações posteriores nos fontes/testes: 111 unitários, 29 integração PostgreSQL (2 suites de runners próprios puladas), 16 administrativos e runner corporativo 73 aprovados/8 falhas; base 64 aprovados/8 falhas. Cobertura aprovada inclui received durável/ACK perdido, reading protegido, checkpoints, deduplicação/hash, perda/readquisição de locks, PAUSED/STOPPED, orçamento finito, COMMIT local/remoto incerto, outbox e recibos preservados. Nesta decisão foram relidos os diagnósticos e caminhos específicos, reconfirmada equivalência e reexecutado o build; não houve nova auditoria geral ou mudança de código.

Condições mínimas: anexar estas exceções ao release; construir e verificar a imagem candidata em homologação; guardar imagem anterior e backup consistente; pausar e aguardar ciclos/transações em voo; registrar journal/outbox/recibos e bloqueios existentes; manter um consumidor por origem. Publicar sem migrações nem mudança de configuração. Retomar somente se desejado pelo operador e observar ao menos um ciclo/recuperação, sem contadores regressivos, duplicidades ou alterações indevidas de recibos. reading preexistente continua bloqueante para essa origem: não prometer RUNNING até reconciliação. Em regressão, pausar, encerrar a instância e restaurar a imagem anterior com o mesmo banco preservado; nunca limpar journal/outbox/recibos nem repetir POST para inferir resultado. O rollback pode exigir o recover-local/start explícito da versão anterior.
