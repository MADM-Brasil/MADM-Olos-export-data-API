# Atualização manual da coleta do dia

Implementação local. Nenhuma migração, acesso a produção, commit, push ou deploy.

- `GET /api/today` permanece exclusivamente baseado no snapshot publicado, sem alteração de contrato. O polling existente de 30 segundos foi preservado.
- O botão usa `POST /api/today/refresh`, corpo `{}`, sessão administrativa, Origin e CSRF existentes. Não inicia ingestão nem acessa OLOS ou o destino corporativo.
- O repositório reutiliza `AdminReports` e o pool leitor de uma conexão, separado da ingestão. Não altera snapshots ou qualquer tabela.
- SQL: `count(*)::text` sobre `olos_http.records`, filtrado por `source_key`, `target_table` e `created_at` no intervalo `[início, fim)` do dia de Brasília. Sem joins, payloads, agrupamento histórico ou dependência de mappings/operador. Preserva a definição de primeira persistência local e a precisão dos inteiros.
- Uma transação `REPEATABLE READ READ ONLY` fixa a observação. `observed_at` vem de `transaction_timestamp()`; `server_time` continua sendo apenas o horário da resposta HTTP. Gravações confirmadas após a fronteira da observação entram numa consulta posterior.

## Proteção de recursos

Até uma nova consulta a cada 60 segundos no único Admin proprietário da origem, compartilhada por todos os usuários. Requisições simultâneas no processo aguardam a mesma Promise. Falhas também consomem a janela. Uma trava consultiva transacional por origem impede consultas manuais simultâneas em processos distintos; não utiliza as travas da ingestão/entrega.

O intervalo mínimo está em memória e reinicia com o processo; não constitui limitação persistente entre reinícios. A trava PostgreSQL coordena concorrência, não cooldown global entre processos sequenciais. O Admin já exige posse exclusiva para atender a mesma origem. Pooling PostgreSQL em modo transação continua incompatível com a arquitetura geral do Admin.

Orçamento específico, sem aumentar limites globais: statement 1 s, watchdog de conexão após checkout 2 s, lock 100 ms, work_mem 1 MiB, zero workers paralelos e JIT desligado. O pool existente limita checkout/conexão a 1 s. Não há retentativa automática nem fallback histórico. Limites são locais à transação e o encerramento é por rollback.

Excesso/busy retorna 429; timeout/indisponibilidade retorna 503. O limite retorna `Retry-After` com os segundos restantes, arredondados para cima; busy/timeout/indisponibilidade continuam informando 60. O frontend preserva a última contagem válida em erro. Compara data e `observed_at` antes de aceitar qualquer resposta: snapshot automático antigo ou empatado não substitui a observação manual. Uma observação realmente posterior pode reduzir a contagem por correção de dados; não se aplica `max(calls)`.

## Botão e HTTP 429

O problema identificado no frontend era a liberação do botão logo após a resposta e o descarte do cabeçalho `Retry-After` pelo helper HTTP. A próxima tentativa dentro da janela compartilhada era recusada e aparecia como falha genérica. Somente o clique chama o POST; polling, login, navegação e retorno à aba continuam usando GET. Um primeiro clique de outro usuário também pode encontrar a origem limitada. O cabeçalho 60 isoladamente não distingue limite temporal de lock ocupado; o código do JSON permite essa distinção.

A verificação de execução em andamento acontece antes do limitador: requisições simultâneas compartilham a Promise. Não existe cache de resultado manual concluído; retornar o snapshot periódico nesse fluxo violaria a exigência de nova observação. Mantiveram-se a janela de 60 segundos, as falhas consumindo essa janela, a trava e os orçamentos SQL/watchdog.

Após sucesso manual, o botão observa localmente a janela de 60 segundos desde o envio. Ao receber 429, respeita `Retry-After` em segundos ou HTTP-date, usando o cabeçalho Date do servidor quando disponível; ausência/formato inválido utiliza 60 segundos. Um timer monotônico, atualizado pelo tick já existente, controla a contagem regressiva visível e a liberação. Não existe novo polling nem retentativa automática do POST. GET continua permitido durante cooldown. O 429 não muda a observação válida nem é tratado como sucesso. Erro de rede preserva o valor e informa falha, sem presumir que o servidor aceitou a requisição.

O botão mantém geometria e foco, descreve a espera com `aria-describedby` e um elemento `role=timer` sem anúncios por segundo, e separa loading de cooldown. Sair da sessão limpa o estado local; o limitador do servidor permanece compartilhado pela origem.

## Custo e evidências

Não existe índice de data na definição atual de `records`. A consulta ainda pode fazer varredura linear, mas não executa a agregação histórica de relatórios. Por isso o fluxo é manual, limitado e cancelável, não ligado ao polling.

PostgreSQL 16 descartável, dois milhões de registros sintéticos, todos elegíveis no dia, somente índices existentes:

- Consulta com limites temporais previamente calculados: 302,59 ms após reinício PostgreSQL; demais execuções preliminares 224,60–313,58 ms.
- Implementação completa, incluindo coordenação: 230,34–345,92 ms nas cinco amostras finais.
- Quatro lotes concorrentes de 500 persistências: máximo 64,89 ms, contra 21,99 ms na referência; diferença 42,90 ms.
- Zero blocos temporários escritos no plano executado.
- Cache do sistema operacional preservado; não é medição de disco fisicamente frio nem validação de produção.

A primeira variante com conversões de timezone no predicado foi cancelada em 1 s. A solução calcula os limites uma vez e os passa como parâmetros, seguindo o mecanismo já usado pelo snapshot. Não houve aumento de timeout. Planos e medidas: [evidence/manual-today](evidence/manual-today/).

O custo cresce com o histórico e pode exceder 1 s em hardware/carga diferentes. Nesse caso o refresh falha de forma controlada e mantém a observação anterior. Um índice temporal exigiria avaliação e autorização separadas; não foi criado. Não há garantia de ausência de interferência sob carga sustentada baseada em quatro lotes sintéticos.

## Validação e reprodução

Node 24 e dependências já instaladas:

```sh
node --import tsx --test test/admin-today.test.ts test/admin.test.ts
bash scripts/test-admin-today.sh
TODAY_PERF=1 bash scripts/test-admin-today.sh
npm run test:admin-ui
npm run build
npm run build:admin
```

O runner cria somente fixtures em PostgreSQL descartável e remove seus recursos; não aplica arquivos de migração nem lê `.env`/`DATABASE_URL` operacionais. A execução com volume demora mais pela construção dos dois milhões de registros. A observação após reinício e os planos também foram medidos separadamente antes da implementação.

Validação da correção de cooldown: 125 unitários, 20 UI, 4 PostgreSQL e Chromium desktop/mobile aprovados; builds backend/admin e TypeScript administrativo aprovados. O benchmark opt-in de dois milhões foi ignorado intencionalmente nesta rodada: SQL e limites de execução não mudaram; as medidas anteriores acima foram preservadas. TypeScript global mantém os 17 diagnósticos preexistentes em `test/corporate-delivery.integration.ts`, comparados com o registro da base; nenhum novo diagnóstico.

Testes cobrem sessão/CSRF/Origin, cooldown e coalescência de 20 requisições, duas instâncias, fronteiras de calendário, falha de conexão, timeout real, precisão acima de MAX_SAFE_INTEGER, observação durante inserções, erro mantendo valor, teclado/loading/reduced-motion, polling antigo após refresh manual e isolamento entre sessões. Não foram alterados scheduler, worker, Autonomous Recovery, Corporate Delivery ou atualizador de snapshots.
