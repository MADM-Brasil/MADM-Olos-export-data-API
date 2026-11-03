# Auditoria: contrato v2 com histórico interrompido

Base auditada: `ce21b8326019a2098ff772bc43459ff0c654d629`, em `/home/madm/madm/export-data-v3-history`. Estado de produção informado pelo solicitante, sem consulta ou alteração de produção nesta auditoria. Implementação e validação posteriores são locais; não constituem homologação real da MADM.

**Conclusão:** é possível homologar o contrato v2 independentemente da recuperação histórica, com uma exceção explicitamente limitada a esta ocorrência e aos três registros preexistentes. No commit base, os comandos disponíveis bloqueiam essa operação. Não é seguro remover o bloqueio global, resolver a leitura para contorná-lo, liberar a fila geral ou repetir a captura.

A leitura `132eb226-f4e4-419d-b79f-21dd0e6e64c1` deve permanecer `history/reading`, `error_code=RESPONSE_TOO_LARGE`, sem resposta, com `processed_count=0`. O limite HTTP pode ser atingido pelo Content-Length ou durante o stream, depois de o servidor já ter consumido os dados. Cancelar a leitura local não desfaz o consumo na OLOS. Zero registros processados não comprova zero consumo remoto.

## Bloqueios no commit base

Considerando configurações e autorizações válidas, sem outro erro anterior:

| Comando | Efeito de uma leitura `history/reading` |
| --- | --- |
| `corporate-operator-plan`, `corporate-adopt-operator`, `corporate-prepare-operator` | `lockSelection` rejeita com `HISTORY_RECOVERY_REQUIRED`; há também um segundo bloqueio para qualquer `reading/received`, `LOCAL_CAPTURE_RECOVERY_REQUIRED`, em `operatorAdmin`. |
| `corporate-deliver-selected`, `corporate-reconcile-selected` | `lockSelection` rejeita com `HISTORY_RECOVERY_REQUIRED`, antes da conexão de entrega/reconciliação ao destino. |
| `corporate-resume` | Rejeita com `HISTORY_RECOVERY_REQUIRED`; sem autorização de escrita, falha antes com `CORPORATE_WRITE_NOT_AUTHORIZED`. |
| `corporate-reconcile` | `reconcileLegacy` rejeita qualquer `reading/received` com `LOCAL_CAPTURE_RECOVERY_REQUIRED`. |
| `capture-history` | `assertHistoryReady` exige ausência de pendências; `HISTORY_RECOVERY_REQUIRED` antes de autenticar/consumir. |
| `once`, `previous`, `reread` | `Worker.cycle` rejeita histórico pendente com `HISTORY_RECOVERY_REQUIRED`, inclusive `reread` com recovery=true, antes de inicializar a API. |
| `capture-once` | `RECOVERY_REQUIRED`, antes da autenticação. |
| `capture-reread` | Não recupera history: exige o pai current fixo `5ec94595-11a0-469b-9e1e-c4c801e0479f`, data/faixa autorizadas; falha por escopo/pai inválido ou por outra leitura pendente. |
| `recover-local` | History precisa estar `received`; `reading` gera `HISTORY_RECOVERY_REQUIRED` antes da API. |
| `start`, `admin` | Abrir Admin/scheduler não tem bloqueio global de history. A admissão do consumidor agendado e cada ciclo rejeitam qualquer pendência com `RECOVERY_REQUIRED`, antes de consumir. Esses comandos podem alterar estado administrativo; não usá-los neste procedimento. |
| `corporate-deliver-once` | Não tem bloqueio próprio de history: exige escrita habilitada e `tick` não entrega com `paused=true` ou `blocked=true`. Não confundir isso com um bloqueio universal por leitura pendente. |
| `status`, `check`, `inspect-schema`, `corporate-status`, `corporate-check`, `corporate-pause` | Não bloqueados apenas pela leitura. Permanecem sujeitos a locks, binding/schema e demais precondições. `corporate-pause` é uma mutação; `corporate-check` lê o destino. |
| `resolve` | Não bloqueado por history: aceita texto de evidência com pelo menos 10 caracteres. Isso não valida a evidência. Não executar para liberar a homologação. |
| `log-read`, `reconcile-names` | Não têm guarda global de history e podem fazer HTTP à OLOS. Fora deste procedimento, mesmo que `reconcile-names` não reescreva a outbox corporativa. |

Os locks de sessão impedem concorrência ativa, independentemente do journal persistente: origem (`lockSource`), Corporate Sync `(17320914,1)`, entrega `(17320914,4)`, histórico `olos-http:history:<source>`. Captura/recovery usa histórico exclusivo; seleção usa compartilhado. Uma sessão histórica ativa pode produzir `HISTORY_CAPTURE_ACTIVE` antes de se examinar `reading`.

Referências: [main](../../src/main.ts), [worker](../../src/worker.ts), [store](../../src/store.ts), [consumidor agendado](../../src/admin/consumer.ts), [entrega](../../src/corporate-delivery/delivery.ts), [lock seletivo](../../src/corporate-delivery/selective-commit.ts), [adoção](../../src/corporate-delivery/operator-admin.ts).

## Alteração local proposta

Opção final `--preserve-history-read 132eb226-f4e4-419d-b79f-21dd0e6e64c1`, exclusivamente nos cinco comandos de plano, adoção, preparação, entrega seletiva e reconciliação seletiva. Sem a opção, mantêm-se os bloqueios anteriores. Não existe variável de ambiente para liberar history globalmente.

[Guarda da ocorrência](../../src/corporate-delivery/preserved-history.ts) fixa as identidades:

| source_id | AgentId | target_id |
| --- | --- | --- |
| 47561569 | 1658 | 725262 |
| 47559439 | 1467 | 724965 |
| 47558756 | 1565 | 724892 |

A opção exige exatamente uma pendência da origem, igual ao Read ID e ao estado/erro acima, sem resolução ou término. Mesmo plano/adoção verificam a existência dos três mappings/outbox, origem `capture`, igualdade de source_hash/target e criação anterior ao início histórico, com comparação de timestamps no PostgreSQL. Preparação/entrega/reconciliação exigem o conjunto completo, sem IDs adicionais ou subconjuntos.

Preservam-se locks existentes e acrescenta-se lock de sessão `olos-admin:<source>`: processo Admin ativo bloqueia, mesmo que o scheduler esteja parado. Exige-se configuração administrativa existente com `enabled=false`, `desired_state=STOPPED`, `runtime_state=STOPPED`; control ready e paused, binding consistente e escrita geral desabilitada. Locks de linhas protegem leitura, settings e mappings. Locks de sessão sobrevivem ao COMMIT da intenção seletiva; as precondições são revalidadas depois dele e antes do COMMIT remoto. A seleção continua sujeita ao fence remoto `(17320914,5)` e aos fences de recibos.

Não há alteração nas migrations, no transporte HTTP, nos caminhos de captura/resolve, na configuração nem no scheduler. O módulo não abre HTTP. A opção é rejeitada nos demais comandos antes de abrir banco/HTTP. O escopo fixo é deliberado: outra ocorrência requer nova auditoria, não reaproveitamento desta exceção.

## Schema e recuperação futura

- A migration corporativa já existente adiciona somente `id_operador_olos text NULL`, sem default; a migration local 004 cria o journal de adoção/revisão. Nenhuma é executada automaticamente pelo runtime. Ambas foram usadas apenas no PostgreSQL descartável.
- Plano/adoção comparam schema completo e funções de normalização. Retirar apenas a nova coluna do schema observado precisa reproduzir o hash anterior; qualquer outra divergência bloqueia. Adoção atualiza `destination_shape/schema_hash` locais e registra hash anterior/novo, sem alterar reads, records, checkpoints, sequence ou recibos.
- Preparação altera apenas os três payloads pendentes e seus hashes de entrega. Guarda payload/hash anteriores e novos em `corporate_operator_payloads`. `source_hash`, target e AgentId de origem permanecem iguais. Recibo já confirmado não é reescrito pela preparação.
- `source_hash` e deduplicação não dependem do contrato de entrega. Numa futura recuperação com resposta original comprovada, duplicatas com o mesmo source_hash preservam payloads/recibos existentes, inclusive v1; conteúdo divergente continua bloqueando. Novos registros usam v2. History continua sem filtro de baseline e sem entrega automática.
- Esta exceção rejeita `received` ou progresso parcial. Se surgir resposta durável comprovada, a recuperação deve ser auditada separadamente. Não há comando novo para injetar resposta ou marcar a leitura resolvida.
- O teste de recuperação futura injeta uma resposta **sintética** somente no banco descartável. Não prova que a resposta real existe, que a OLOS a reteve ou que a cobertura histórica é completa.
- Um COMMIT remoto desconhecido mantém o journal seletivo `unresolved` e o control bloqueado/pausado, além da leitura histórica intacta. Nova entrega não contorna isso. A reconciliação seletiva autorizada lê o destino, valida hashes/identidades/schema e resolve somente o journal seletivo; não insere remotamente nem resolve history.

Adoção v2 tem efeito sobre novos payloads futuros. O backlog v1 não selecionado permanece congelado e não pode ser liberado em massa sem uma avaliação própria; os testes não autorizam entrega geral.

## Procedimento operacional recomendado — não executado

1. Revisar o diff e os resultados descartáveis. Produção permanece sem alteração até uma janela separadamente autorizada; este relatório não instrui deploy agora.
2. Na janela futura, verificar em modo somente leitura a identidade da origem/destino, o Read ID completo, todas as pendências, estados administrativos, hashes e os três mappings/outbox. Preservar evidência privada de reads, records, recibos, outbox, journals, controles e sequence. Não despejar payloads pessoais em logs.
3. Manter Admin encerrado, scheduler STOPPED, Corporate Delivery pausado e `OLOS_CORPORATE_WRITE_ENABLED=false`. Não iniciar Corporate Sync, capturas, `log-read`, `resolve` ou wrappers de retry.
4. Verificar se as migrations locais 003/004 e a coluna corporativa aditiva já existem. Se não existirem, parar: a aplicação manual pertence a uma mudança separada revisada/autorizada. Não editar hashes/control por SQL para fazer o plano passar. Sem dependências locais compatíveis, schema aditivo e journal seletivo reconciliado, não prosseguir.
5. Com executável revisado e configuração privada já validada, planejar; revisar os hashes retornados; adotar; preparar; entregar somente os três. Cada comando termina e libera as sessões. Entre comandos, a pendência e a pausa permanecem. Exemplos para a janela futura:

```sh
history_read='132eb226-f4e4-419d-b79f-21dd0e6e64c1'
source_ids='47561569,47559439,47558756'
export OLOS_CORPORATE_WRITE_ENABLED=false

node dist/main.js corporate-operator-plan --preserve-history-read "$history_read"

# Preencher apenas com os hashes observados e revisados no plano.
old_hash='HASH_ANTERIOR_REVISADO'
new_hash='HASH_V2_REVISADO'
node dist/main.js corporate-adopt-operator \
  --expected-schema-hash "$old_hash" --schema-hash "$new_hash" \
  --confirm "AUTHORIZE_EXPORTDATA_OPERATOR_CONTRACT:$old_hash:$new_hash" \
  --preserve-history-read "$history_read"

node dist/main.js corporate-prepare-operator --source-ids "$source_ids" \
  --confirm "AUTHORIZE_EXPORTDATA_OPERATOR_PAYLOADS:$source_ids" \
  --preserve-history-read "$history_read"

node dist/main.js corporate-deliver-selected --source-ids "$source_ids" \
  --confirm "AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:$source_ids" \
  --preserve-history-read "$history_read"
```

6. Em qualquer erro, parar e preservar evidências. Para `CORPORATE_COMMIT_UNKNOWN`, não repetir entrega: obter o attempt_id do journal persistente e revisar o conjunto/evidência. Somente então, com autorização específica, usar `corporate-reconcile-selected --source-ids "$source_ids" --attempt-id "$attempt_id" --confirm "AUTHORIZE_EXPORTDATA_SELECTIVE_RECONCILIATION:$attempt_id:$source_ids" --preserve-history-read "$history_read"`. Se houver ausência remota comprovada, eventual nova entrega é decisão explícita, nunca retry automático. Divergência mantém o bloqueio.
7. Verificar os três target IDs/operadores no destino e recibos correspondentes; comparar integralmente a leitura histórica, settings, mappings, recibos antigos, fila não selecionada e journals. A captura deve continuar exatamente `reading`, sem resposta e sem progresso; control permanece paused e scheduler STOPPED. Não executar resume/start após o sucesso.
8. Tratar recuperação histórica em frente separada com evidência do provedor/infraestrutura sobre a requisição original e eventual resposta integral recuperável. Aumentar limite HTTP não recupera os bytes perdidos nem autoriza um novo POST.

## Validação local

Testes em Node 24; PostgreSQL 16 descartável em tmpfs, rede Docker interna, zero portas publicadas e TLS verificado para o destino simulado. O runner não utiliza credenciais, bancos ou containers de produção. Casos específicos cobrem identidades exatas, preservação integral de journals/recibos/settings/sequence, recusa de estado divergente e concorrência, COMMIT desconhecido, revalidação após intenção, CLI com zero requisições OLOS e recuperação futura simulada com duplicatas v1/v2.

Resultados: typecheck e build aprovados; 97/97 testes unitários e 106/106 testes no runner `bash scripts/test-corporate-delivery.sh` (inclui integração Store/Admin), sem skips. `git diff --check` aprovado. A suíte unitária foi executada em imagem local de testes com Node 24/OpenSSL e `OPENSSL_CONF=/dev/null`; isso supre apenas a configuração ausente do OpenSSL nessa imagem, sem desabilitar verificação TLS. Sem commit, push ou deploy.
