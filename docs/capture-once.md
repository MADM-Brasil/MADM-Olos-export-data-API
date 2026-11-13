# Captura transacional única para homologação

Implementação preparada; **nenhuma captura real foi executada nesta alteração**. O comando usa `HttpTransport`, `OlosAuthManager`, `OlosApi` e `Store`. Não usa Prisma nem cria tabelas, flags, migrations ou serviços novos.

## Execução, somente após autorização da captura real

Na raiz do projeto, com Node 24, build atualizado e `.env` privado já configurado para o destino autorizado:

```bash
node --env-file=.env dist/main.js capture-once
```

Alternativa com uma imagem previamente construída e as mesmas variáveis do Compose:

```bash
WORKER_COMMAND=capture-once docker compose --env-file .env run --rm --no-deps worker
```

Não executar ambos: são alternativas. Não definir `WORKER_COMMAND=start`. Manter outros consumidores parados. O lock coordena somente processos com o mesmo banco e `OLOS_SOURCE_KEY`; não bloqueia Postman ou consumidores em outros bancos. O `.env` não é carregado implicitamente pelo executável Node.

`Store.open()` mantém os preflights e o lock já existentes. A captura continua dependendo de um esquema válido e das tabelas de controle previamente provisionadas; não existe bypass dessas verificações. `SOURCE_ID_UNIQUENESS_CONFIRMED` pode permanecer `false`. TLS conserva a configuração existente, verificado por padrão e restrito ao agente OLOS.

## Fluxo e estados

1. Adquire lock, verifica PostgreSQL e bloqueia qualquer `reading` ou `received` da origem antes de HTTP.
2. Autentica e valida o catálogo. O catálogo usa uma tentativa, sem retry. Não carrega nem reconcilia o cache estático.
3. `beginRead({kind:'current'})` verifica pendências novamente e grava a intenção em `olos_http.reads` antes do POST.
4. Executa **uma única tentativa** de `POST /api/export-data/read-data-current-day`, multipart `TableName=AttemptsRawData`. Não repete nem após 401/429; não faz backoff nem polling. O ciclo normal de renovação do AuthManager permanece disponível antes do envio, sem replay do POST.
5. Persiste o texto integral da resposta UTF-8 em `response_body` via `stage()`, preservando espaços, números textuais e eventual BOM. Não faz parse, validação de identidade ou normalização. Também preserva envelopes inesperados e JSON inválido para auditoria.

| Situação | Estado persistido |
|---|---|
| Falha de autenticação/catálogo antes da intenção | Nenhuma leitura nova |
| Intenção confirmada | `reading`, corpo NULL, `processed_count=0` |
| HTTP 200 e staging confirmado, inclusive `[]` | `received`, corpo completo, `processed_count=0` |
| Timeout, erro HTTP ou falha de staging | Pendência mantida; código sanitizado quando possível |
| Staging confirmado no servidor mas ACK perdido | Pode estar `received`; reinspecionar antes de agir |

`received_count` e `finished_at` ficam sem preenchimento nesta etapa: o payload ainda não foi validado e a captura não foi normalizada. Não há `drain()`, escrita em `raw.olos_calls`, atualização de `olos_http.records` ou reconciliação de nomes. Logs exibem somente UUID técnico, estado, tamanho e durações/código de erro, nunca payload ou tokens.

Após a intenção, inclusive rejeições explícitas permanecem pendentes para revisão, sem resolução automática. Uma segunda `capture-once` é bloqueada. Se o processo cair entre consumo remoto e staging, a intenção não recupera o corpo por si só: há risco residual e não se promete entrega exatamente uma vez.

## Inspeção sem revelar dados pessoais

Use uma sessão PostgreSQL autenticada de forma privada, sem colocar a string de conexão na linha de comando. Substitua somente o UUID técnico abaixo. Esta consulta não faz cast JSON: uma resposta inválida não provoca erro contendo trechos do payload.

```sql
BEGIN READ ONLY;
SELECT id, state, started_at, finished_at,
       response_body IS NOT NULL AS has_response,
       octet_length(response_body) AS response_bytes,
       md5(response_body) AS response_fingerprint,
       request_ms, processed_count, received_count, error_code
FROM olos_http.reads
WHERE id = 'UUID_DA_CAPTURA'::uuid;
ROLLBACK;
```

O fingerprint é apenas auxiliar de comparação, não prova criptográfica de autenticidade. Não executar `SELECT *`, imprimir `response_body`, `resolution` ou campos de negócio. Para listar pendências com metadados limitados:

```bash
node --env-file=.env dist/main.js status
```

A inspeção do contrato exige acesso privado ao corpo persistido; não exportar para Git, console ou logs compartilhados. `received` comprova armazenamento, não validade do contrato.

## Recuperação de captura interrompida

1. Manter todos os consumidores parados. Preservar a intenção, corpo e erros. Executar `status` e a consulta de metadados acima; não repetir a captura para testar.
2. Se estiver `received`, a resposta está localmente preservada, inclusive no caso de ACK perdido. Continuar a homologação offline do contrato e da identidade. **Não usar `recover-local`, `once`, `start`, `previous` ou `reread` nesta etapa:** eles podem normalizar dados e escrever no destino. Nenhum desses comandos é necessário para concluir a captura bruta.
3. Se estiver `reading` sem corpo, o resultado remoto pode ser incerto. Confirmar com a OLOS que a operação terminou e correlacionar horário, conta de consumo, tabela, data de exportação, faixa e quantidade. Sob autorização operacional, o comando existente `log-read DATA ARQUIVO_PRIVADO` salva o log oficial sem imprimi-lo. Não usar StartDate como data de exportação presumida nem inferir contagem por diferença entre IDs.
4. Havendo faixa perdida comprovada, obter autorização específica para recuperação oficial `re-read-data`. **Este comando novo não implementa releitura bruta.** O `reread` já existente normaliza e grava no destino, portanto só pode ser usado depois de homologar o contrato/identidade e autorizar essa escrita. Se ainda for necessário recuperar somente evidência bruta, manter o bloqueio até existir um procedimento aprovado para isso; não usar o comando normalizador como atalho.
5. Somente após concluir a conciliação externa e comprovar recuperação dos dados ou ausência de consumo, o comando existente `resolve READ_UUID EVIDENCIA` pode registrar a resolução de uma intenção `reading`. Não executar `resolve` apenas para liberar uma segunda captura. Ele não recupera dados nem valida a evidência; não aceita descartar `received`. Não apagar linhas nem executar reset remoto.

## Validação desta alteração

Testes usam o transporte HTTP real contra servidor loopback e os componentes reais de autenticação/API/worker/Store. A sessão PostgreSQL é simulada na fronteira SQL, com lista explícita de comandos aceitos; qualquer escrita fora de `olos_http.reads` falha. Isso verifica o SQL solicitado pelo fluxo, sem comprovar commit/lock em um servidor PostgreSQL real nesta rodada.

Resultado com Node 24.16.0: **38 testes aprovados (17 novos de captura), typecheck e build aprovados**. A tentativa inicial com o Node 20 padrão do shell falhou ao carregar Undici; a validação foi repetida com a versão exigida pelo projeto, sem alterar dependências.

Cobertura: corpo completo, array vazio, envelope desconhecido, BOM, autenticação/catálogo indisponíveis, timeout, HTTP 401/403/429/500/421 sem replay, staging falho, ACK perdido, bloqueio de pendência após reinício, exclusividade, intenção falha, PostgreSQL indisponível e ausência de dados pessoais nos logs. Os testes não abrem conexão PostgreSQL nem executam migrations. A suíte de integração PostgreSQL existente não foi executada, pois seu setup aplica migrations.

```bash
npm run typecheck
npm test
npm run build
```
