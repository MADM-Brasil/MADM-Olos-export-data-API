# Integração com a OLOS ExportDataV3

[Início](../README.md) / Backend

## Objetivo

Consumir registros disponibilizados pela API OLOS ExportDataV3 com autenticação Bearer, controle de chamada e persistência da resposta antes de processar os itens.

## Componentes

- `src/auth.ts`: `OlosAuthManager`, token de acesso, refresh token, renovação e invalidação seletiva.
- `src/api.ts`: `OlosApi`, validação de respostas e operações de leitura.
- `src/worker.ts`: preparação do ciclo e tratamento de falhas.

## Operações identificadas no código

| Caminho de API OLOS | Finalidade no módulo |
|---|---|
| `/api/auth` | Obter/renovar token |
| `/api/export-data/available-tables` | Validar catálogo de tabelas |
| `/api/export-data/read-data-current-day` | Ler dados disponibilizados do dia corrente |
| `/api/export-data/re-read-data` | Releitura autorizada por especificação |

O backend também encapsula métodos de transporte genéricos. Não deduza que uma rota não localizada nesta lista está habilitada para consumo manual.

## Tratamento de autenticação

O gerenciador reaproveita o token ainda válido, renova quando necessário e tem tratamento de `401` para invalidação/reautenticação sem invalidar indevidamente um token mais recente. Falha de autenticação **antes** da chamada consumidora não deve ser confundida com resposta consumida e perdida.

## Risco de consumo

Algumas operações da OLOS avançam cursores ou são semanticamente consumidoras. Repetir uma operação durante investigação pode gerar duplicidade, perda de visibilidade ou um estado externo incerto. **Não execute chamadas de leitura manualmente contra a produção fora do fluxo autorizado.**

## Resposta durável

A intenção fica em `olos_http.reads` (`reading`); a resposta e seu tempo HTTP são registrados como `received`; o `Store` converte e persiste o conteúdo até `done`. Veja [Worker](worker-ingestao.md) e [Recuperação](recuperacao.md).
