# Referência da API administrativa

[Início](../README.md) / Referência

## Base e autenticação

Os caminhos abaixo são relativos à origem protegida do Admin. A UI os chama com prefixo `/api`. Com exceção do login e dos assets estáticos, as rotas requerem sessão administrativa. Métodos não GET exigem validação de origem e CSRF. Não há autorização nesta documentação para invocar comandos em produção.

| Método | Endpoint | Função | Impacto |
|---|---|---|---|
| POST | `/api/login` | Autenticar administrador | Cria sessão |
| GET | `/api/session` | Recuperar sessão existente | Leitura |
| POST | `/api/logout` | Encerrar sessão | Remove sessão |
| GET | `/api/status` | Estado do scheduler e observação local | Leitura |
| GET | `/api/today` | Primeiras persistências locais do dia (snapshot) | Leitura |
| POST | `/api/today/refresh` | Atualizar contagem local com rate limit | Consulta local controlada |
| GET | `/api/corporate/daily` | Histórico MADM e informações locais; filtros `from`, `to` | Consulta corporativa somente leitura |
| GET | `/api/reports` | Leitura de snapshot analítico local por `from` / `to` | Leitura |
| GET | `/api/credentials` | Visualizar configuração sem segredo aberto | Leitura |
| PUT | `/api/credentials` | Salvar configuração/revisão | **Altera** credenciais |
| POST | `/api/credentials/test` | Testar autenticação armazenada | Autenticação externa, não consome chamadas |
| GET | `/api/logs` | Histórico de leituras | Leitura |
| GET | `/api/events` | Eventos operacionais sanitizados | Leitura |
| GET | `/api/audit` | Histórico administrativo | Leitura |
| PATCH | `/api/schedule` | Alterar `interval_ms` | **Altera** scheduler |
| POST | `/api/worker/start` | Solicitar `RUNNING` | **Altera** scheduler |
| POST | `/api/worker/pause` | Solicitar `PAUSED` | **Altera** scheduler |
| POST | `/api/worker/resume` | Solicitar `RUNNING` | **Altera** scheduler |
| POST | `/api/worker/stop` | Solicitar `STOPPED`, com `{ "confirm": true }` | **Altera** scheduler |

## Status HTTP e erros

O servidor mapeia códigos como `LOGIN_FAILED`/`AUTHENTICATION_REQUIRED` para **401**, códigos terminados em `FORBIDDEN` para **403**, limitações/rate limit para **429**, conflitos para **409**, e indisponibilidade de relatórios para **503**, conforme o caso. Comandos operacionais aceitos podem retornar **202**, indicando admissão do pedido e não necessariamente conclusão.

## Exemplos não executáveis de contratos

```json
{
  "interval_ms": 60000
}
```

Esse é o formato conceitual do corpo usado em `PATCH /api/schedule`. A autenticação e o CSRF são obrigatórios; não copie este exemplo como comando de produção sem aprovação.

## Fonte do contrato

Rotas identificadas em `src/admin/server.ts`, chamadas de UI em `admin/public/app.js`; sem auditoria OpenAPI formal nesta edição.
