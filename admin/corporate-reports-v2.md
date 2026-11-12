# Relatórios corporativos v2

A fonte de chamadas no Admin passa a ser exclusivamente `madm.raw.olos_calls`, por `raw_olos_call_id`. O snapshot v1 e seu código de coleta/validação permanecem disponíveis. Não há nova migration: a migration administrativa 003 já separa as gerações e ponteiros por `(source_key, target_table, contract_version)` e impõe imutabilidade. Este trabalho não executa migrations ou comandos em produção.

## Contrato e regras

| Indicador | Fonte v2 e regra |
| --- | --- |
| Chamadas: histórico, período e dias | Todas as linhas físicas MADM, inclusive `internal_id_olos IS NULL`, sem deduplicação por CallId ou dependência de `records`. Datas nulas integram apenas o histórico global. |
| Hoje / 7 / 14 / 30 no Dashboard | Mesmo agregado diário MADM, intervalo inclusivo por data real da ligação, em America/Sao_Paulo. |
| Hoje / 7 / 15 / 30 / personalizado nos Relatórios | Mesmo agregado diário MADM; personalizado de até 366 dias. Dias sem movimento são zero no gráfico e omitidos na tabela; dias só com operação local podem aparecer com zero chamadas MADM. |
| Com CPF / e-mail | Campos MADM não vazios após o mesmo `btrim` Unicode do v1. Não exige documento válido, contato único ou operador identificado. |
| Operador identificado | AgentId canônico positivo e nome efetivo não vazio/não placeholder, com os mesmos padrões do v1. MADM não possui AgentId neste contrato: o ID exige `records` + origem/alvo/hash compatíveis e correspondência de **todos os 14 campos** do payload congelado no MADM pelo ID interno. Em confirmed, também exige recibo completo e a mesma chave `raw_olos_call_id`. Pending/skipped com payload exato podem identificar operador sem promover recibos. Sem outbox, preserva-se a identificação legada só quando o destino local normalizado corresponde integralmente ao MADM, incluindo a identidade lógica. Sem prova, a chamada conta normalmente no total/CPF/e-mail, mas não como identificada. Nunca se deduz AgentId de nome. |
| Operadores distintos | União de IDs comprovados no período; jamais soma dos distintos por dia. IDs ficam somente no snapshot privado; HTTP/CSV recebem contagens. |
| Coleta do dia | Fonte local `records.created_at`, primeira persistência de `(source_key, source_id)` para a tabela configurada, com limites do dia em Brasília. O refresh manual continua local e independente do MADM. |
| Recibos, pendentes e divergentes | Estado local atual, mesmas condições de coerência do v1. `skipped` permanece em `inconsistent`. Quarentenas não mudam estado; pendências incluem as isoladas. A data é a do payload congelado, nunca `confirmed_at` ou data de coleta. Só quando não existe entrada de outbox, preserva-se a data do destino local, se disponível, para esses indicadores operacionais. Um payload existente com data inválida não usa fallback: fica no grupo operacional sem data, fora dos períodos. |
| Falhas / quarentenas | Contagem histórica local de reads com error_code / membros da quarentena da origem. Ausência de tabela opcional significa `null`, não zero. |
| Vínculo não validado | Contagem MADM sem associação de origem/payload validada. Não significa chamada perdida nem identifica automaticamente causa de divergência. |

O v2 guarda os agregados corporativos e `operational` separadamente. O HTTP fornece `calls_source`, `call_identity`, `time_basis`, `operator_rule`, `corporate_observed_at`, metadados da geração e namespace `operational` com summary/period/daily, coleta do dia, falhas, quarentenas e fonte. O namespace operacional não apresenta CPF/e-mail ou identificação de operador artificiais; essas métricas pertencem ao MADM. `operational.summary.missing_mapping` preserva a contagem local de registros sem destino local; `summary.missing_mapping` corresponde ao vínculo de identidade corporativo. Os campos confirmados/pendentes tradicionais continuam disponíveis como projeções explicitamente locais, sem pressupor que somem o total corporativo. Os rótulos e cabeçalhos CSV identificam esses universos.

O hash de correspondência de relatórios usa domínio próprio com valores prefixados por tamanho UTF-8 e marcador de NULL. Quando há outbox, valida-se primeiro o `payload_hash` original com a função existente de Corporate Delivery; nenhum payload, hash, recibo ou ID é reescrito. Ao MADM vão somente IDs, AgentId e fingerprint, sem enviar nomes/contatos como parâmetros. Nomes/CPF/e-mail são avaliados no SQL corporativo e não saem como linhas individuais nem integram os snapshots. A busca local de evidência se restringe aos IDs presentes na observação corporativa, sem carregar milhões de payloads locais alheios ao MADM. A evidência de identidade em memória é limitada a 32 MiB serializados; o snapshot publicado permanece limitado a 16 MiB. Excesso bloqueia a nova publicação, preservando a anterior.

## Atualização, falhas e orçamento

O mesmo ReportUpdater publica v2 a cada 240 s e no rollover. Cada execução lê todo o histórico corporativo em uma transação `REPEATABLE READ READ ONLY`, por isso inclui inserções retroativas, alterações e exclusões históricas sem depender de maior ID, `created_at` ou janela móvel. Não há trigger, tabela temporária, DDL, sequência, migração ou escrita no MADM. Leitura corporativa recusa RLS, relação incompatível ou chave primária corporativa inadequada. Para timestamp sem timezone, exige confirmação explícita da semântica armazenada; não herda SOURCE_TIME_ZONE ou timezone do navegador.

Uma transação local mantém a observação operacional e publica snapshot + hash + metadados + ponteiro + retenção atomicamente. As duas bases têm snapshots próprios, não uma transação distribuída. Os horários são expostos separadamente; relógios devem estar sincronizados (tolerância de 5 s para o corporativo anterior ao local). Há lock por origem entre processos/versões, claim persistido, coalescência e backoff existente de 30/60/300 s. COMMIT incerto é resolvido pelo ponteiro persistido, sem repetir a escrita administrativa para adivinhar o resultado. A retenção de duas gerações afeta só a versão ativa; v1 não é apagado ou reescrito por v2.

HTTP consulta exclusivamente snapshots persistidos e não possui fallback analítico síncrono. Até a primeira geração v2 retorna inicialização; não serve v1 como se fosse MADM. Falha de atualização marca a geração como STALE, mantém o último conteúdo íntegro e expõe causa/próxima tentativa. Máximo de idade 900 s; após isso, 503. A coleta do dia pode continuar sendo consultada pelo refresh manual local mesmo sem MADM. Status/outbox operacionais continuam nos endpoints existentes.

Pools: leitor local 1, atualizador local 1 (já existentes) + leitor corporativo 1 (novo), checkout de até 1 s. O corporativo usa TLS com verificação e `default_transaction_read_only=on`; recomenda-se credencial somente SELECT. Statement corporativo 25 s, deadline 30 s; deadline global do atualizador existente 40 s. SQL mantém JIT off, work_mem 16 MiB, no máximo 1 worker paralelo e temp_file_limit 768 MiB por backend. Ambos os papéis analíticos precisam poder definir esse limite; ausência de privilégio conserva a geração anterior. HTTP mantém limite de 5 s e revalidação do ponteiro a cada 1 s; navegador reutiliza o polling existente para Dashboard e Relatórios. Cache/frescor de exibição até 300 s, sem aumentar timeout HTTP.

## Configuração e publicação após aprovação

1. Em homologação, revisar o diff e executar as verificações abaixo com Node 24. Salvar a imagem anterior e a configuração de relatórios. Não modificar configurações OLOS/Delivery e não iniciar outra instância do worker.
2. Verificar a existência das tabelas administrativas da migration 003 no **PostgreSQL local**. Não há migration v2 a aplicar. Se 003 faltar, interromper a adoção e revisar separadamente sua aplicação manual; não executar todas as migrations automaticamente.
3. Configurar o serviço existente. No Dokploy, `compose.dokploy.yaml` já carrega o arquivo privado de credenciais com `env_file`; os novos parâmetros devem entrar nesse arquivo, preservando as demais linhas. O override `compose.admin.yaml` também encaminha as variáveis abaixo quando usado fora do Dokploy:

```dotenv
ADMIN_REPORT_CONTRACT_VERSION=2
# Preferir um usuário dedicado somente SELECT; TLS é sempre verificado.
ADMIN_REPORT_CORPORATE_DATABASE_URL=postgresql://USUARIO_READONLY:SENHA_CODIFICADA@HOST_MADM:5432/madm
ADMIN_REPORT_CORPORATE_CA_FILE=/run/secrets/madm-postgres-ca.pem
# Somente se data_ligacao for timestamp without time zone e a semântica for confirmada:
ADMIN_REPORT_TIMESTAMP_ZONE=America/Sao_Paulo
ADMIN_REPORT_TIMESTAMP_CONFIRMATION=CONFIRM_TIMESTAMP_America/Sao_Paulo
```

URL/CA vazias usam a conexão corporativa existente em `cfg.corporateDelivery`, quando configurada; somente sua timezone explicitamente confirmada é herdada, e apenas para o mesmo endpoint corporativo. Uma URL dedicada permite relatórios sem habilitar escrita do Delivery. Não usar `sslmode=disable`, nem colocar senhas em comandos/logs. Montar a CA pelo mecanismo já utilizado no serviço. Não assumir Brasília para timestamp sem timezone: o exemplo acima só vale após confirmação do conteúdo.

4. DBA revisa os privilégios, sem conceder escrita às fontes. No MADM, o papel de relatórios precisa de CONNECT/USAGE no banco/schema, SELECT em `raw.olos_calls` e permissão para `SET temp_file_limit`. No local, o atualizador usa SELECT em records/reads/outbox/quarentena e no destino local (somente indicadores operacionais), SELECT/INSERT/DELETE em report_snapshots e SELECT/INSERT/UPDATE em report_snapshot_state. O leitor HTTP usa apenas SELECT nas tabelas analíticas; refresh manual local também requer SELECT em records. Exemplo de concessões para **papéis já existentes**, após revisão e aprovação, sem executar neste trabalho:

```sql
-- MADM; ajustar o nome do papel existente.
GRANT USAGE ON SCHEMA raw TO madm_reports_ro;
GRANT SELECT ON raw.olos_calls TO madm_reports_ro;
GRANT SET ON PARAMETER temp_file_limit TO madm_reports_ro;
-- Local; ajustar o papel existente caso ainda não tenha esse privilégio.
GRANT SET ON PARAMETER temp_file_limit TO olos_report_builder;
```

5. Publicar a imagem aprovada no **mesmo serviço existente**, pelo mecanismo de publicação da VPS/Dokploy, respeitando o encerramento gracioso. Este documento não executa publicação e não cria stack, worker ou agendador paralelo. Após o reinício, aguardar a primeira `report_snapshot_published` v2 e consultar o Admin autenticado: fonte `madm.raw.olos_calls`, contrato 2, READY, tempos, idades e erro do updater. Confirmar separadamente que coleta e Delivery continuam avançando.
6. Comparar dias/períodos com uma consulta direta **somente leitura**, usando credencial dedicada e arquivo de serviço libpq protegido (`PGSERVICE=madm_reports_ro`). Não usar os números de auditoria de 11/11 como assertivas fixas. Para uma coluna `timestamptz`, exemplo com datas escolhidas pelo operador:

```sh
PGSERVICE=madm_reports_ro PGOPTIONS='-c default_transaction_read_only=on' \
  psql -X -v ON_ERROR_STOP=1 -v from=2026-11-05 -v to=2026-11-11 <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='25s';
SELECT (data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) AS chamadas,
       count(*) FILTER (WHERE internal_id_olos IS NULL) AS sem_id_interno
FROM raw.olos_calls
WHERE (data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN :'from'::date AND :'to'::date
GROUP BY dia ORDER BY dia;
ROLLBACK;
SQL
```

Para `timestamp without time zone`, substituir **ambas** as expressões de data por `((data_ligacao AT TIME ZONE '<zona_confirmada>') AT TIME ZONE 'America/Sao_Paulo')::date`. Reconciliar horários de observação: inserções/alterações entre as duas consultas podem gerar diferenças legítimas. Validar também CPF/e-mail, operadores comprovados, dias sem movimento, CSV, totais de período e operação local. Observar ao menos um backfill controlado de homologação e duas atualizações automáticas. Não inserir dados de teste em produção.

## Rollback

Sem DDL ou remoção de dados: definir `ADMIN_REPORT_CONTRACT_VERSION=1` na configuração privada do serviço e reiniciar de forma controlada o mesmo serviço, ou retornar à imagem anterior e sua configuração. O novo processo lê/publica apenas contrato v1. Como v1 ficou preservado mas pode estar velho, aguardar uma nova geração v1; não relaxar o limite de idade. A fonte volta explicitamente a ser PostgreSQL local e carrega sua limitação conhecida de desatualização. Rollback não corrige esse histórico local; deve ser decisão operacional explícita. Manter todas as tabelas/generações v2. Não executar a migration de rollback 003, não alterar controle de Delivery, IDs, sequências, recibos ou quarentenas.

## Reprodução e evidência

```sh
export PATH=/home/madm/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run test:admin-ui
npm run build
npm run typecheck:admin
npm run build:admin
bash scripts/test-admin-reports.sh
bash scripts/test-admin.sh
REPORT_CORPORATE=1 REPORT_CORPORATE_BENCH=1 bash scripts/test-admin-reports.sh
npm run typecheck
```

Os runners usam somente PostgreSQL 16 descartável em loopback e não leem `.env` ou DATABASE_URL operacional. A suíte v2 usa dois bancos distintos e usuário corporativo somente leitura. Cobre totais diários e períodos, NULLs, repetição de CallId, regras Unicode/AgentId/CPF/e-mail, prova de payload, gráficos/tabelas/CSV, backfills/alterações/exclusões, concorrência, publicação/rollback, COMMIT incerto, conexão encerrada, timeout, permissões, RLS, timestamps sem zona, corrupção, preservação v1, reinícios e ausência de fontes opcionais. O benchmark inclui 2.050.000 records locais e 50.000 chamadas corporativas com provas de identidade, além da fixture funcional.

Resultados e limites da execução local ficam em [evidence/corporate-reports-v2/validation.json](evidence/corporate-reports-v2/validation.json). O typecheck global possui 17 diagnósticos preexistentes em `test/corporate-delivery.integration.ts`; comparar integralmente com o log do HEAD-base antes de declarar regressão. Não se afirma compatibilidade produtiva, latência WAN, validação TLS em ambiente real nem carga concorrente sustentada de OLOS/Delivery a partir de fixtures locais.

Execução final local: 137/137 unitários, 22/22 UI, 14/14 SQL legado, 18/18 snapshots v1, 17/17 relatórios v2 e 16/16 administrativos PostgreSQL. A execução separada com escala passou 18/18 (17 funcionais + benchmark). Build de backend, build estático e typecheck administrativo aprovados. Typecheck global: os mesmos 17 diagnósticos do HEAD-base `e59a998`, com logs comparados byte a byte. Nenhuma falha nova foi suprimida.

Benchmark final sintético: atualização completa em 2.03 s; HTTP p95 1.90 ms, máximo 5.55 ms em 60 requisições, com totais/operadores verificados. RSS do processo de teste 279.25 MiB, incluindo criação da fixture; não é medição isolada do serviço com ingestão real. Dois bancos no mesmo PostgreSQL descartável, loopback e cache aquecido; sem WAN ou carga OLOS/Delivery sustentada. Não se extrapolam esses tempos ao ambiente produtivo.
