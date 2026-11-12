# Revisão técnica final da readoção

Revisão local de 11/11/2026, no repositório oficial e branch `main`, HEAD `e59a998` preservado. Não houve acesso à VPS/MADM real, commit, push ou deploy. [Evidência estruturada](../evidence/corporate-id-readoption-final-review.json). A [evidência inicial](../evidence/corporate-id-readoption.json) permanece como registro da execução anterior, com seus hashes daquele momento; esta revisão registra os arquivos corrigidos e os novos resultados.

## Veredito

**Pronta para homologação controlada e isolada, após as correções desta revisão. Não aprovada para ativação no MADM real.** Não ficou identificado defeito crítico aberto nos caminhos examinados. Isso não equivale a provar ausência de defeitos ou homologar os demais escritores corporativos.

O aceite global continua pendente: os testes gerais e o typecheck têm falhas anteriores reproduzidas no HEAD. A instalação real também depende de aprovação do DBA, compatibilidade dos escritores, privilégios, schema/versão, rede/TLS, capacidade e janela de lock. A geração só pode ser ativada pelas operações administrativas com autorização/digest exatos, depois dessas validações.

## Defeitos comprovados e corrigidos

| ID | Severidade | Defeito e impacto | Correção e regressão |
| --- | --- | --- | --- |
| R1 | Alta, integridade | A validação conferia o trigger diferido de assignment, mas não o corpo de `require_corporate_id_assignment()`, da migration 008. Um schema parcial com função substituída por `RETURN NEW` era aceito na validação, apesar de perder a proteção usada contra binários anteriores. | `readoption-proof.ts` compara o corpo com a migration 008 antes de validar/ativar. Teste reproduziu aceitação indevida antes da correção e agora rejeita, conservando `prepared` e autoridade legada; após restaurar a função conhecida, a validação passa. |
| R2 | Alta, integridade da migration | A migration 011 removia qualquer CHECK cujo texto mencionasse `state`. Um CHECK adicional, mesmo independente, era apagado silenciosamente. | Apenas os nomes **e definições** conhecidos de 010/011 podem ser substituídos. CHECK extra ou definição alterada sob nome conhecido provoca rollback. Teste confere preservação da constraint, solicitação e controle, além da reaplicação válida. |
| R3 | Alta, procedimento operacional | O runbook selecionava `worker` pelo Compose padrão; a topologia Dokploy versionada usa o serviço único `admin`. Podia selecionar outra aplicação ou falhar, sem comprovar a imagem correta. | Container ID explícito aprovado, checagem de execução/label `admin`, WORKDIR `/app`, caminhos compilados absolutos e preflight dos arquivos necessários. Não há seleção automática de outro projeto. |
| R4 | Alta, procedimento operacional | `PGDATABASE="$URI" psql` não expande a URI como conexão; no PostgreSQL 16 descartável o valor tornou-se o nome literal do banco, com parâmetros de host/user não aplicados. | `psql --dbname="$URI_SEM_SENHA"`, `PGPASSFILE` 0600, validação que recusa senha embutida/query string e orientação explícita de TLS/rede. O teste do runner confirma conexão ao banco correto com `verify-full`. |

As duas regressões de código falharam antes da correção com `Missing expected rejection`: 97 aprovados e 3 falhas, incluindo o pai. Após corrigir somente esses defeitos e acrescentar a prova do timeout de instalação, a suíte dirigida terminou em **101/101**. Nenhum indicador, filtro, gerador alternativo ou funcionalidade adicional foi implementado.

## Verificações aprovadas

| Área | Evidência e limite |
| --- | --- |
| Barreira transacional | COMMIT conjunto de modo, geração obrigatória e linha de fence, sob lock exclusivo `(17320914,5)`. Escritores compatíveis usam o mesmo lock compartilhado. Triggers ALWAYS e bloqueio da linha de fence rejeitam binários antigos em READ COMMITTED e provocam erro de serialização em snapshot REPEATABLE READ anterior. A guarda diferida agora também tem seu corpo validado. |
| Captura concorrente | A fence dedicada evita acoplar captura ao lock da linha de controle mantido por uma entrega lenta. Testes cobrem legado, modo ativo e captura HTTP pelo Worker existente durante ativação/outage. Depois da barreira, novas chamadas viram admissões duráveis, sem chamar a sequência local no runtime compatível. |
| Reservas e tokens | Registry/contador corporativo, unicidade e trigger de ownership/token arbitram concorrência e IDs ocupados. Mesma identidade/hash/UUID recupera a associação original. Int32 e exaustão são verificados. Papel externo não consome reserva alheia; não há concessão de DML direto no registry ao runtime. |
| COMMIT incerto | Reserva remota precede persistência local, sem alegar atomicidade distribuída. Há provas de falha após reserva, rollback local, ACK perdido no preparo/validação/barreira/lote/ativação/materialização, reinício e lotes parciais. A continuação conserva UUID/checkpoint/ID/token e não cria uma nova solicitação. |
| Histórico | IDs, payloads congelados, hashes, recibos, pendências e quarentenas são comparados antes/depois. O registro histórico não renumera. Confirmados não são reinseridos. Quarentena continua `pending`, excluída da seleção e sem liberação automática. |
| MADM ausente/incompatível | Namespace ausente, trigger/contrato/schema divergente e falta de acesso bloqueiam o avanço. Durante ativação, captura continua por admissões. Depois de ativo, falha de reserva conserva a fila, sem fallback. `active` descreve autoridade persistida, não disponibilidade garantida do MADM. |
| Migrações | 010 mantém aplicação única explícita. 011 é expansiva para o contrato conhecido, reexecutável e agora rejeita CHECKs desconhecidos. A corporativa preserva chamadas e sequências, registra IDs ocupados, ignora IDs nulos para ocupação numérica e instala a guarda ALWAYS. Todas foram exercitadas somente em bancos descartáveis. |
| Privilégios | Uma sessão local sem ownership conclui validação/ativação com grants revisados e não consegue desabilitar a barreira nem desligar a autoridade. No MADM sintético, outro papel não consegue alterar o trigger ou consumir token alheio. Os papéis reais continuam sujeitos à revisão DBA. |
| CLI e imagem | Sete operações de readoção protegidas, com origem literal, UUID, evidência e autorização adicional para ativar/reconciliar. Build Docker local concluído. Na imagem, UID 1000, `/app`, entrypoints compilados, sete comandos e migrations com hashes iguais aos arquivos revisados; inspeção executada com rede desabilitada. |

Uma tentativa antiga de INSERT pode consumir `nextval()` antes de o trigger rejeitá-la: sequências PostgreSQL não fazem rollback. A prova é de que esse ID não se torna uma atribuição local confirmada. O runtime novo não chama a sequência depois da barreira. Não reajustar valores consumidos.

## Prova das falhas anteriores

Foi extraído um `git archive HEAD` diretamente para o filesystem de um contêiner descartável, contendo apenas código, testes, scripts, migrations e assets necessários. Não foi criado worktree ou checkout paralelo; não foram incluídos `.env`, exports de chamadas ou dados de produção. Dependências existentes foram montadas somente para leitura. Os testes usaram PostgreSQL 16 temporário, rede interna sem portas publicadas e TLS verificado.

| Execução | Resultado |
| --- | --- |
| HEAD limpo `e59a998`, integração geral | **146 aprovados / 8 falhas**, 154 testes |
| Candidato após revisão, integração geral | **181 aprovados / 8 falhas**, 189 testes |
| Candidato após revisão, recuperação/readoção | **101/101**, sem skips; preserva os 72 da execução inicial |
| Unitários após revisão | **142/142** |
| Build TypeScript de produção | Aprovado |
| Build Docker e verificação offline da imagem | Aprovados |
| Typecheck global, HEAD limpo e candidato | **17 erros**, saídas idênticas byte a byte |

As sete falhas de cenário e seu agregador foram comparados por nome e assinatura inicial da exceção. São os mesmos em HEAD e candidato:

- Três cenários de histórico: API `assertHistoryReady` ausente e comportamento histórico esperado pelo teste incompatível com a implementação atual.
- Quatro cenários da CLI de homologação: invocam `corporate-homologate`, comando ausente no dispatcher atual; as expectativas de autorização/locks não são atingidas.

Os 17 erros estão em `test/corporate-delivery.integration.ts`: propriedades `historyCaptureAuthorized`, método `assertHistoryReady` e o tipo `history`. Nenhum teste foi pulado/removido nem contrato alheio à readoção alterado para ocultá-los. O aceite de CI global permanece aberto. Relatórios/Sync/UI não foram alterados nesta revisão; os resultados anteriores e os hashes preservados constam da evidência inicial. Os 14 arquivos protegidos de Reports/frontend foram novamente comparados e permanecem idênticos.

## Riscos de implantação e condições para o MADM real

1. **Outros escritores:** inventariar e homologar INSERT, UPDATE, UPSERT, COPY, funções e replicação. Inserir um ID livre continua permitido e o ocupa no registry; tentar um reservado/usado pode gerar `ALLOCATOR_ID_NOT_OWNED`. Um UPSERT idempotente também pode executar BEFORE INSERT antes de resolver seu conflito. A segurança do banco é preservada, mas a continuidade de produtores com geradores independentes não está comprovada. Não ativar sem revisão desses consumidores.
2. **Janela de lock:** a migration corporativa adquire SHARE ROW EXCLUSIVE em `raw.olos_calls`; escritores podem esperar durante o bootstrap. No teste, um escritor aberto provocou timeout de 5 s e rollback integral, preservando as chamadas; após liberar o escritor, a instalação passou. Limite de statement é 60 s, sem garantia de transação inteira em 60 s. Volume, armazenamento, WAL, índices e duração de instalação em milhões de registros precisam ser dimensionados pelo DBA. [Locks PostgreSQL 16](https://www.postgresql.org/docs/16/explicit-locking.html).
3. **Papéis e ownership:** manter a identidade dos bindings e revisar superuser, ownership, heranças, RLS e poderes de bypass. O `POSTGRES_USER=olos_app` no Compose não prova os privilégios atuais do volume existente. Um owner/superuser pode deliberadamente contornar triggers; testes com papel restrito não certificam a configuração real. Ajustes de privilégio são responsabilidade do DBA, sem mudança automática de binding.
4. **Schema e migrations:** aprovar a corporativa 001 e confirmar versões/contratos reais, ausência de namespace parcial desconhecido e privilégios de reserva/INSERT. 010 não pode ser reaplicada cegamente. 011 e grants devem ser confirmados na mesma transação. As definições canônicas foram testadas em PostgreSQL 16; outro schema/deparser requer homologação.
5. **Dokploy e conexões:** confirmar o ID da aplicação admin, imagem revisada, variáveis existentes, mount da CA, versão Compose com `env_file.format: raw`, caminho de rede até cada PostgreSQL e URIs DBA sem senha. Nome Docker interno não é automaticamente acessível do host. O runbook não publica portas nem imprime credenciais e não assume Node instalado na VPS. Não foi inspecionada a implantação real.
6. **Estado administrativo:** reversão anterior concluída e validada, quarentena íntegra, nenhuma admissão anterior pendente; preparar/validar a geração correta, revisar o digest, autorizar a barreira, concluir os lotes e comprovar `active` por consulta. Tratar colisões históricas com quarentena seletiva e verificar o restante antes de liberar/retomar a entrega.
7. **Rollback:** após a barreira, recuperar para frente com a mesma geração e binário compatível. Pausar somente a entrega conserva filas; não desligar a autoridade, remover trigger, apagar registry/quarentena, alterar sequência ou retornar a binário antigo. Abortar antes da barreira não desinstala a autoridade remota nem autoriza downgrade irrestrito.
8. **Aceite global:** resolver as pendências de testes/typecheck anteriores para cumprir integralmente o PRD. A aprovação dos cenários de readoção e da imagem não transforma a suíte global em aprovada.

## Limitações conhecidas

Não foram testados OLOS/MADM reais, WAN, conjunto de milhões de registros ou todos os produtores corporativos. A prova de busca de lacuna com 50 mil IDs é sintética. Int32 finito, outage ou indisponibilidade do destino podem acumular admissões e exigem monitoramento de capacidade. Ativação não resolve colisões históricas nem libera quarentenas. O [runbook corrigido](id-allocator-readoption-runbook.md) é um procedimento para revisão e futura execução autorizada; nenhum de seus comandos modificou produção.
