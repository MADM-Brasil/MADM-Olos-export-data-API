# Importação histórica v1 somente com operador

Base conferida: `feature/exportdata-history`, `ee52c7e95f213bd40a0f2b06189dfac4442c0495`.
Escopo: admissão de pendentes em `identity-main` e em `corporate-drain-backlog`.
Os números informados (725.287 locais, 11.508 com operador, 713.779 sem operador e
11.262 pendentes com operador) são evidência fornecida pelo responsável; não houve
nova consulta operacional. Eles não substituem a seleção e as validações do plano.

## Regra de admissão

Exigir simultaneamente `records.agent_id` como inteiro decimal positivo canônico
(`^[1-9][0-9]*$`) e `payload.nome_agente` congelado como string não vazia após
desconsiderar espaços nas extremidades. São rejeitados `null`, `0`, `-1`, outros
negativos, decimais, expoentes, espaços no ID e representações não canônicas como
`007`. Não há conversão numérica, arredondamento ou substituição de AgentId.
O teste de nome reconhece também tabs, quebras de linha e espaços Unicode,
com os mesmos caracteres no PostgreSQL e no JavaScript.

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
2. Verificar os planos existentes. Para um plano incompatível ainda `planned`,
   revisar UUID/hash e obter autorização específica de cancelamento. Usar
   `identity-main cancel` ou `corporate-drain-cancel`, conforme os procedimentos
   vinculados abaixo. Para intenção incerta, seguir a reconciliação existente.
3. Escolher três **pendentes** elegíveis, com IDs antigos e sem recibos, da auditoria
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
4. Migrar 100 pendentes elegíveis com novo manifesto; então preparar e revisar
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
nomes ausentes/brancos, equivalência SQL/JavaScript, lotes 3/100/250/500/1.000,
tabulações, preservação integral dos excluídos, v1, deduplicação/idempotência,
planos antigos e cancelamento autorizado, reconciliação de entrega anterior sem
operador, locks, recibos, Kommo e leitura interrompida. Nenhum comando operacional
foi executado; nenhum banco real foi acessado.

Resultados em Node 24 e PostgreSQL 16 descartável:

- `npm run typecheck` e `npm run build`: aprovados.
- `npm test`: 106/106, sem skips.
- `scripts/test-corporate-delivery.sh`: 147/147, sem skips, incluindo Store/Admin.
- `scripts/test-corporate-sync.sh`: 39/39, sem skips.
- `git diff --check`: aprovado.

As CLIs de identidade e drenagem tiveram zero requisições à OLOS simulada.
Os testes não medem desempenho nem comprovam os volumes e a saúde da produção.
