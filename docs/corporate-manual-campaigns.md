# Exclusão de campanhas manuais na entrega corporativa

Implementação e testes exclusivamente locais. Nenhum acesso à VPS, OLOS real ou MADM real; nenhuma migração produtiva, commit, push ou deploy.

## Mapeamento efetivamente encontrado

Este checkout entrega em **PostgreSQL**, usando `pg` e exigindo banco corporativo `madm`, tabela `raw.olos_calls`. Não contém escritor SQL Server. A proteção cobre os escritores PostgreSQL existentes; um destino SQL Server diferente precisa ter seu caminho de código identificado separadamente.

`src/cache.ts` lê a referência ExportDataV3 `Campaign`, indexando `CampaignId → Description`. `src/mapping.ts` usa o `CampaignId` da chamada para preencher `id_campanha_olos` e a Description para preencher `nome_campanha_olos`. Corporate Delivery congela essa projeção na outbox; Corporate Sync legado copia a mesma coluna da origem local. Não foi alterado esse mapeamento.

Não há IDs oficiais confirmados dessas duas campanhas no checkout. Nenhum ID foi inferido de Billing, nome do operador, AgentStatus ou amostras sintéticas. O critério é o nome congelado: comparação integral, sem distinguir maiúsculas/minúsculas, com trim e compactação de espaços Unicode. Só `Ligacao Manual` e `Ligacao Manual GS` são bloqueadas; não se usam prefixos, substring ou remoção de acentos. Nome/ID/payload não são normalizados para gravação: a normalização serve apenas à decisão. SQL e JavaScript compartilham a lista de nomes e de espaços; SQL usa collation C para comparação determinística.

## Pontos de proteção e outbox

| Caminho | Comportamento |
| --- | --- |
| Captura nova (`CorporateDelivery.enqueue`) | Nome manual: `skipped` + `delivery_policy_code=MANUAL_CAMPAIGN_EXCLUDED`, no mesmo COMMIT de records/outbox/checkpoint. Payload/hash e resposta bruta preservados. Não conta como entrega/recibo confirmado |
| Nome ausente/vazio, ID presente e operador elegível | `pending` + `CAMPAIGN_IDENTIFICATION_REQUIRED`; permanece protegido, sem fabricar nome/ID |
| Operador inelegível | Mantém a regra anterior de skipped. Campanha manual recebe seu motivo específico; caso contrário não se inventa outro motivo |
| ID ausente ou identidade corporativa inválida | Mantém a validação anterior: recusa congelamento, preserva resposta `received` e checkpoint. Não libera a leitura nem fabrica identidade |
| Pending anterior | Não altera estado, payload, hash, recibos ou código retroativamente. Nome manual/ausente é excluído da seleção automática **antes do LIMIT**. Outras campanhas continuam avançando |
| Escrita automática / `corporate-deliver-once` | Seleção filtrada; revalidação do conjunto antes da conexão remota e de cada INSERT |
| Função de homologação/seleção limitada | Não muda o conjunto selecionado silenciosamente. Se contiver campanha bloqueada ou desconhecida, recusa o lote, preservando pausa, dados e contadores. Erro de política não é tratado como perda da sessão local |
| Corporate Sync legado | Filtra novas seleções antes do LIMIT. Um lote já congelado incompatível é recusado integralmente com erro não retentável; não altera manifesto/checkpoint/recibos. A função de INSERT também valida o lote completo |

Os dois INSERTs corporativos estão em `src/corporate-delivery/delivery.ts` e `src/corporate-sync/worker.ts`; ambos usam `assertCampaignAllowed`. Essa regra é reutilizada em retentativas e reprocessamento local por `Store.drain`/`reread`, sem modificar o consumo ExportDataV3, scheduler ou recuperação.

Não existe CLI de entrega por lista exata de source IDs neste checkout. A função de homologação limitada existente foi protegida; o comando CLI de homologação e interfaces de history continuam com as falhas preexistentes discriminadas na validação. Não foram criados comandos ou consumidores paralelos.

Registros corporativos já existentes não são excluídos ou atualizados. Pending manual após possível COMMIT corporativo anterior permanece pending para reconciliação: não é descartado, reinserido ou confirmado por suposição. A reconciliação de recibos já existentes mantém seu comportamento anterior.

## Schema local e publicação futura

`migrations/005_corporate_campaign_policy.sql` adiciona somente a coluna nullable `delivery_policy_code` à outbox local, sem default, backfill, índice ou mudança nos hashes. CHECK NOT VALID evita validar todo o histórico na instalação, mas protege novos INSERTs/UPDATEs. A reaplicação é idempotente, com lock timeout 2 s e statement timeout 5 s. Nenhum DDL corporativo foi acrescentado.

O código corporativo recusa inicialização com `CORPORATE_CAMPAIGN_POLICY_MIGRATION_REQUIRED` se faltar a coluna. Uma publicação futura exige revisão/aplicação **explicitamente autorizada** dessa migração local antes do código e privilégios adequados à nova coluna. Não há execução automática na aplicação. Não aplicar migrações por glob sem revisar as demais.

Rollback de código exige entrega corporativa pausada/escrita desabilitada: a versão anterior não conhece a exclusão e pode voltar a consumir pendências manuais. Preservar a coluna e os motivos persistidos; não executar DROP/backfill/limpeza automaticamente.

## Pendências antigas e diagnóstico

Não foi incluído descarte/reclassificação automática das pendências antigas. Primeiro obter inventário somente leitura, incluindo o nome congelado, identidade, estado, hash e eventual motivo:

```sql
BEGIN READ ONLY;
SELECT source_key, source_id, target_id, state, delivery_policy_code,
       payload_hash, payload->>'nome_campanha_olos' AS frozen_campaign
FROM olos_http.corporate_outbox
WHERE state IN ('pending','skipped')
ORDER BY target_id;
COMMIT;
```

Filtrar/classificar esse inventário pela função compartilhada `campaignPolicyCode` preserva exatamente o critério de runtime. Códigos NULL em itens antigos não significam autorização de entrega. Para pending manual com resultado remoto incerto, verificar recibos/identidades antes de propor qualquer mudança. Lotes congelados incompatíveis precisam de um plano de reconciliação/cancelamento autorizado; não podem ser parcialmente editados nesta correção. Nomes ausentes não são preenchidos automaticamente, mesmo após uma atualização de cache.

Os contadores confirmed, recibos e gerações avançam apenas para linhas efetivamente confirmadas. Pending protegido continua visível como pending; skipped continua tendo a semântica anterior nos relatórios. Snapshots persistidos e refresh manual da dashboard não foram alterados.

## Validação

Node 24, PostgreSQL descartável e MADM simulado com TLS. Testes verificam ambas as campanhas, case/espaços Unicode e paridade SQL/JS, campanha convencional com AgentStatus=9, idempotência/reread, preservação bruta/checkpoints, avanço após pendências excluídas com LIMIT=1, lote selecionado, retry legado, ausência de nome/ID, COMMIT anterior potencialmente incerto, preservação dos registros corporativos existentes e migração idempotente sem backfill.

```sh
npm test -- --test-concurrency=1
npm run build
./node_modules/.bin/tsc -p tsconfig.corporate-sync.json
bash scripts/test-corporate-delivery.sh
bash scripts/test-corporate-sync.sh
npm run test:admin-ui
```

Resultados finais e comparação por diagnóstico: `docs/evidence/corporate-manual-campaigns.json`. As suítes completas não são declaradas integralmente aprovadas quando contêm falhas preexistentes.

Arquivos: `src/corporate-sync/campaign-policy.ts`, `src/corporate-sync/worker.ts`, `src/corporate-delivery/delivery.ts`, migração 005, `test/corporate-campaign.test.ts`, `test/corporate-delivery.integration.ts`, `test/corporate-sync.integration.ts`, `test/corporate-sync.fixture.ts`, esta nota e evidência JSON.

Limitações: IDs oficiais e equivalência de eventuais outros nomes/renomeações não foram confirmados. A proteção usa nomes congelados; ampliar critérios exige evidência. Muitas pendências históricas excluídas podem aumentar o custo da seleção até sua revisão, embora não ocupem o LIMIT nem disparem retentativas remotas. Validação sintética não demonstra desempenho ou compatibilidade de um SQL Server externo nem substitui homologação do ambiente real.
