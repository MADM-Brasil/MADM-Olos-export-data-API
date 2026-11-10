# Gráfico analítico — Forest Obsidian Precision

Referências inspecionadas: `~/Downloads/dash-expend.png`, `desh-premium..png` e `DESIGN.md`. Evolução do SVG existente em `public/ui.js`; não há biblioteca, novo módulo ou segundo gráfico. Fontes e tokens globais existentes preservados.

## Dados e cálculos

Auditado `src/admin/reports.ts`: `/api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD` retorna séries por **data da ligação em America/Sao_Paulo**, com contagens decimais textuais. Não utiliza a primeira persistência local que alimenta o card de hoje. A identificação continua sendo a classificação calculada no backend, sem regra nova no cliente. Os KPIs usam exclusivamente `daily`, não `summary` (histórico global), nem o card de hoje. `period` não é misturado a uma série diferente.

| Indicador | Cálculo |
|---|---|
| Total coletadas | Soma BigInt de `daily.calls` no período selecionado |
| Com operador identificado | Soma BigInt de `daily.identified_calls`; percentual sobre o mesmo total, arredondado a uma casa decimal |
| Média diária | Total dividido pelos dias corridos inclusivos da seleção, incluindo dias omitidos na resposta válida como zero; arredondamento exato a uma casa decimal |
| Pico diário registrado | Maior total diário; empate escolhe a primeira data cronológica; sem volume, não atribui um pico arbitrário |

A inclusão do dia atual está marcada como parcial na média, no grupo e no tooltip. Dias retornados inválidos, contagens ausentes/numéricas em vez de strings, duplicatas e identificadas acima do total são recusados; uma falha não vira zero. Somente uma resposta válida pode fornecer zeros para dias sem chamadas. Nenhuma variação semanal, capacidade ou desvio padrão fictício é exibido.

`chartModel` centraliza preenchimento de datas, KPIs, pico e escala. BigInt preserva totais, comparações e divisões. Apenas razões inteiras limitadas a 1.000.000 e índices pequenos viram Number para coordenadas SVG. A escala usa intervalos 1/2/5 × potência de dez; não há máximo fixo. Rótulos compactos são pt-BR; tooltip mantém contagens completas. Testado acima de Number.MAX_SAFE_INTEGER.

## Comportamento

Accordion inicia recolhido; KPIs, filtros e gráfico ficam ocultos/inert. Quatro filtros: Hoje, últimos 7 (padrão), 14 e 30 dias, com limites calculados pelo calendário de Brasília. Trocar o período não fecha o accordion. Cache por intervalo (máximo de oito entradas), validade do snapshot existente e coalescência por intervalo; respostas atrasadas só entram na seleção correspondente. Logout limpa os dados/cache; respostas de outra sessão são ignoradas. Relatórios conserva seu filtro padrão independente.

Barras agrupadas lado a lado, base zero, cantos superiores arredondados, duas séries `--forest` (#176B50) e `--emerald` (#24956E), destaque suave do dia atual e etiqueta do pico derivado da série. KPIs sobre `--surface-container-low` (#E8F7EE), bordas `--hairline`, texto `--text-primary`/`--text-muted`. Tooltip usa `--obsidian`, `--terminal-text`, `--secondary-container` e `--terminal-border`. Sem nova paleta.

Tooltip por hover, foco/Enter/Espaço e toque; Escape fecha. Posicionamento limitado ao contêiner e largura adaptativa. Conteúdo sanitizado por construção textual, sem HTML fornecido pelo servidor. Mostra snapshot somente com observed_at válido; não consulta a API durante interação. Eventos delegados pertencem ao SVG substituído, sem acumular listeners externos. A atualização de um snapshot sem mudança da série reaproveita o SVG; countdown não redesenha o gráfico. Exceção de renderização não invalida KPIs nem cards/terminal.

Barras entram em 380 ms a partir da base; tooltip em 140 ms, filtros em 160 ms, accordion em 220 ms. Sem animação infinita no gráfico. Respeita reduced-motion. Não é necessário relaxar a CSP: origem da transformação é atributo de apresentação SVG, não style inline via setAttribute.

Desktop com quatro KPIs; tablet/mobile com duas colunas e cabeçalho/filtros adaptados. Séries densas têm scroll horizontal somente no gráfico; datas e dias da semana continuam legíveis. O rodapé abre Relatórios existente com o período selecionado e preserva sessão/CSV.

Sidebar e `.event-output` usam scrollbar-width:none e ::-webkit-scrollbar sem overflow:hidden. Conservados scroll nativo, teclado, toque, polling, buffer, sanitização, pausa, cópia e âncora do terminal. Textos dos botões de navegação usam peso 600; metadados não foram engrossados.

## Verificação local e evidências

- `npm run test:admin-ui`: 14 aprovados, incluindo limites de Brasília, média, pico/empate, escala, dias omitidos, dados inválidos e BigInt.
- `npm run typecheck:admin`, `npm run build:admin`, `git diff --check`: aprovados.
- `test/admin-redesign.browser.mjs` com Playwright/Chromium existentes e API local simulada: navegação, accordion/Enter/Espaço/cache, quatro filtros e KPIs, resposta de 14 dias retida por gate enquanto 30 dias conclui, tooltip por teclado/hover/toque, ausência de GET por hover e por cache, identidade do SVG sem mudança de dados, barras adjacentes/base comum, CTA de relatórios, sidebar/terminal roláveis sem scrollbar, peso 600, responsividade, dados vazios/erros, reduced-motion e regressões existentes do terminal/sessão/CSRF. Nenhum serviço real é acessado.
- Capturas em `evidence/analytic-chart/`: recolhido (`premium-desktop.png`), expandido 7/14/30 dias, painéis isolados `panel-7d.png`/`panel-14d.png`/`panel-30d.png`, tooltip, tablet, mobile, sidebar e terminal após rolagem. Dados sintéticos rotulados apenas no servidor de testes, nunca inseridos no frontend de produção.

Comparação visual manual com dash-expend.png seguida de revisão de geometria, base das barras, escala, verdes, KPIs, tooltip e rodapé. Números, escala, percentuais e dias da semana diferem porque refletem dados válidos, não os exemplos da imagem. As fontes e a altura do terminal anterior foram preservadas; por isso o painel ocupa outra posição na página completa. Filtros ficam em uma linha analítica própria dentro do accordion, sem botões aninhados no botão expansor. Não se declara equivalência pixel-perfect.

Arquivos: `public/index.html`, `public/style.css`, `public/app.js`, `public/ui.js`, dois testes de UI/browser, esta nota e novas evidências. Nenhuma alteração em backend, scheduler, Autonomous Recovery, PostgreSQL, migrações, ingestão, outbox, recibos, Corporate Delivery ou dependências. Sem commit, push, deploy ou acesso à produção.
