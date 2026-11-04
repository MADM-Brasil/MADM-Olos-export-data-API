# Drenagem administrativa e limitada do backlog v1

> Atualização sobre `b4aea2d`: novas entregas exigem IDs originais mesmo antes da adoção. A migração coordenada continua em [original-identity-migration-v1.md](original-identity-migration-v1.md); diagnósticos e resultados anteriores abaixo permanecem como evidência histórica.

Implementação sobre `d1b60bf`, no worktree `export-data-v3-history`. Os comandos abaixo são um procedimento para uma janela futura autorizada; não foram executados em VPS, OLOS ou MADM reais.

## Pré-requisitos e escopo

Usar Node 24 e configuração privada já revisada para a origem/destino corretos, TLS corporativo verificado e `OLOS_CORPORATE_WRITE_ENABLED=false`. Admin deve estar encerrado, scheduler desabilitado com estados desejado/real `STOPPED`, Corporate Delivery pronto e `paused=true`. Não executar `corporate-resume`, serviços, comandos de captura, `resolve`, `recover-local` ou `reread`.

É necessária a migration **exclusivamente local** `migrations/005_backlog_drain.sql`, além dos controles/journal seletivo anteriores. Ela cria duas tabelas de auditoria independentes; não altera tabelas existentes, payloads, IDs ou MADM. O runtime não aplica migrations. A aplicação em ambiente operacional é uma etapa manual separada, sujeita à revisão/autorização daquele ambiente. Ausência da estrutura gera `DRAIN_LOCAL_MIGRATION_REQUIRED`.

O pai obrigatório é `132eb226-f4e4-419d-b79f-21dd0e6e64c1`, `history/reading`, `RESPONSE_TOO_LARGE`, sem resposta, término ou resolução e com zero processados. O plano conserva uma cópia JSON da linha completa, com precisão PostgreSQL, e compara todos os campos novamente durante execução/reconciliação. Nenhuma coluna dessa leitura é atualizada. A guarda `guard()` também admite filhos `received` com array vazio comprovado pelos journals; `assertStage()` mantém sua função de controlar os degraus de lote.

Essa exceção requer `history_gap_plans`, `history_gap_children`, `history_gap_responses`
e `history_gap_members` da migration local 007 já existente, sem migration nova.
Cada filho pendente deve ter vínculo real, manifesto íntegro do mesmo pai/origem/
destino/binding/schema, bloco e spec exatos, início posterior ao pai, resposta
vazia com hash/tamanho íntegros, zero processados, recebido NULL/zero, nenhum
término/resolução e nenhum membro recuperado. A validação usa locks de linha e
se repete após a intenção durável, antes do COMMIT remoto. Não exige autenticação
nem configuração HTTP para drenar: os vínculos de entrega e journals locais são
conferidos sem chamar a OLOS. Uma leitura sem prova ou em `reading` bloqueia;
simplesmente colocar `gap` no JSON não autoriza a exceção.

O plano seleciona somente pendentes da origem, ordenados pelo `target_id` existente, cuja admissão local antecede `started_at` dessa leitura. O mapping também deve antecedê-la. A revisão sobre `f0ce103` restringe a data da chamada a setembro/outubro de 2026 em America/Sao_Paulo, com operador identificado, antes do LIMIT; ver [regra e lacunas atuais](identified-operator-import-v1.md). Admissões locais posteriores exigem a proveniência de recuperação descrita abaixo. Aceitam-se `capture` e `legacy_backlog`; outras origens, mappings ausentes, hash divergente, identidade divergente ou payload fora dos 14 campos v1 bloqueiam. Não se pula uma linha inválida dentro da seleção para completar o lote.

A exceção dos três registros de homologação e seu journal de até três registros permanecem inalterados. Os comandos seletivos antigos não ganham escopo adicional.

## Homologação com filho vazio preservado

Procedimento para janela operacional autorizada; não executado nesta revisão.
O incidente informado identifica o filho `09aeaeaa-cc32-415c-8137-2b95729ac131`,
manifesto `62f98c90-d3db-498c-a93b-ba844619e6a4`, bloco 1. Não há whitelist desses
UUIDs: possuir esses nomes sem os journals válidos não autoriza entrega.

1. Manter Admin encerrado, scheduler disabled/STOPPED, Delivery ready/paused,
   escrita geral false e ausência de COMMIT incerto. Conferir as migrations
   locais existentes; não executar `resolve`, `reset-read-data`, `capture-history`
   ou releitura. Preservar os arquivos de configuração/credenciais privados.
2. Guardar evidência privada somente leitura do pai, filho e journals antes da
   operação. Por exemplo, em transação `BEGIN READ ONLY`, consultar
   `SELECT to_jsonb(r) FROM olos_http.reads r WHERE id IN
   ('132eb226-f4e4-419d-b79f-21dd0e6e64c1','09aeaeaa-cc32-415c-8137-2b95729ac131')`;
   conferir plano/vínculo/resposta nas tabelas `history_gap_*`. O filho deve
   continuar `received` com `[]` e sem membros. Não editar hashes nem estados.
3. Preparar o plano de 100 abaixo, revisar UUID/hash e IDs selecionados no journal.
   Devem ser pendentes com operador/período válidos e IDs originais. Mapping e
   outbox devem anteceder o pai ou apresentar prova de filho `done` não vazio.
   Se faltarem 100 elegíveis para a primeira etapa, parar; não completar com
   tentativas sem operador, IDs legados ou dados posteriores sem proveniência.
4. Executar somente o UUID/hash/parâmetros revisados por `corporate-drain-backlog`
   e conferir `corporate-drain-status`. Comparar integralmente pai, filho,
   journals de lacunas e confirmados anteriores com a evidência inicial.
   Conferir novos recibos e igualdade dos payloads. O bloco vazio continua sem
   recuperação e não gera nenhum membro, chamada ou confirmação própria.
5. Crescer 100 → 250 → 500 → 1.000 somente pelas etapas existentes. Interrupção
   com intenção durável exige `corporate-drain-reconcile` específico, sem retry.
   Se uma prova mudar, conservar o bloqueio e investigar; não reparar leituras
   ou journals para fazê-los passar na guarda.

Planos antigos ainda não iniciados com IDs legados são rejeitados antes de novas
escritas; cancelar e replanejar pelo fluxo existente, sem reescrever seus hashes.
Intenções antigas conservam reconciliação com o escopo original. O filtro de IDs
originais não altera os recibos de uma entrega anterior.

Validação da revisão sobre `b4aea2d`: typecheck/build e 111 unitários aprovados;
163 testes no runner Corporate Delivery/Store/Admin e 39 no Corporate Sync,
todos sem skips, em PostgreSQL 16 descartável. Cobertura inclui pai sozinho,
filho vazio preservado, órfãos/desconhecidos, POST incerto, manifesto/hash
divergente, filho `done` com proveniência coexistindo com filho vazio,
registros anteriores/posteriores ao corte, IDs originais antes da adoção,
operador/período, deduplicação, recibos e COMMIT incerto. Nenhum banco real,
serviço OLOS real, commit, push ou deploy foi acionado.

## Plano e autorização

`corporate-drain-plan` cria uma seleção durável limitada, com IDs, hashes, proveniência e timestamps congelados, sem cópia de payload. Faz preflight corporativo somente leitura. Não entrega registros. Sua saída inclui `run_id`, `plan_hash`, quantidade, parâmetros e uma confirmação que vincula toda essa evidência à origem, binding, schema, leitura e ordem dos lotes.

`corporate-drain-backlog` exige os mesmos parâmetros e a confirmação exata do plano. Só executa os IDs congelados. Repetir uma execução terminada não seleciona novos pendentes. Uma execução interrompida em `running`/`failed` exige reconciliação; não existe retomada automática. Só pode existir um plano/execução não encerrado por vez.

Limites obrigatórios:

| Parâmetro | Limite |
| --- | --- |
| `--batch-size` | 1–1000 |
| `--max-batches` | 1–100; máximo de 10.000 registros por autorização |
| `--delay-ms` | 1000–60000, entre lotes |
| `--max-batch-ms` | 100–60000, orçamento de latência por lote |
| `--statement-timeout-ms` | 100–15000, não superior ao orçamento do lote |
| `--contract` | somente `v1` |
| `--preserve-history-read` | somente a leitura indicada acima |

Não há defaults ilimitados, daemon, agendamento ou wrapper de retry. A primeira execução exige exatamente 100 selecionados em um lote. Lotes acima de 100 requerem uma etapa completa de 100; acima de 250, uma de 250; acima de 500, uma de 500. Só qualificam execuções `completed`, com lote cheio confirmado, mesma origem/binding/schema e métricas de todos os lotes presentes dentro do orçamento. `stopped`, `failed` e `reconciled` não qualificam crescimento. Essa regra não substitui avaliação humana de saúde do banco.

## Homologação inicial de 100

Filhos concluídos pelo [protocolo de lacunas](gap-recovery-v1.md) podem admitir
registros posteriores ao corte mediante proveniência imutável validada e incluída
no novo manifesto. O corte continua obrigatório para os demais registros;
planos antigos não recebem essa exceção retroativamente.

Admissão posterior à base `ee52c7e`: a seleção exige AgentId válido e `nome_agente`
congelado preenchido antes do LIMIT. Planos anteriores incompatíveis exigem
cancelamento autorizado; intenções incertas preservam sua reconciliação original.
Ver [política e homologação somente com operador](identified-operator-import-v1.md).

Em uma janela autorizada, após verificar os pré-requisitos, revisar este plano:

```bash
drain_args=(
  --batch-size 100 --max-batches 1 --delay-ms 1000
  --max-batch-ms 10000 --statement-timeout-ms 2000
  --contract v1
  --preserve-history-read 132eb226-f4e4-419d-b79f-21dd0e6e64c1
)
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-drain-plan "${drain_args[@]}"
```

Revisar os parâmetros e a quantidade da saída. Substituir os placeholders abaixo pelos valores exatos desse plano, sem automatizar a aprovação:

```bash
drain_run_id='UUID_DO_PLANO_REVISADO'
drain_plan_hash='HASH_DO_PLANO_REVISADO'
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-drain-backlog \
  "${drain_args[@]}" --run-id "$drain_run_id" --plan-hash "$drain_plan_hash" \
  --confirm "AUTHORIZE_EXPORTDATA_DRAIN_V1:$drain_run_id:$drain_plan_hash"

OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-drain-status --run-id "$drain_run_id"
```

Esperado: um lote com 100 recibos confirmados, execução `completed`, nenhuma outra seleção, Corporate Delivery ainda pausado. `already_existing` informa quantos registros já existiam e foram reconhecidos sem INSERT/UPDATE. Essa contagem pode fazer o número de INSERTs ser menor que 100.

O status é somente leitura local e funciona durante a execução. Mostra quantidades, estados, duração, disponibilidade de métricas, erro e número de recibos. Não imprime payload, telefone, CPF, nome, email ou IDs de chamadas. Os comprovantes individuais ficam no journal local e na outbox, sujeitos ao controle de acesso do banco. Se a conexão cair ao criar o plano antes de imprimir o UUID, recuperar o identificador por consulta local somente leitura a `olos_http.corporate_drain_runs`; não apagar o plano para tentar de novo.

## Aumento gradual

Depois de conferir os 100 recibos e observar latência, locks, conexões, CPU/IO e impacto nas demais aplicações, criar outro plano com `--batch-size 250 --max-batches 1`. Repetir o procedimento de revisão/execução/status usando o novo UUID/hash/confirmação. Depois de uma etapa integral de 250, seguir para 500; depois de 500, para 1000. Manter uma única transação corporativa por vez e pausas conservadoras. Aumentar `delay-ms` se necessário. Não aumentar o orçamento de latência apenas para esconder sobrecarga.

Múltiplos lotes continuam exigindo `max-batches` finito e a soma máxima de 10.000 selecionados. Cada novo plano exige nova autorização. Para cancelar um plano ainda não iniciado, sem entregar registros:

```bash
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-drain-cancel \
  --run-id "$drain_run_id" --plan-hash "$drain_plan_hash" \
  --confirm "AUTHORIZE_EXPORTDATA_DRAIN_CANCEL_PLAN:$drain_run_id:$drain_plan_hash"
```

Esse comando conserva a auditoria, não acessa MADM e não altera recibos, histórico ou bloqueios. Recusa runs já iniciados; não substitui reconciliação. Um manifesto corrompido exige análise local, sem SQL de desbloqueio genérico.

## Proteções de transação e sobrecarga

- Locks de sessão de origem, Corporate Sync, Corporate Delivery, histórico e Admin durante toda a invocação, inclusive pausas; locks de linha para controle, leitura, settings e seleção. O fence remoto é o mesmo do protocolo seletivo existente. Concorrentes falham, não esperam indefinidamente.
- Schema, hashes v1, mapping, `internal_id_olos` e identidade lógica passam pelas funções já usadas pela entrega corporativa. Só os 14 campos entram em INSERT. Linhas existentes devem coincidir; não são atualizadas nem reinseridas. Kommo/defaults/metadados não gerenciados são preservados.
- Bloqueio local durável antes de iniciar lotes. Antes de cada COMMIT remoto, grava-se `intent` e confirma-se seu COMMIT local. Após isso, estado, snapshot histórico, manifesto, payloads e hashes são revalidados sob locks. Recibos locais só são confirmados depois do COMMIT remoto reconhecido.
- Primeira falha abre o circuit breaker e encerra a execução, inclusive falhas de rede. Uma intenção durável não resolvida nunca recebe retry automático. O estado anterior permanece auditável.
- Timeout de conexão, statement e lock remoto usa o menor entre o parâmetro autorizado e o timeout corporativo configurado. Limites locais de statement/lock também são aplicados; transação remota ociosa expira em 30 segundos. O orçamento do lote é verificado durante os INSERTs e antes do COMMIT. Uma operação já enviada pode levar até seu timeout para retornar; o orçamento não é um cronômetro capaz de desfazer COMMIT.
- Latência acima do orçamento interrompe os próximos lotes. Se o COMMIT já foi confirmado, os recibos válidos são preservados e o run exige revisão/reconciliação. Métricas ausentes permanecem `null`/`metrics_available=false`; não contam como prova de saúde nem habilitam crescimento.

## Pausa, reconciliação e rollback

`SIGINT`/`SIGTERM` solicitam parada. Entre lotes, encerram sem admitir outro e mantêm os recibos anteriores. Durante um lote, o comando alcança uma fronteira segura; não abandona um COMMIT em voo para alegar rollback. Encerramento abrupto, perda de sessão ou falha depois da intenção mantêm o run bloqueado e exigem reconciliação. Aguardar a saída antes de trocar binário ou liberar locks.

Parar diante de latência excessiva, contenção, indisponibilidade, conflito de identidade, alteração de schema/controle/histórico ou incerteza de COMMIT. `corporate-drain-status` fornece a confirmação específica de reconciliação. Depois de investigar o incidente e autorizar essa operação:

```bash
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-drain-reconcile \
  --run-id "$drain_run_id" --plan-hash "$drain_plan_hash" \
  --confirm "AUTHORIZE_EXPORTDATA_DRAIN_RECONCILIATION:$drain_run_id:$drain_plan_hash"
```

A reconciliação usa transações corporativas somente leitura, por lote e com a mesma pausa configurada. O fence impede provar ausência enquanto uma transação incerta ainda puder confirmar. Verifica presença/ausência e conteúdo dos IDs do manifesto, preserva recibos anteriores e só remove **seu próprio** bloqueio quando todos os lotes são reconciliados. Divergência ou mudança de evidência mantém o bloqueio. Ausência não dispara INSERT; eventual nova entrega precisa de novo plano. A leitura histórica não é resolvida.

Rollback de uma transação remota ainda não confirmada é transacional. Não existe rollback automático de lotes já confirmados: não apagar linhas MADM, não desfazer enriquecimento Kommo, não rebaixar recibos, não alterar IDs/hashes nem limpar journals. Uma reversão de negócio exige procedimento compensatório separado. Reverter apenas o código não elimina intenções duráveis: manter scheduler desabilitado, escrita geral desabilitada e entrega pausada; preservar as tabelas locais e usar versão capaz de reconciliar o journal.

## Validação e limites

Executar typecheck, build, unitários e `scripts/test-corporate-delivery.sh` em Node 24. O runner corporativo usa PostgreSQL 16 descartável, TLS verificado, rede interna e nenhuma porta publicada; a CLI é exercitada contra OLOS simulada com contador de zero requisições. Fixtures/migrations são aplicadas apenas nesse PostgreSQL temporário.

Resultado local: typecheck/build aprovados, 102/102 unitários e 123/123 testes no runner corporativo (incluindo Store/Admin e regressões seletivas/v2), sem skips; `git diff --check` aprovado. A sequência 100→250→500→1000 confirmou 1.850 registros, com comparação integral dos 14 campos e preservação de hashes/IDs/schema/Kommo/histórico. Também passaram autorização/limites, duplicação, incerteza antes/depois de COMMIT, falha de recibo local, reconciliação com fence/divergência, rede, SIGTERM real, cancelamento entre lotes, cancelamento de plano, latência, ausência de métricas e controles preexistentes. Recursos descartáveis removidos ao final. Nenhum serviço operacional, banco real, commit, push ou deploy foi acionado.

O teste sintético não prova disponibilidade, índices, latência, capacidade, trigger overhead ou saúde real da MADM. Não mede CPU, IO, saturação de conexões ou impacto nos demais clientes. O volume aproximado do backlog e as seis entregas reais são contexto informado, não foram verificados nesta implementação. Registros fora do corte histórico ficam para uma autorização posterior. Não há atomicidade distribuída; journals e reconciliação tratam a incerteza sem ocultá-la. Locks pressupõem participantes compatíveis; SQL manual e binários que ignorem os fences continuam fora dessa garantia.
