# Validação da captura histórica

Data: 30/10/2026. Worktree: `/home/madm/madm/export-data-v3-history`, branch `feature/exportdata-history`, base/HEAD `71709b8`. Nenhum commit, staging, push ou deploy foi executado. O checkout original foi tratado somente como leitura e comparado por SHA-256, status e diff do índice antes/depois: permaneceu inalterado.

## Auditoria e correções

| Constatação | Correção/evidência |
| --- | --- |
| `history` usava `OlosApi.call`, herdando replay de HTTP 401/429 | Ramo histórico de requisição única, sem alterar a política de current/previous/reread; testes verificam uma única tentativa e nenhum backoff/replay |
| Worker resolvia automaticamente rejeições históricas | Qualquer erro posterior à intenção mantém evidência pendente; HTTP 401/429, timeout, interrupção e resposta inválida exigem análise explícita |
| Validação dos estados ocorria separadamente da intenção | `beginRead(history)` agora exige autorização/estado dentro da transação da intenção, com locks nas linhas; teste concorrente comprova bloqueio de UPDATE do controle/agendador |
| `corporate-resume` podia concorrer mesmo sem Admin ativo | Lock de sessão history, compartilhado pela transação de resume; pendências históricas também impedem resume após reinício; sem migration |
| Recuperação normal podia drenar history e depois consumir outra chamada | Ciclo normal bloqueia pendências history e exige `recover-local`; a recuperação explícita usa o spec durável, sem nova autorização de consumo |
| `finally` podia admitir entrega após tentativa histórica rejeitada | History não chama `kick`; recuperação histórica também não admite entrega; escrita desabilitada e pausa são revalidadas |
| Falha ao fechar HTTP podia impedir encerramento do Store | `finally` encadeado garante tentativa de fechamento do Store e remoção dos handlers |
| Runner local deixava dados em volume anônimo | PostgreSQL de teste passou a usar tmpfs e remoção com volumes; nome do container é registrado para verificar o descarte |

Permaneceram intactos: mapeamento/TMA corporativo, autenticação OLOS, schema/migrations, agendador, deduplicação por ID da origem, recibos legados e política normal de baseline. A autorização histórica já existente em `src/config.ts` foi preservada. A persistência do corpo antes de seu parsing e a exceção durável de baseline já estavam corretas e foram reaproveitadas.

Os dois testes históricos inicialmente em `test/store.integration.ts` foram transferidos para a suíte Corporate Delivery, usando a arquitetura efetiva: controle reconciliado/pausado, outbox pendente e escrita desabilitada. Assim, a suíte Store voltou ao conteúdo da base, sem perder os cenários de baseline e recuperação. Os três testes de segurança trazidos anteriormente foram mantidos e passaram.

## Execução inicial, antes das alterações

- Typecheck e build: passaram.
- `npx --no-install tsx --test test/history.test.ts`: 2/2 passaram.
- `bash scripts/test-integration.sh`: 25 passaram e 2 foram ignorados pelas guardas de fixtures corporativas.
- `bash scripts/test-corporate-delivery.sh`: 64/64 passaram, incluindo os três testes históricos transportados.

## Execução final

Com Node 24.22.1 e ambiente sem variáveis reais de banco/OLOS:

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | passou |
| `npm run build` | passou |
| `npx --no-install tsx --test test/history.test.ts` | **5/5 passaram**, zero skips |
| `npm test` | **90/90 passaram**, zero skips |
| `bash scripts/test-integration.sh` | **23 passaram**, zero falhas, **2 skips** |
| `bash scripts/test-corporate-delivery.sh` | **71/71 passaram**, zero skips |
| `docker build -t olos-exportdata-v3:history-local .` | passou, sem publicar/iniciar o worker |
| Inspeção da imagem com rede desabilitada | ausência de Billing e da homologação corporativa de cinco registros confirmada |
| `git diff --check` | passou |

Os dois skips do runner genérico são as suítes Corporate Delivery e Corporate Sync, que exigem flags/URLs próprias de bancos descartáveis. Corporate Delivery foi executado integralmente pelo runner específico: 34 cenários, incluindo 12 históricos, mais o teste pai. Seus 71 resultados também incluem administração e Store. Corporate Sync não foi iniciado nem alterado. Não somar esses totais como testes distintos: os cinco unitários históricos pertencem aos 90, e o runner corporativo repete a suíte Store.

Na elaboração dos testes, houve um erro TypeScript por referência a cliente opcional e duas fixtures com combinações incompatíveis com o CHECK do agendador. Foram corrigidos o tipo e os dados sintéticos, sem remover constraints ou enfraquecer as guardas. A execução final teve zero falhas.

## Cobertura histórica comprovada

- CLI sem autorização e argumentos de data rejeitados antes de banco/HTTP.
- Admin ativo, agendador enabled/RUNNING/PAUSED, controle não ready/não paused/blocked, escrita habilitada e leitura pendente bloqueiam.
- Estados rechecados na transação da intenção; resume concorrente bloqueado antes/durante o POST.
- Intenção visível em `reading` antes da requisição; perda da sessão após intenção impede envio e exige reconciliação.
- Um único POST, inclusive para 401/429; current/previous/reread mantêm suas regressões.
- Datas de setembro/outubro anteriores ao baseline entram na outbox, sem alimentar raw local ou entregar a MADM.
- Recibos, mappings e chamadas existentes permanecem preservados; colisão divergente antiga bloqueia em vez de ser descartada pelo baseline.
- Resposta `received` recuperável após commit parcial e reinicialização, preservando o lote já confirmado e ignorando o baseline pela política durável.
- CLI compilado com HTTP simulado preserva corpo após falha local; `recover-local` não faz novo POST consumidor.
- Timeout HTTP real da fixture, corpo parcial e SIGTERM deixam `reading` e impedem repetição após reinício.
- Corpo JSON inválido permanece `received` e não é resolvido automaticamente.
- Perda simulada da confirmação de `stage` conserva a resposta durável; recuperação local idempotente.
- Resposta vazia termina como `done`, sem loop ou inferência de cobertura completa.
- Locks liberados efetivamente: outra sessão adquire o lock history e o Admin reinicia em STOPPED após encerramento.
- Regressões corporativas de 12105 e 12605 recibos passaram; esperado legado 12605 preservado.

APIs foram simuladas e todos os bancos usados em testes foram PostgreSQL descartável. O runner corporativo usa rede interna sem portas publicadas, certificado sintético e namespace de rede compartilhado apenas com seu PostgreSQL temporário. O runner local publica somente porta efêmera em loopback, com URL sobrescrita explicitamente para a fixture. Os recursos identificados das execuções finais foram removidos e sua ausência verificada. Nenhum comando foi executado contra VPS, OLOS real ou MADM real.

## Arquivos preparados na branch

Modificados em relação a `71709b8`:

- `scripts/test-integration.sh`
- `src/api.ts`
- `src/config.ts`
- `src/corporate-delivery/delivery.ts`
- `src/main.ts`
- `src/store.ts`
- `src/worker.ts`
- `test/corporate-delivery.integration.ts`

Novos:

- `test/history.test.ts`
- `docs/history/README.md`
- `docs/history/validation.md`

Não existem arquivos Billing ou o módulo/comando de homologação corporativa de cinco registros nesta alteração, no worktree ou na imagem. A guarda de compatibilidade com consumidores locais, já existente no Corporate Delivery da base, permanece sem importar Billing. O índice Git ficou vazio; nenhuma alteração do checkout original foi incorporada.

## Riscos e publicação

A retenção OLOS, a cobertura integral dos meses, o volume real e a latência WAN não foram homologados. Identidades da origem recicladas/conteúdo divergente bloqueiam; não há remapeamento automático. Não existe transação atômica entre HTTP e PostgreSQL: resultados incertos exigem reconciliação externa, jamais retry cego. Locks exigem a mesma versão dos controles e não protegem contra SQL manual ou binários antigos que os ignorem.

Publicar somente após revisão e autorização separada. Usar esta branch/worktree como origem do build, preservar backups/configuração, encerrar o Admin antigo com estado STOPPED e manter entrega pausada/escrita desabilitada. Não há nova migration. Não configurar `capture-history` como comando de serviço com restart. Iniciar o Admin existente inicialmente parado, conferir status, e reservar uma janela explícita para cada consumo histórico. Não voltar a uma versão sem suporte à política history enquanto houver respostas históricas pendentes.

O procedimento completo, consultas locais de auditoria, recuperação e análise de cobertura estão em [README.md](README.md). Nenhuma ação operacional desse procedimento foi executada nesta tarefa.
