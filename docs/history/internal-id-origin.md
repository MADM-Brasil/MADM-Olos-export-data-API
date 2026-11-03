# Origem de internal_id_olos: auditoria e transição controlada

> Atualização: a implementação posterior e o procedimento vigente de migração coordenada estão em [original-identity-migration-v1.md](original-identity-migration-v1.md). Após a adoção, a entrega exige IDs originais; diagnósticos e resultados anteriores abaixo permanecem como evidência histórica.

## Auditoria anterior à alteração

HEAD confirmado: `d1b60bf96288db019676be533a2da9d83697a99b`, branch `feature/exportdata-history`. O checkout contém o trabalho local anterior da drenagem (CLI, journals, documentação e testes), ainda sem commit; ele foi preservado. Nenhuma consulta a VPS, MADM ou OLOS reais foi feita. Os números de 725.287 mappings, 15.611 confirmados e 709.676 pendentes são contexto informado, não uma contagem verificada nesta sessão.

| Ponto auditado | Comportamento na base e impacto |
| --- | --- |
| `src/api.ts`, `src/mapping.ts` | JSON numérico é lido sem perda; `AttemptsRawDataID` vira `source_id` decimal canônico, até bigint assinado. `CallId` vira `olos_call_id`; `AgentId` é referência independente. O hash de origem usa os campos originais, não o ID local. |
| `src/store.ts` | O caminho local chama `nextval` para novos mappings e insere `internal_id_olos=target_id` com `OVERRIDING SYSTEM VALUE`. Releituras usam o mapping antigo. O caminho corporativo delega a `enqueue`. |
| `src/corporate-delivery/delivery.ts` | `enqueue` chama `nextval`, limita o resultado a int4 e congela o payload/hash com esse ID. A entrega não recalcula IDs: usa o payload congelado. Recibos só são confirmados após COMMIT remoto. |
| `src/corporate-delivery/reconcile.ts` | Adoção legado verifica mapping, recibos, hashes, identidades e allocator, preservando o ID antigo; não deve ser usada para renumerar. |
| `src/corporate-delivery/contract.ts` | Identidade lógica é `CallId + data_ligacao + telefone + campanha`; comparação exige os 14 campos. Colisão de ID ou mesma identidade em outro ID bloqueia. `raw_olos_call_id` é identity ALWAYS da MADM. |
| `src/corporate-delivery/selective-commit.ts` | Intenção e evidência incluem source_id, target_id, hashes e recibo remoto. Alterar um mapping/hash invalidaria a reconciliação de COMMIT incerto. |
| `src/corporate-delivery/preserved-history.ts` | A homologação anterior fixa os IDs locais dos três registros; esse escopo não pode ser reinterpretado como autorização de renumeração. |
| `src/corporate-delivery/drain*.ts` | Planos anteriores congelam IDs, hashes, datas e leitura. A alteração da origem não migra esses planos nem autoriza sua execução com IDs diferentes. |
| `src/corporate-sync/` | Worker standalone usa IDs e recibos existentes, valida identidade completa, não é um migrador de IDs e permanece excluído pela propriedade persistente do Direct Delivery. |
| `src/schema.ts` | Tabela local exige bigint/PK e sequência existente. Manter o schema e a sequência evita DDL implícito; a sequência deixa de ser consumida para novos mappings. |
| Migrations | `records`: PK `(source_key,source_id)`, único `(target_table,target_id)` bigint. `corporate_outbox`: target_id int4 único, payload/hash/recibo congelados. Journal seletivo e journal de drenagem conservam os IDs antigos. Contrato MADM: PK `raw_olos_call_id` bigint, índice único parcial em `internal_id_olos` int4. |

Substituir todos os `target_id` ou apenas os hashes seria inseguro: há dois espaços de IDs sobrepostos, recibos e intenções que apontam para o ID antigo, além de possíveis dependências externas. A correção segura imediata é atribuir o ID de origem somente quando ainda não existe mapping; migrar dados existentes exige outro protocolo auditável e outra autorização.

## Escopo da implementação segura

Novos mappings usam `AttemptsRawDataID`, sem `nextval`, fallback, truncamento ou passagem por Number. O caminho corporativo exige inteiro positivo até **2.147.483.647**, por causa do contrato int4 e da outbox int4. O caminho local bigint conserva valores exatos até **9.223.372.036.854.775.807**; isso não implica compatibilidade com MADM. Acima do limite corporativo, a entrega/admissão corporativa bloqueia; a ampliação para bigint exigiria revisão de schema/consumidores e está fora desta mudança.

Mappings já conhecidos continuam com seu target_id original. Duplicação não reescreve payload, hash ou recibo. IDs originais que já pertençam a outro mapping/local row bloqueiam a admissão; colisões e identidades divergentes remotas bloqueiam pelo contrato existente antes de confirmar qualquer entrega. A ausência de colisões em produção não foi verificada.

A sequência local não é apagada, avançada ou reiniciada. Na adoção legado, sua posição continua sendo conferida contra IDs antigos que diferem de source_id; IDs iguais ao original não precisam ter sido alocados por ela. O schema/privilegio da sequência e as demais guardas de adoção continuam exigidos. Corporate Delivery não é retomado, flags de escrita não são ativadas e nenhum consumidor/POST é iniciado por esta alteração.

## Pendentes: migração proposta, não implementada nem executada

1. Manter scheduler STOPPED/desabilitado, Admin inativo, escrita geral desabilitada e Delivery pausado. Cancelar planos de drenagem ainda não iniciados por seu comando próprio. Reconciliar toda intenção incerta pelos IDs/hashes antigos antes de propor renumeração; não limpar bloqueios por SQL.
2. Sob locks de origem, Sync, Delivery e histórico, criar manifesto privado e imutável por lote pequeno: source_key/source_id, antigo target_id, payload completo e hashes antigos, estado/origem/timestamps, eventual linha completa de `raw.olos_calls` **local**, novo ID pretendido, payload proposto e novo hash calculado sobre os 14 campos. O único campo de negócio que pode diferir é internal_id_olos; source_hash não muda. Versionar o protocolo e vincular aprovação ao digest do manifesto. Inventariar FKs/consumidores locais e recusar dependência Billing ou recibo confirmado associado ao mapping.
3. Fazer prova remota somente leitura para **ambos** os IDs e para a identidade lógica completa. Se a chamada existir no ID antigo, mesmo sem recibo local, tratar como confirmada/COMMIT possivelmente consumado; não inserir no novo ID. Se o novo ID estiver ocupado, bloquear. Não trocar IDs, não usar IDs temporários e não escolher outro número. Verificar também colisões entre propostas, outras origens e mappings/outbox não selecionados.
4. Preservar evidência anterior em journal local específico e imutável antes de qualquer substituição. Atualizar mapping, payload e hash em uma única transação local com CAS sobre estado pendente, source_hash, target_id, payload/hash e versão do plano. Se existir uma linha legada local, sua PK e referências também precisam de transição atômica auditada; deixá-la no ID antigo sem mapping faz `Store.open()` bloquear com `EXISTING_DESTINATION_REQUIRES_BASELINE`. A coluna local é `GENERATED ALWAYS AS IDENTITY`: PostgreSQL rejeita `UPDATE` direto da PK para outro valor; `OVERRIDING SYSTEM VALUE` se aplica ao INSERT, não resolve UPDATE. Essa dependência exige um procedimento local separado e aprovado; esta entrega não remove identity, não altera o schema e não apaga/reinsere a linha para contorná-la. Não criar linha local para capturas Direct Delivery que nunca a tiveram. Incluir checkpoints/journals associados, conservando suas versões; não inferir checkpoints por MAX dos novos IDs. Sem apagar/recriar outbox, sem alterar hash isoladamente. Uma colisão de UNIQUE, dependência não auditada ou mudança de evidência invalida o lote inteiro.
5. Entrega do novo contrato de identidade só após autorização específica, com intenção durável, fences e reconciliação capazes de distinguir as duas versões. Revalidar ausência/presença no destino imediatamente antes da escrita. A migração local isolada não garante atomicidade com a MADM.

Impedimento atual: não há journal/protocolo aprovado que preserve as duas versões de identidade e reconcilie sua transição, nem prova remota de ausência/colisão, nem procedimento aprovado para a PK identity ALWAYS das linhas locais legadas. Por isso este trabalho não fornece UPDATE em massa, migrador executável ou mudança de pendentes congelados. O comando de drenagem anterior continua consumindo os IDs antigos de seus planos; não usá-lo para homologar a nova identidade de um legado.

## Confirmados: estratégia separada e impedimentos

Os 15.611 recibos informados, incluindo os seis homologados, continuam válidos sob os IDs antigos. `47561569 -> 725262` não passa a significar `47561569 -> 47561569` por releitura. `raw_olos_call_id` deve permanecer a chave estável corporativa. Não reinserir a mesma chamada com novo internal_id_olos.

Antes de propor qualquer correção: inventariar FKs recebidas/emitidas em pg_constraint (inclusive ON UPDATE/deferrability), índices, triggers, views/functions, CDC, ETL, caches, relatórios e referências não declaradas; consultar cada ID antigo/novo e identidade lógica; comprovar correspondência exata de raw_olos_call_id, recibo e hashes; detectar colisões/ciclos e múltiplas origens. Não é possível provar a segurança dos consumidores somente pelo catálogo PostgreSQL.

Uma futura alteração autorizada precisaria preservar snapshot integral da linha corporativa e dependências, modificar somente internal_id_olos da linha identificada por raw_olos_call_id estável, não tocar telefone/Kommo/metadados/triggers, e reconciliar explicitamente o COMMIT da renumeração antes de atualizar os comprovantes locais versionados. O plano local deve abranger records/outbox, eventual raw local, corporate_sync.receipts, checkpoints e ambos os tipos de journal; não invalidar a prova antiga enquanto a nova ainda for incerta. Dependências com cascade/trigger que modifiquem outros campos contrariam o escopo e bloqueiam. Colisões, valores fora de int4 e consumidores desconhecidos impedem a operação. Não há UPDATE real ou SQL de compensação genérico nesta entrega.

## Homologação de três registros e rollback

Primeiro, somente em PostgreSQL descartável, usar três IDs sem mapping prévio (por exemplo 47561569, 47559439 e 47558756 em uma fixture limpa), com os respectivos CallIds 1031756916, 1031754969 e 1031754587. Verificar target/payload iguais ao AttemptsRawDataID, CallId independente, raw_olos_call_id gerado pela fixture MADM, 14 campos/hashes/recibos, replay sem INSERT e bloqueio de colisões/overflow. Uma fixture separada conserva os mappings antigos desses mesmos IDs para provar que a releitura não os migra.

Em ambiente operacional esses três IDs já existem com IDs locais: **não são candidatos a uma nova captura/entrega com IDs originais**. A homologação real deles depende dos planos B/C acima e está impedida até sua aprovação. Não adaptar a exceção histórica dos três registros para contornar isso. Com a leitura `132eb226-f4e4-419d-b79f-21dd0e6e64c1` em reading/RESPONSE_TOO_LARGE, não capturar novos dados, resolver a leitura ou retomar o scheduler. Um teste futuro com IDs inéditos também depende de resolver legitimamente o bloqueio histórico em trabalho separado.

Antes de gravar novos mappings, rollback é apenas reversão controlada do código, mantendo pausas. Depois de gravar IDs originais, não voltar a executar o allocator antigo: sua sequência pode estar atrás dos IDs agora ocupados. Preservar registros, outbox, snapshots e journals; manter processos parados até revisão de compatibilidade. Lotes confirmados não são apagados nem têm recibos rebaixados. Qualquer compensação de dados requer manifesto e autorização próprios, com prova de que não houve COMMIT remoto; incerteza exige reconciliação.

## Validação

Validação final em 2026-11-03:

- Node 24.16.0: `npm run typecheck`, `npm run build` e `npm test`: aprovados, **103/103** unitários.
- `bash scripts/test-corporate-delivery.sh`: **129/129**, incluindo Store/Admin e Corporate Delivery, com PostgreSQL 16 descartável, rede Docker interna, zero portas publicadas e OLOS simulada. Cobertura: IDs originais/CallId independente, identity automática MADM, limites exatos, colisões locais/remotas, legado, replay/recibos/hashes, Kommo, histórico intacto, locks, intenção durável/COMMIT incerto e reconciliação. O teste dos três novos IDs verifica zero HTTP à OLOS.
- `bash scripts/test-corporate-sync.sh`: **39/39** com PostgreSQL descartável.
- `git diff --check`: aprovado.

Na primeira execução corporativa, a fixture de um teste tentou renumerar a identity local por UPDATE e falhou (128/129). Ela passou a inserir diretamente a evidência histórica com `OVERRIDING SYSTEM VALUE`; a suíte completa foi repetida e passou. Uma execução intermediária dos unitários usou Node 20 do shell e falhou ao carregar Undici; a execução final usa explicitamente Node 24, exigido pelo projeto.

Nenhuma verificação sintética autoriza publicação ou comprova colisões/capacidade na produção. Não houve acesso real a VPS/MADM/OLOS, migração real, alteração da leitura interrompida, retomada de serviços, commit, push ou deploy.
