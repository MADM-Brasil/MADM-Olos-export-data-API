# Terminal operacional restaurado

## Escopo e evidência da auditoria

Trabalho exclusivamente local sobre `843edee` (redesign premium), com checkout inicialmente limpo. A comparação usou `dca50bf`, imediatamente anterior ao premium, e `6749a6c`, que já continha o terminal com buffer completo. A implementação anterior foi lida com `git show`; nenhum arquivo foi restaurado indiscriminadamente.

O problema estava na apresentação: `renderTerminal()` limitava o resultado a `filtered.slice(-12)` e colocava os detalhes em elementos `<details>` fechados. O endpoint, o buffer e as famílias de eventos não haviam sido removidos. O backend continua oferecendo um snapshot do buffer em memória do processo, com até 200 eventos sanitizados, em `/api/events`.

| Aspecto | Antes do premium (`dca50bf`) | Premium (`843edee`) | Restaurado |
| --- | --- | --- | --- |
| Eventos mostrados sem filtro | Todo o buffer recebido | Últimos 12; restante exigia “Mostrar todos” | Todo o buffer disponível, até 200 |
| Detalhes operacionais | `chave=valor` diretamente no texto | Ocultos atrás de expansão de cada linha | Diretamente na linha: horário, nível, evento e detalhes |
| Tipos de evento | 15 famílias permitidas | Mesmas 15 famílias | Mesmas 15 famílias, testadas explicitamente |
| Campos do endpoint | Lista sanitizada; já descartava `skipped` e `next_run_at` | Mesma omissão | Lista alinhada ao endpoint para esses dois campos, com validação numérica/data |
| Ordem | Ordem recebida | Ordenação cronológica apenas na apresentação; cópia usava ordem recebida | Ordenação cronológica estável compartilhada por apresentação e cópia |
| Busca | Nome do evento | Nome do evento | Toda a linha sanitizada, incluindo detalhes, códigos e `read_id` |
| Autoscroll | Forçava o final se marcado | Forçava o final se marcado | Segue o final quando o operador já está próximo dele; preserva a linha visível ao consultar eventos antigos |
| Polling | Ciclo de 2 segundos | Mesmo ciclo, aguardando o fim de `/status` | Mesmo ciclo de 2 segundos, independente da conclusão de `/status`, com uma requisição de eventos em voo |
| Fonte/retenção | Memória do processo, até 200 | Mesma fonte | Mesma fonte, com limite explicitado na interface |

Não houve alteração em backend, autenticação, permissões, scheduler, ingestão, ExportDataV3, Corporate Delivery, outbox, consultas históricas, contador diário, countdown ou accordion. Os dois cards, o terminal entre os cards e o gráfico, e o visual premium permanecem.

## Implementação

- `admin/public/ui.js`: mantém a sanitização por campos/tipos permitidos; inclui `skipped` e `next_run_at` já disponíveis no endpoint. `terminalRows()` centraliza formatação, busca, nível e ordenação; `eventLines()` e `renderTerminal()` usam a mesma projeção. Todas as linhas são montadas com `textContent`, sem HTML vindo dos eventos. Eventos repetidos continuam presentes; a chave visual não deduplica o buffer.
- `admin/public/app.js`: conserva o único componente compartilhado entre Dashboard e Logs, o único timer de 2 segundos, o bloqueio de requisições sobrepostas e a proteção de sessão. Inicia a atualização do terminal antes de aguardar status. Mantém pausa, retomada, cópia, indicação de falha e horário da última resposta válida. Não cria consultas SQL.
- `admin/public/index.html`: remove “Mostrar todos”; mostra o buffer completo por padrão. Explica retenção, pausa e acompanhamento. Busca e filtros permanecem na disclosure existente.
- `admin/public/style.css`: console monoespaçado, campos diretamente na linha, separadores `|`, cores discretas por severidade, quebra de linhas longas e scroll vertical com altura de 240 px. Estilos restritos ao terminal.
- `test/admin-ui.test.mjs`: contrato dos 15 eventos e campos, sanitização, 200 linhas, busca por detalhes, ordenação e cópia.
- `test/admin-redesign.browser.mjs`: regressões do terminal e da Dashboard; permite salvar novas evidências em diretório separado usando `ADMIN_EVIDENCE_DIR`.
- `admin/terminal-restoration.md`: este relatório.
- `admin/evidence/terminal-restored/*.png`: novas imagens sintéticas; as evidências anteriores foram preservadas.

Cada linha apresenta `DATA/HORÁRIO Brasília | NÍVEL | EVENTO | DETALHES OPERACIONAIS`. Datas de agendamento são convertidas para Brasília; os valores operacionais não são estimados. Todos os campos sanitizados anteriores continuam disponíveis, incluindo contagens, tempos, código de erro e identificador de leitura.

Não há payload bruto autorizado no endpoint atual. Portanto, não há expansão de payload nem ocultação de detalhes básicos; não foi criado um acesso a dados pessoais ou mensagens arbitrárias. Credenciais, tokens, CPF, e-mail, payloads e textos de erro livres continuam excluídos. Níveis continuam derivados pela regra anterior, sem alterar a auditoria real.

## Scroll, pausa e retenção

Com Autoscroll ligado, novas respostas acompanham o final somente quando o operador já está a até 24 px dele. Ao rolar para cima, a atualização preserva a posição da linha visível, inclusive quando a primeira entrada do buffer é removida pela retenção. Voltar ao final retoma o acompanhamento; desmarcar Autoscroll desativa-o, e marcar novamente leva explicitamente ao final.

Se a linha examinada sair do próprio buffer do endpoint, ela não pode ser recuperada pelo terminal; preserva-se a posição possível dentro do novo buffer. Não é mantido um histórico oculto ou uma retenção ampliada no navegador.

Pausar congela a projeção e suspende as consultas do terminal, como antes. Retomar busca o snapshot atual. Durante a pausa, eventos podem sair da retenção do processo; não se promete recuperá-los. Filtros reduzem somente a visualização e a cópia e não apagam o buffer recebido. A interface indica quantos eventos estão visíveis e quantos estão disponíveis.

Em erro de conexão, o último buffer válido permanece identificado como desatualizado. Sessão expirada limpa a projeção e respostas tardias não a repovoam. Não há uma segunda fonte, processo de captura, timer ou endpoint.

## Validação local

- `npm test`: **98/98 aprovados**.
- `npm run test:admin-ui`: **10/10 aprovados**.
- `npm run build:admin`: aprovado, incluindo checagem TypeScript dos assets.
- `npm run build`: aprovado.
- Playwright/Chromium: fluxo integrado desktop/mobile aprovado. Buffer completo e detalhes sem clique; 2 segundos reais mesmo com `/status` lento; ausência de consultas de eventos sobrepostas; INFO/WARN/ERROR e busca por detalhes; pausa/retomada; cópia das 200 linhas; sanitização; autoscroll e preservação da linha após rotação do buffer; falha/recuperação; sessão expirada e resposta de eventos tardia. Regressões existentes de cards, countdown, gráfico, Relatórios e demais abas também aprovadas.
- `npm run typecheck`: permanece com **17 erros preexistentes** em `test/corporate-delivery.integration.ts`, idênticos ao baseline anterior. Nenhum erro novo de TypeScript foi introduzido nos arquivos deste escopo.
- `git diff --check`: aprovado.

O navegador utiliza apenas fixtures em localhost, sem OLOS, PostgreSQL ou serviços reais. As imagens são identificadas como dados sintéticos. Erros HTTP 401/503 são injetados intencionalmente; não houve exceções de página ou erros JavaScript inesperados no console. Não houve consulta a produção, migração, commit, push ou deploy.

Evidências: [desktop](evidence/terminal-restored/premium-desktop.png), [mobile](evidence/terminal-restored/premium-mobile.png), [gráfico preservado](evidence/terminal-restored/premium-expanded.png), [Relatórios preservados](evidence/terminal-restored/premium-reports.png).

Para repetir com Node 24 e Playwright/Chromium já disponíveis, sem adicionar dependências ao projeto:

```sh
npm test
npm run test:admin-ui
npm run build:admin
npm run build
ADMIN_EVIDENCE_DIR=admin/evidence/terminal-restored \
ADMIN_PLAYWRIGHT_PATH=/caminho/node_modules/playwright \
ADMIN_CHROMIUM_PATH=/caminho/chrome \
node test/admin-redesign.browser.mjs
```

A validação comprova a implementação local e a interface contra o contrato do endpoint. Não constitui evidência de funcionamento em produção.
