# Importação histórica v1 somente com operador

Revisão atual sobre `feature/exportdata-history`, HEAD `f0ce103` (04/11/2026).
Escopo: admissão de pendentes em `identity-main` e em `corporate-drain-backlog`.
O volume atualizado de **11.259 pendentes com operador** foi informado pelo
responsável, sem nova consulta operacional. Reaproveitar essa outbox existente;
não recapturar registros nem presumir que todos passam pelo recorte temporal,
pela validação de nome e pelas proteções de identidade/proveniência.

## Auditoria e lacunas

| Caminho existente | Constatação e tratamento |
| --- | --- |
| `capture-reread` | Captura bruta, com intenção durável e sem retry. A variante de lacunas permanece limitada à evidência de exportação de 28/10; não representa pesquisa por mês da chamada. Nenhuma mudança ou chamada nova. |
| `recover-local` / `history-gaps` | O manifesto exige todos os IDs ausentes na resposta salva. `[]` para os primeiros 100 IDs já produz `GAP_RESPONSE_INCOMPLETE`; não há recuperação nem criação de registros. Teste específico acrescentado, sem alterar essa proteção. |
| `corporate-drain-plan` / `corporate-drain-backlog` | Já usa os pendentes locais e filtra por operador antes do LIMIT. Faltava limitar a data da chamada. Agora seleciona setembro/outubro e rejeita nomes que sejam números/marcadores de ausência, revalidando antes de novas escritas. |

Uma resposta vazia preservada em filho `received` continua bloqueando novas
faixas e a drenagem (`DRAIN_HISTORY_CHANGED` por haver outra leitura pendente).
Não marcar o filho como `done`/`resolved`, apagar a resposta ou alterar o pai para
liberar entregas. Esse estado exige revisão/reconciliação específica com evidência;
esta correção não cria uma exceção para contorná-lo. Se o filho já estiver
concluído por outro caminho, isso não comprova recuperação dos IDs ausentes.

Não há evidência nova de cobertura integral de setembro ou outubro. A faixa de
100 IDs com `[]` permanece **não recuperada**; sem consultar o banco operacional
não é possível atribuir todos os dias/volumes faltantes a cada mês. Datas de
exportação, min/max e totais locais não comprovam cobertura mensal.

## Regra de admissão

Exigir simultaneamente `records.agent_id` como inteiro decimal positivo canônico
(`^[1-9][0-9]*$`) e `payload.nome_agente` congelado como string não vazia após
desconsiderar espaços nas extremidades. São rejeitados `null`, `0`, `-1`, outros
negativos, decimais, expoentes, espaços no ID e representações não canônicas como
`007`. Não há conversão numérica, arredondamento ou substituição de AgentId.
O teste de nome reconhece também tabs, quebras de linha e espaços Unicode,
com os mesmos caracteres no PostgreSQL e no JavaScript.
Nomes apenas numéricos ou os marcadores `-1`, `null`, `undefined`, `n/a`, `unknown`,
`desconhecido`, `sem operador`, `sem agente`, `não identificado` e `nao identificado`
também são excluídos, ignorando maiúsculas e espaços externos. Um texto arbitrário
não comprova a identidade de uma pessoa: os demais nomes devem vir das referências
reais previamente revisadas. Não há consulta nem preenchimento artificial de nomes.

A drenagem exige `data_ligacao` entre **01/09/2026 00:00 inclusive e
01/11/2026 00:00 exclusive, em America/Sao_Paulo**. No payload UTC isso corresponde
a `[2026-09-01T03:00:00.000000Z, 2026-11-01T03:00:00.000000Z)`.
Para destino `timestamp`, usa a projeção no fuso corporativo já confirmado.
As comparações mantêm os seis dígitos de microssegundos e não dependem do timezone
da sessão PostgreSQL. O filtro também é aplicado antes do LIMIT e na execução
de cada lote. Não se usa a data de exportação como data da chamada.
CPF, e-mail e Lead ID podem permanecer NULL; não são critérios de admissão.

Esse é apenas um critério de seleção: nenhum nome é aparado, completado ou buscado
novamente na OLOS. Tabulação, tempos e os demais campos congelados permanecem
iguais, mesmo quando a tabulação está ausente. Não há coluna nova, migration nova
ou adoção do contrato v2. AgentId continua independente de CallId e AttemptsRawDataID.

`identity-main plan --kind pending` recebe uma lista explícita: **qualquer item
inelegível rejeita o lote inteiro**, com `IDENTITY_OPERATOR_REQUIRED`, antes de
gravar o plano ou migrar IDs. Não reduz silenciosamente a lista. A execução
revalida os registros sob os locks existentes; a migração continua alterando
somente o ID para AttemptsRawDataID e o payload/hash correspondente, preservando
o source_hash e as evidências antigas no journal.

`corporate-drain-plan` filtra antes do LIMIT e aplica os limites e degraus já
existentes. Se não houver 100 elegíveis para a primeira drenagem, recusa o plano.
Após a adoção de identidade, exige também `target_id = source_id`, como antes.
A execução confere **todos** os lotes do manifesto antes de iniciar o primeiro,
e repete a validação em cada lote e antes do COMMIT remoto. Tentativas excluídas
permanecem locais e pendentes, com os mesmos IDs, payloads, hashes e timestamps.

## Planos anteriores e reconciliação

Não se recalcula hash, remove item, substitui ID ou reinterpreta autorização de
plano anterior. Um plano compatível pode executar com seu UUID/hash original.
Um plano ainda não iniciado com item sem operador falha com
`IDENTITY_OPERATOR_PLAN_CANCEL_REQUIRED` ou `DRAIN_OPERATOR_PLAN_CANCEL_REQUIRED`.
Na drenagem, datas fora de setembro/outubro geram `DRAIN_PERIOD_PLAN_CANCEL_REQUIRED`.
Permanece `planned`, preservando evidências e sem iniciar entrega parcial.
É necessário **cancelamento autorizado** pelo comando existente e, depois,
novo plano com escopo elegível. Novos planos continuam bloqueados enquanto houver
outro aberto. Divergências de dados/hashes continuam sujeitas aos validadores de
integridade; não devem ser corrigidas por edição de manifestos ou recibos.

Runs iniciados ou com COMMIT incerto continuam bloqueados e exigem reconciliação
explícita, sem retry ou cancelamento de intenção. A reconciliação lê o escopo
original completo, inclusive itens sem operador enviados por versões anteriores;
reconhece somente recibos comprovados no destino e não faz novos INSERTs.
Aplicar o novo filtro à reconciliação ocultaria entregas já realizadas.
Reexecução de runs concluídos e o protocolo separado dos três confirmados não
recebem o novo filtro. Este patch não renumera nem modifica chamadas confirmadas.

## Homologação posterior, mediante autorização operacional

1. Manter Admin inativo, scheduler desabilitado/STOPPED, escrita geral
   `OLOS_CORPORATE_WRITE_ENABLED=false` e Delivery pausado. Usar o novo binário
   compatível e a revisão de dependências aprovada. Preservar a leitura
   `132eb226-f4e4-419d-b79f-21dd0e6e64c1` em `reading/RESPONSE_TOO_LARGE`.
2. Conferir primeiro as leituras pendentes e os planos existentes. Se a releitura
   vazia ainda estiver `received`, **não executar a drenagem**: o bloqueio descrito
   acima permanece. Para um plano incompatível ainda `planned`,
   revisar UUID/hash e obter autorização específica de cancelamento. Usar
   `identity-main cancel` ou `corporate-drain-cancel`, conforme os procedimentos
   vinculados abaixo. Para intenção incerta, seguir a reconciliação existente.
3. Se houver IDs legados ainda não migrados, escolher três **pendentes** elegíveis,
   de setembro/outubro, com IDs antigos e sem recibos, da auditoria
   autorizada. Não usar os exemplos já confirmados. Preparar:

   ```bash
   OLOS_CORPORATE_WRITE_ENABLED=false node dist/identity-main.js plan \
     --kind pending --source-ids 'ID_1,ID_2,ID_3' \
     --dependency-review 'SHA256_DA_REVISAO_APROVADA'
   ```

   Revisar manifesto privado e autorizar `execute` com o UUID/hash e confirmação
   exatos retornados. Conferir estado `completed`, IDs originais, os outros 13
   campos iguais, source_hash preservado e journal com evidência anterior/nova.
   Essa etapa migra localmente; não entrega à MADM.
4. Reutilizar os pendentes elegíveis já locais. Para os que já têm identidade
   original validada, não repetir a migração. Se necessário, migrar 100 pendentes
   elegíveis pelo fluxo existente com novo manifesto; então preparar e revisar
   `corporate-drain-plan` com `--batch-size 100 --max-batches 1 --contract v1` e
   os demais parâmetros obrigatórios do [procedimento de drenagem](backlog-drain-v1.md).
   Autorizar `corporate-drain-backlog` somente para esse UUID/hash/parâmetros.
   Conferir 100 recibos, payloads v1, IDs originais, leitura intacta, Delivery
   pausado e ausência de alterações nas tentativas excluídas ou já confirmadas.
5. Avançar para 250, 500 e 1.000 somente após etapa precedente concluída, medida
   e revisada, sempre com novo manifesto/autorização e limite finito. A migração
   rejeita listas mistas; a drenagem seleciona apenas elegíveis. Ausência de
   métricas não comprova capacidade da MADM.

Parar diante de conflito, falta de elegíveis, divergência de hash/identidade,
sobrecarga ou COMMIT incerto. Não completar nomes, limpar bloqueios, reenviar
confirmados ou marcar tentativas sem operador como entregues. Reverter código
para versão sem o filtro reabriria a admissão: manter processos parados e a
entrega pausada até revisão. Não desfazer recibos ou entregas já confirmadas.
Rollback e reconciliação seguem [migração de identidade](original-identity-migration-v1.md)
e [drenagem](backlog-drain-v1.md), preservando todos os journals.

## Validação local

Os testes usam PostgreSQL descartável e OLOS simulada. Cobrem seleção mista,
nomes ausentes/brancos e marcadores, limites mensais com microssegundos no fuso
de São Paulo, equivalência SQL/JavaScript, lotes 3/100/250/500/1.000,
tabulações, preservação integral dos excluídos, v1, deduplicação/idempotência,
planos antigos e cancelamento autorizado, reconciliação de entrega anterior sem
operador/fora do período, locks, recibos, Kommo e leitura interrompida. O caso
específico `[]` para 100 IDs preserva pai, filho, resposta e backlog, não repete
HTTP nem permite contornar o bloqueio de drenagem. Nenhum comando operacional
foi executado; nenhum banco real foi acessado.

Resultados desta revisão, em Node 24 e PostgreSQL 16 descartável (04/11/2026):

- `npm run typecheck` e `npm run build`: aprovados.
- `npm test`: 111/111, sem skips.
- `scripts/test-corporate-delivery.sh`: 159/159, sem skips, incluindo Store/Admin.
- `scripts/test-corporate-sync.sh`: 39/39, sem skips.
- `git diff --check`: aprovado.

Runner corporativo com TLS verificado, rede interna e zero portas publicadas.
Recursos descartáveis removidos ao final. Sem commit, push, deploy ou alteração
dos documentos de revisão de dependências que já estavam não rastreados.

As CLIs de identidade e drenagem tiveram zero requisições à OLOS simulada.
Os testes não medem desempenho nem comprovam os volumes e a saúde da produção.
