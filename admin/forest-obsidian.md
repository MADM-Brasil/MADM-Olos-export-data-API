# Forest Obsidian Precision — frontend local

Referências inspecionadas: `~/Downloads/desh-premium..png` (1600 × 1365) e `~/Downloads/DESIGN.md`. A imagem orienta layout; tokens e cores explícitos do PRD/Design orientam superfícies. A fonte existente foi preservada: Inter / Segoe UI / system-ui e ui-monospace / SFMono-Regular / Consolas, sem download ou instalação de fontes. O frontend não possui uma biblioteca de ícones ou arquivo oficial de logotipo; conserva o símbolo existente e usa SVGs inline de traço uniforme, sem dependências externas.

## Implementação

- `public/style.css`: paleta completa de cores do DESIGN.md, tokens adicionais do PRD, espaçamento, raios e sombra. Sidebar branca fluida (320 px na referência de 1600 px, próxima de 270 px em desktops menores), rail de 64 px no tablet e drawer acessível no mobile. Canvas `#eefdf4`, cards brancos, acento de 2 px, terminal `#0d1e17`, interior `#162620`, bordas `#1b2b24`, texto `#d4ddd8`.
- `public/index.html`: header branco, workspace, navegação com ícones, dois cards de métricas, terminal com ferramentas/colunas, gráfico recolhido e atalho de Auditoria para a seção já existente de Status operacional. Agendamento permanece disponível. O menu compacto mantém nomes acessíveis e os controles de logout/worker.
- `public/app.js`: mesmas fontes reais, sessão e CSRF, mesma requisição de eventos em voo e ciclo de 2 s. Os novos badges refletem o estado observado; ficam indisponíveis quando a observação falha ou expira. Datas usam Brasília. Nenhum timer/recurso remoto adicional.
- `public/ui.js`: reutilização de linhas por chave estável, sem reconstruir todo o buffer em cada render. Histórico inicial não recebe animação; apenas linhas novas. Texto continua sanitizado, com detalhes diretamente nas linhas e separadores preservados na cópia. Mantidos ordenação, filtros, 200 eventos, autoscroll e âncora da consulta manual.
- `test/admin-redesign.browser.mjs`: cenários originais mais identidade das linhas, animação somente de novas linhas, tokens/geometria, tablet, atalho de auditoria e badges indisponíveis. Asserção do countdown aguarda a resposta efetiva do polling compartilhado, em vez de presumir que uma chamada coalescida acabou de atualizar a tela.

Ícones inline: dashboard, activity, chart, terminal, key, shield-check, arrow-up-right, clock, user, pause, copy, chevron-down, building, log-out, list-filter, play, stop, calendar e menu. São símbolos SVG locais no próprio HTML, sem carregamentos externos.

Animações: entrada dos cards de 220 ms / 8 px, hover de 180 ms / 1 px, accordion de 220 ms com chevron, fade de novas linhas de 180 ms e pulso somente do ponto AO VIVO. `prefers-reduced-motion` desativa animações e transições; o countdown usa números tabulares e o relógio existente.

## Validação e comparação visual

Comandos (Node 24): `npm run test:admin-ui` (10 aprovados), `npm run typecheck:admin`, `npm run build:admin` e `git diff --check`. Chromium/Playwright existentes no host, sem instalação de dependências. A suite browser usa somente servidor local simulado, nunca banco, OLOS ou serviço operacional. Exercita navegação, dados reais do contrato simulado, filtros, cópia, pausa, rotação do buffer, scroll, erros, countdown, accordion/teclado/cache, sessão, logout e CSRF.

Evidências em `evidence/forest-obsidian/`: desktop 1600 × 1365, mobile 390 × 844, tablet 900 × 1024, gráfico expandido, relatórios e geometria medida. As capturas usam dados sintéticos explicitamente identificados; a aplicação não insere esses dados em produção.

Houve comparação visual manual entre a referência e a captura desktop na mesma largura, seguida de correções de alinhamento, ícones, metadados, espaçamento e apresentação no tablet. Na medição, sidebar 320 px, cards 588 × 300 px em x=360 e x=972, terminal com 1200 px de largura em x=360 e y≈637. As superfícies medidas são canvas rgb(238,253,244) e terminal rgb(13,30,23); raio dos cards 14 px. `geometry.json` contém as medidas da última execução.

Diferenças intencionais/residuais: símbolo de marca já existente em vez de redesenhar o logotipo sem o arquivo original; fontes mantidas conforme solicitado; sem percentual ilustrativo ou totais de 7 dias sem fonte; período existente de 30 dias preservado; Agendamento e explicação da fonte continuam acessíveis; detalhes longos quebram dentro da linha. O terminal utiliza os tokens explícitos, mesmo onde a imagem apresenta um verde visualmente mais claro. Há diferenças pequenas de tipografia e altura/posicionamento em relação à imagem. Não se declara equivalência pixel a pixel.

Somente frontend, teste browser, documentação e evidências foram alterados. Backend, contratos, scheduler, Autonomous Recovery, ingestão, Corporate Delivery, outbox e recibos permanecem sem mudanças. Sem commit, push, deploy ou acesso à produção.
