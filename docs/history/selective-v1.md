# Homologação seletiva v1 com histórico preservado

Base: `7e36123a631e5ab063fa3ca396f7e90be0ef58bd`, branch `feature/exportdata-history`. Alteração local, sem execução operacional. Não houve acesso à VPS, OLOS ou MADM reais.

O comando existente `corporate-deliver-selected` aceita agora `--contract v1`, imediatamente antes de `--preserve-history-read`. A opção é obrigatoriamente vinculada à exceção histórica já existente; não autoriza uma seleção v1 genérica. Sem ela, o comportamento v2 de `--preserve-history-read` permanece igual ao commit base. Não há conversão automática entre contratos.

## Escopo e contrato

A seleção precisa conter exatamente estes três IDs; a confirmação deve acompanhar a ordem informada:

| source_id | target_id | olos_call_id |
| --- | --- | --- |
| 47561569 | 725262 | 1031756916 |
| 47559439 | 724965 | 1031754969 |
| 47558756 | 724892 | 1031754587 |

O payload congelado precisa ter exatamente os 14 campos originais: `internal_id_olos`, `olos_call_id`, `data_ligacao`, `telefone`, `nome_agente`, `id_campanha_olos`, `nome_campanha_olos`, `id_tabulacao_olos`, `nome_tabulacao_olos`, `cpf`, `lead_id_origem`, `tma_origem`, `razao_desligamento`, `email`.

São os 14 campos de escrita da integração, não uma afirmação de que a tabela inteira contém apenas 14 colunas. O contrato existente também valida colunas corporativas de identidade/defaults/Kommo, índices, constraints e triggers. A fixture corporativa v1 tem 33 colunas, sem `id_operador_olos`. Esses requisitos não foram flexibilizados.

Payload com coluna extra, campo ausente ou `olos_call_id` divergente bloqueia. Não se remove `id_operador_olos` de um payload v2 para convertê-lo em v1. A validação recalcula o hash v1 pelo caminho existente; payload/hash/source_hash e identificadores não são regravados. Mantêm-se também os AgentId previamente fixados pela guarda histórica (1658/1467/1565), usados somente na verificação local, sem envio de coluna de operador.

## Invariantes

- Read ID `132eb226-f4e4-419d-b79f-21dd0e6e64c1` é a única pendência da origem e continua `history/reading`, `RESPONSE_TOO_LARGE`, sem resposta, sem término/resolução e com zero processados. Nenhuma coluna de `olos_http.reads` é alterada pela entrega/reconciliação.
- Os três mappings e outbox precisam existir antes de `started_at` da leitura, ter origem `capture` e concordar em target/source_hash. A entrega não procura registros substitutos nem aceita subconjuntos.
- Scheduler: `enabled=false`, `desired_state=STOPPED`, `runtime_state=STOPPED`; processo Admin encerrado. Corporate Delivery pronto/pausado, binding válido e escrita geral desabilitada.
- Preservados locks de origem, Corporate Sync, entrega, histórico compartilhado, Admin e fence remoto. Leitura/settings/mappings são protegidos por locks de linhas. Locks de sessão sobrevivem à intenção durável; escopo, identidade, estado e hashes são revalidados após essa intenção e antes do COMMIT remoto.
- Schema local registrado deve ser v1, sem a coluna de operador. Schema remoto deve passar pelo contrato completo e ter exatamente o hash registrado. Adoção v2 prévia ou schema divergente bloqueiam; não existe DDL, downgrade, atualização de hash, plano/adoção/preparação de operador ou migration no fluxo v1.
- Somente as três identidades entram na transação remota. Colunas Kommo não entram no INSERT e não são atualizadas. Linha remota idêntica é reconhecida sem novo INSERT; colisão ou divergência bloqueia. Reexecução preserva IDs, recibos já confirmados, campos corporativos e sequence remota.
- Antes de COMMIT remoto, confirma-se intenção e bloqueio duráveis no journal seletivo existente. Perda de confirmação/interrupção mantém `unresolved` e control bloqueado/pausado. Nova entrega não passa até reconciliação seletiva explícita.
- A reconciliação usa o mesmo modo `--contract v1`, Read ID, conjunto completo e attempt_id exato, com confirmação própria. Ela verifica evidência local/schema/identidade e lê o destino sob fence, sem INSERT remoto. Resolve apenas o journal seletivo; a leitura histórica continua pendente. Ausência comprovada não dispara retry.
- Sem timers, retomada de scheduler, liberação geral ou chamada à API OLOS. `RESPONSE_TOO_LARGE` permanece incerteza de consumo remoto; não comprova que a OLOS deixou de consumir os dados.

## Comando proposto — não executado em produção

Pré-condições devem ser verificadas em uma janela futura autorizada, com configuração privada já validada e executável revisado. O schema v1 e os controles/journal seletivos precisam existir. Se faltar estrutura ou houver incompatibilidade, parar e apresentar a evidência; este procedimento não executa migrations nem altera MADM para fazê-lo passar.

```sh
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-deliver-selected \
  --source-ids 47561569,47559439,47558756 \
  --confirm AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY:47561569,47559439,47558756 \
  --contract v1 \
  --preserve-history-read 132eb226-f4e4-419d-b79f-21dd0e6e64c1
```

Executar uma vez, sem wrapper de retry. Após sucesso, conferir somente os três recibos/targets e comparar histórico, settings, mappings, outbox não selecionada e recibos anteriores. Manter scheduler STOPPED e entrega geral pausada. Não executar comandos de operador v2, `resolve`, captura, `corporate-resume` ou `start` como parte desta operação.

Em COMMIT incerto, preservar o estado. Após revisão da evidência e autorização específica, a reconciliação proposta é:

```sh
attempt_id='UUID_EXATO_DO_JOURNAL_REVISADO'
OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js corporate-reconcile-selected \
  --source-ids 47561569,47559439,47558756 \
  --attempt-id "$attempt_id" \
  --confirm "AUTHORIZE_EXPORTDATA_SELECTIVE_RECONCILIATION:$attempt_id:47561569,47559439,47558756" \
  --contract v1 \
  --preserve-history-read 132eb226-f4e4-419d-b79f-21dd0e6e64c1
```

Não limpar bloqueios por SQL. Mesmo que a reconciliação prove ausência, eventual entrega posterior exige decisão explícita e mantém o escopo dos mesmos três registros.

## Arquivos e testes

Código alterado exclusivamente em `src/corporate-delivery/`:

- `selection.ts`: parser/validação do contrato v1 restrito à ocorrência.
- `preserved-history.ts`: identidades completas, 14 campos exatos, schema local v1; preserva regras v2.
- `selective-commit.ts`: propaga contrato mantendo locks existentes.
- `delivery.ts`: propaga contrato na entrega, reconciliação e revalidação após intenção; reutiliza o protocolo de hash/schema/COMMIT/recibos.

Testes: `test/corporate-delivery.test.ts` e `test/corporate-delivery.integration.ts`. Documentação: este arquivo. Não foram alterados `src/main.ts`, branch `main`, Billing, migrations ou o worktree original.

A integração provisiona somente fixtures descartáveis com PostgreSQL 16 em tmpfs, rede interna, sem portas publicadas, TLS verificado e API OLOS simulada. A fixture v1 não tem coluna nem tabelas de operador; nenhuma operação de operador v2 é usada para entregar v1. A suíte preexistente de regressão v2 continua exercitada somente no ambiente descartável. A criação das estruturas de teste usa os arquivos de fixture/migrations existentes, sem aplicação em banco persistente ou produção.

Casos novos: CLI de entrega/reconciliação sem HTTP OLOS; três payloads v1 sem mudanças; schema completo antes/depois; preservação de leitura, configurações, mapping, sequence local, recibos, outros pendentes e Kommo; reexecução sem consumir sequence remota; recusa de subconjunto/IDs/Read ID inválidos, identidade/hash/payload divergentes, scheduler ativo, Admin/histórico concorrentes e schema incompatível; intenção durável e COMMIT incerto com prova de presença/ausência; revalidação após intenção; manutenção da regressão v2.

Validação concluída: `npm run typecheck`, `npm run build`, `npm test` (98/98), `bash scripts/test-corporate-delivery.sh` (111/111, incluindo Store/Admin e regressão v2), `git diff --check`. Sem skips. Node 24; unitários em imagem local de testes com OpenSSL e `OPENSSL_CONF=/dev/null` para suprir sua configuração ausente, sem desabilitar TLS. Recursos PostgreSQL temporários removidos ao final.

Limite: o sucesso sintético comprova o comportamento do código contra a fixture auditada. Não verifica schema, hashes ou conteúdo reais dos três registros; incompatibilidade real deverá bloquear. Não comprova retenção/recuperabilidade da resposta histórica perdida. Sem commit, push ou deploy.
