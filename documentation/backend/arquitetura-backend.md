# Componentes e execução do backend

[Início](../README.md) / Backend

## Runtime e bibliotecas

O inventário auditado identificou **TypeScript / Node.js**, ESM (`type: module`), PostgreSQL por `pg`, HTTP por `undici`, datas com `luxon` e JSON preciso com `lossless-json`. O processo administrativo utiliza módulos nativos `node:http`.

## Pontos de entrada

- `src/main.ts`: entrada da aplicação e comandos.
- `src/admin/main.ts`: modo administrado, inicialização da API web, repositório e scheduler.
- `src/admin/server.ts`: atendimento das rotas, autenticação de sessão, controle de origem e CSRF.
- `src/admin/repository.ts`: métodos persistentes e observações operacionais.
- `src/admin/consumer.ts`: criação e segurança do consumidor agendado.
- `src/scheduler.ts`: transições, espera e execução.

## Interface

Arquivos em `admin/public/`: `index.html`, `app.js`, `dashboard.js`, `corporate-report.js`, `ui.js` e `style.css`. O painel usa frontend JavaScript modular, sem evidência de React no Admin auditado.

## Caminhos de leitura

**Status:** `/api/status` combina `repository.observation()` com `scheduler.status()` e dados da sessão.
**Relatórios MADM:** `/api/corporate/daily` compõe consulta corporativa, recibos e contagens locais.
**Snapshots locais:** `/api/reports` e `/api/today` existem no backend, mas não são a fonte principal das telas corporativas auditadas.

## Caminhos de escrita administrativa

`/api/schedule`, `/api/worker/{start,pause,resume,stop}` e `/api/credentials` executam alterações reais. Rotas não GET exigem sessão autenticada, origem admitida e token CSRF. `stop` requer confirmação no corpo.

## Limites operacionais identificados

As rotas de relatórios priorizam consultas de leitura com timeouts e cache. A leitura corporativa usa conexão TLS validada com CA configurada. Evite acrescentar queries históricas diretamente ao ciclo de status de 2 segundos.
