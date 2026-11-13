# Recuperação local do Corporate Delivery — 015

Candidata sobre `1e062ff`, branch `fix/corporate-legacy-recovery`. Não altera `main`, não instala autoridade corporativa e não requer DDL, funções, triggers, sequences ou tabelas novas no MADM. A 014 deste checkout é uma cópia integral da migration local já publicada em `3227bcb`, incluída para auditoria e fixtures; **não reaplicá-la em produção**.

## Diagnóstico e fluxo preservado

A sequência local só conhecia a ocupação de `records`, outbox, tabela local e receipts. `nextLegacyId()` não consultava o MADM. Assim, um número livre localmente podia já identificar outra chamada no destino. O `UNIQUE` remoto e `compare()` impediam sobrescrita e confirmação incorreta, mas a fila já continha um vínculo congelado conflitante. Isso explica o mecanismo das colisões informado pelo operador; não identifica a autoria dos registros corporativos históricos.

Os números 57.208 confirmações, 1.162 pendências, 696 quarentenas e 6.751 pares de identidades repetidas são evidências fornecidas pelo operador, não contagens consultadas nesta execução.

O caminho continua sendo captura/streaming → journal/spool → `Store.drain/persist` → `CorporateDelivery.enqueue` → records/outbox na transação local → matching/INSERT corporativo → COMMIT remoto reconhecido → confirmação local. Campos, digest, elegibilidade, checkpoints, exclusão por origem e recuperações históricas permanecem. A identidade continua composta por `olos_call_id`, `data_ligacao`, `telefone`, `id_campanha_olos`; Call ID sozinho não foi promovido a identidade global.

Para uma origem/source_id já materializada, reaproveita-se o vínculo exato, validando o hash. Para registros novos, `nextAvailableLegacyId()` consome candidatos da sequência existente, rejeita os ocupados localmente e consulta o índice corporativo. Quando encontra ocupação histórica, varre lotes limitados de 256 candidatos, até 256 lotes por tentativa. Não usa MAX+1, setval ou troca de ID congelado. Gaps de sequência são esperados inclusive em rollback; o caminho comum consome somente um candidato. A capacidade int32 continua verificada.

Antes de congelar o payload, uma identidade já existente no MADM bloqueia a atribuição; mesmo uma chamada idêntica não pode ser adotada silenciosamente por outro source_id. Identidades repetidas bloqueiam com `AMBIGUOUS_LOGICAL_IDENTITY`. Nenhum membro é escolhido, excluído ou modificado.

**Consulta de disponibilidade não é reserva.** Entre a atribuição local e a entrega, outro escritor pode ocupar o candidato. A entrega continua usando o `UNIQUE` parcial corporativo e `ON CONFLICT ... DO NOTHING`, seguido da comparação completa. A disputa bloqueia com `INTERNAL_ID_COLLISION`; não remapeia, sobrescreve ou produz recibo falso. A correção elimina a atribuição de números já observados como ocupados e preserva segurança em disputas posteriores; não promete ausência de novos bloqueios.

O matching e o INSERT agora ocorrem sob `SHARE ROW EXCLUSIVE`, antes da primeira consulta que estabeleça o snapshot SERIALIZABLE. Esse lock também exclui INSERT/UPDATE/DELETE/COPY de escritores que não usam os advisory locks do worker. O PostgreSQL verifica o privilégio de lock; sua ausência bloqueia com `CORPORATE_ALLOCATION_LOCK_PRIVILEGE_REQUIRED`.

## Diferenças em relação à Corporate Authority v2

| Aspecto | Corporate Authority v2 | Recuperação desta branch |
| --- | --- | --- |
| Novos IDs | Reserva corporativa persistida antes da materialização | Candidatos da sequência local, consultados no MADM; exclusividade efetiva no INSERT com UNIQUE |
| Estruturas no MADM | Registry, funções e trigger de reserva | Nenhuma estrutura nova ou alteração de `raw.olos_calls` |
| Conflito posterior à escolha do ID | Autoridade remota protege a reserva, dentro de seu contrato | Transação bloqueia a divergência; candidato local não representa reserva remota |
| Histórico local | Geração/assignments de autoridade | Vínculos existentes preservados; 015 só aceita predecessor legacy comprovado e sem assignments |
| Falta de conectividade | Admissions podem aguardar a autoridade | Novos registros permanecem no journal até a consulta de alocação funcionar |

Esta branch parte de `1e062ff`, sem incorporar a implementação v2 de `3227bcb`. Os módulos antigos de adoção/reversão continuam legíveis para auditoria, mas a transição 015 impede ativar outra geração no estado recuperado. Sua tabela de evidência é exclusivamente local e não reserva IDs no MADM.

## COMMIT incerto e evidências

Um COMMIT remoto incerto sempre bloqueia a entrega. O lote exato de source_ids fica em `corporate_control.delivery_uncertain_ids`; seus payloads e IDs permanecem congelados. Reinício não remove o bloqueio. `corporate-resume` verifica explicitamente esse lote sob lock remoto e exige correspondência integral e COMMIT reconhecido da verificação. Essa verificação não cria recibos. A entrega normal revalida os mesmos IDs antes de confirmar localmente.

Ausência, divergência ou ambiguidade mantém `CORPORATE_COMMIT_RECONCILIATION_REQUIRED`. Não há nova atribuição nem INSERT automático para resolver esse caso. Um estado incerto antigo sem manifesto do lote também exige investigação específica. Não preencher o manifesto ou limpar o bloqueio manualmente para liberar a fila.

Falha comprovadamente anterior ao envio do COMMIT mantém o mesmo ID/payload e segue o backoff existente. Após COMMIT remoto reconhecido e falha local, o replay compara a linha corporativa sob lock e não reinsere uma linha reconhecida. Não há atomicidade distribuída presumida.

A recuperação de colisões continua com autorização/digest/UUID próprios. Uma nova liberação registra sua própria evidência sem sobrescrever a validação de uma reversão já validada. As 696 quarentenas existentes não são liberadas automaticamente.

## Pré-condições da transição local

A 014 instalou três triggers ALWAYS que impedem INSERT legacy em records, INSERT/troca de ID na tabela local e reversão do allocator. O binário de `1e062ff` também aceita somente a guarda local da 011 em `assertSchema`, sendo incompatível com a segunda guarda da 014. Apenas trocar a imagem ou restaurar a sequência não resolve esses dois bloqueios.

A **015 é uma transição para frente**, transacional e idempotente. Exige:

- Contratos locais 008–011 e 014 existentes e compatíveis; os três triggers da 014 habilitados em modo ALWAYS e corpo da função conhecido.
- Controle reconciliado, delivery pausado, allocator `legacy`, `id_allocator_required=false`, geração corporativa nula.
- Reversão anterior `completed` e validada; nenhum assignment remoto, readoção não abortada ou admission não materializada.
- Mesmo source/binding/target e fence consistente. Nenhuma geração ativa ou reserva desconhecida é revertida.

Pré-condição não satisfeita aborta toda a transação. Admissions pendentes ou adoção iniciada exigem análise própria; a 015 não as elimina nem assume que nunca houve efeito remoto.

A migration mantém `corporate_authority_contract` da 014, registra o estado anterior em `corporate_legacy_recovery` e substitui somente a política revisada de `guard_corporate_authority`. Os triggers originais continuam ALWAYS. INSERT em records exige o marcador transacional da nova rotina, vinculado exatamente a source/source_id/target_id; binários anteriores não produzem esse marcador. A tabela local raw continua bloqueada. Ativar outro allocator, mudar a origem ou a geração é recusado. Guardas adicionais congelam IDs/payloads e confirmações, sem reescrever nenhuma linha histórica.

O marcador de candidato protege contra execução acidental do binário antigo; não é uma fronteira contra um administrador que possa editar funções, permissões ou tabelas. O runtime verifica os corpos/definições canônicos e o vínculo da transição.

## Implantação futura — não executada

1. Manter scheduler STOPPED e Corporate Delivery pausado. Parar o processo para excluir transações em voo; confirmar locks e COMMITs pendentes. Inventariar os escritores do MADM e homologar contenção/timeout e privilégio do lock. Confirmar ausência de autoridade remota.
2. Fazer backup local atual, além do backup anterior à 014, incluindo spool, journals, receipts, outbox, quarentenas e reversões. Registrar contagens e hashes dos vínculos; os números informados não substituem a conferência local.
3. Em janela autorizada, aplicar **somente no PostgreSQL local**:
   ```sh
   psql --dbname="$LOCAL_URI_SEM_SENHA" -X -v ON_ERROR_STOP=1 -f migrations/015_corporate_legacy_recovery.sql
   ```
   Usar PGPASSFILE privado, não senha na URI. Nenhum comando SQL de implantação é necessário no MADM.
4. Se o ACK da migration se perder, abrir nova sessão, conferir `corporate_legacy_recovery`, os contratos e as guardas. Reaplicar a mesma 015 enquanto pausado é idempotente. Não remover objetos para forçar reaplicação.
5. Publicar separadamente esta branch, mantendo o processo pausado. Executar `corporate-status`, `corporate-check` e `corporate-verify-pending` pelos comandos existentes. A checagem corporativa usa lock transacional, mas não altera dados. Comparar os snapshots históricos. Se houver bloqueio por colisão, usar a recuperação existente com o digest efetivamente verificado, preservando a quarentena.
6. Autorizar `corporate-resume` apenas após as conferências. Retomar scheduler pelo controle existente, monitorando confirmações, pendências, bloqueios, latência do lock e capacidade da sequência.

## Critérios objetivos para liberar Corporate Delivery

A aprovação dos testes isolados permite revisão/publicação da branch; não comprova as condições reais de implantação. Todas as condições abaixo precisam de evidência registrada por um operador autorizado antes da liberação:

1. Imagem identificada pelo commit da correção, Node 24 e PostgreSQL 16 homologados; contratos locais 010/011/014 compatíveis e 015 aplicada integralmente. `corporate-status` e a abertura do worker aceitam as guardas canônicas sem drift. Uma 015 abortada não autoriza contornar suas pré-condições.
2. Source, binding, target e reversão validada correspondem ao snapshot aprovado. Nenhuma geração ativa, assignment remoto ou admission pendente foi descartada para viabilizar a transição.
3. Comparação antes/depois demonstra os mesmos IDs, hashes e recibos históricos e os mesmos membros da quarentena. Contagens são reconciliadas com o snapshot atual; os números fornecidos no chamado não são usados como atualização manual de contadores.
4. O índice UNIQUE parcial corporativo está válido e pronto; TLS, schema, identidade composta e privilégio de lock são aceitos por `corporate-check`. Não há autoridade remota instalada. Privilégio insuficiente mantém o bloqueio; não conceder privilégios indiscriminadamente para contorná-lo.
5. A verificação das pendências não encontra divergência nos itens que serão admitidos. Toda quarentena permanece excluída. COMMITs incertos têm prova exata do lote e reconciliação explícita concluída; manifesto ausente, linha ausente ou ambiguidade mantém o bloqueio. Uma retomada explicitamente autorizada pode realizar a verificação prevista no código; não se limpa `last_code` ou o manifesto por SQL manual.
6. Um ensaio representativo com os escritores externos demonstra aquisição do lock e conclusão dos lotes dentro dos timeouts configurados, sem sobrescrita, falso recibo ou duplicação no replay. O operador registra os limites de latência/vazão aceitos; sem esse ensaio, a compatibilidade dos escritores permanece não comprovada.
7. Após qualquer recuperação explícita necessária, o controle está pronto, sem bloqueio e sem backoff pendente. A passagem de `paused=true` para operação exige autorização operacional separada. **Esta entrega não executa `corporate-resume`.**

## Critérios objetivos para liberar o scheduler

A liberação do scheduler é independente do commit/push e só ocorre com autorização operacional específica:

1. Todos os critérios de Delivery acima foram atendidos, e uma entrega controlada de quantidade previamente aprovada comprovou correspondência entre linhas remotas, confirmações da outbox e recibos, com replay sem novas inserções.
2. Journal, spool e checkpoints foram conferidos, com espaço disponível e nenhum processamento local pendente que impeça nova captura segundo a política existente. Não há leitura ambígua nova, recovery obrigatório ou perda de ownership. Uma exceção histórica só é válida sob a autorização de continuidade já existente, válida e restrita à sua origem/parent; aceitar uma lacuna não comprova segurança do cursor remoto.
3. Existe um único owner da origem; não há worker antigo, coletor paralelo ou tarefa administrativa incompatível. A identificação da imagem e do serviço na VPS foi conferida pelo operador, sem criar outra instância coletora.
4. MADM e OLOS têm conectividade/TLS/configuração validados pelo procedimento operacional autorizado. A dependência nova do drain em relação ao MADM foi aceita e dimensionada; falha de alocação não é resolvida repetindo uma chamada OLOS ambígua.
5. Há monitoramento de leituras pendentes, avanço dos checkpoints, espaço de spool, idade da outbox, confirmações, colisões, COMMIT desconhecido, capacidade int32 e tempo de lock. Os critérios de interrupção estão definidos: nova ambiguidade de captura, divergência de identidade/recibo, perda de owner ou drift de contrato impedem a continuidade; indisponibilidade do MADM deixa o drain pendente sem descartar dados.

Nenhuma dessas condições reais foi verificada nesta execução, pois VPS e bancos reais estão fora da autorização. O scheduler permanece STOPPED; não se presume que delivery pausado ou um build aprovado autorizem sua retomada.

## Reversão operacional

Pausar delivery, parar scheduler/processo e preservar ambos os bancos e todos os ledgers. Manter a 015 e suas guardas. Uma imagem antiga sem o contrato da 015 deve permanecer parada: não é uma reversão segura habilitar novamente o allocator que não consulta o MADM. Não apagar o marcador, desabilitar triggers, redefinir a sequência ou alterar hashes.

Se nenhuma operação ocorreu depois da transição, o backup anterior serve para comparação/restauração isolada e eventual procedimento aprovado. Se houve capturas ou entregas novas, restaurar cegamente esse backup perde vínculos com dados remotos: não fazê-lo. Uma migração de volta a outra política exige reconciliação versionada própria. A reversão operacional segura desta entrega é manter o sistema parado com dados/proteções intactos.

## Limites e validação

- A persistência de **novas** chamadas agora consulta o MADM antes de congelar o ID. Indisponibilidade interrompe o drain; journal/spool e checkpoints permanecem recuperáveis. Isso preserva dados, mas reduz a independência operacional da captura em relação ao corporativo. Homologar latência e vazão antes de produção.
- O lock serializa a escrita corporativa durante cada lote e pode aumentar contenção. Não aumentar timeout como substituto de homologação.
- Escritores externos podem produzir novas identidades duplicadas depois de nosso COMMIT, pois não há UNIQUE corporativo para a identidade lógica. Podem também ocupar candidatos ainda não entregues. O worker bloqueia os casos detectados; não controla os demais escritores fora da sua transação.
- Owners/superusuários que removam o índice UNIQUE, alterem DDL ou dados já confirmados estão fora da garantia. Não declarar compatibilidade de produtores sem verificá-los.
- Não há remapeamento dos 696 itens históricos, nem recuperação automática de uma identidade ambígua ou COMMIT incerto sem prova.

Testes usam Node 24, PostgreSQL 16 descartável, TLS validado, rede `none` e zero portas publicadas. Os transports OLOS são sintéticos. Executar:

```sh
OLOS_DIRECT_TEST_FILES='test/corporate-legacy-recovery.integration.ts test/corporate-recovery.integration.ts' bash scripts/test-corporate-delivery.sh
node --import tsx --test test/corporate-delivery.test.ts test/corporate-recovery.test.ts test/corporate-sync.test.ts
npm run build
npm run typecheck
git diff --check
```

O runner padrão requer acesso ao Docker. Nesta sessão seus comandos foram executados diretamente em um container PostgreSQL novo com rede desabilitada; nenhum container existente foi usado como banco de teste. O typecheck-base possui 17 diagnósticos em `test/corporate-delivery.integration.ts`, relativos a history/assertHistoryReady, fora desta alteração. Resultados finais constam da entrega e do arquivo de evidência associado.
