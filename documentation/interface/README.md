# Manual do painel administrativo

[Início](../README.md) / Interface

O painel possui **sete itens no menu lateral e seis páginas independentes**. **Auditoria** é um atalho para uma seção de **Status operacional**.

| Menu | O que você encontra | Página |
|---|---|---|
| Dashboard | Indicadores atuais, contagem regressiva, gráfico e terminal compartilhado | [Abrir guia](dashboard.md) |
| Status operacional | Saúde do ambiente, execução e auditoria | [Abrir guia](status-operacional.md) |
| Relatórios | Histórico por data, operadores, recibos, gráfico, CSV | [Abrir guia](relatorios.md) |
| Terminal / Logs | Eventos sanitizados e últimas 100 leituras | [Abrir guia](terminal-logs.md) |
| Credenciais OLOS | URL, usuário, senha e teste de autenticação | [Abrir guia](credenciais.md) |
| Agendamento | Frequência, pausa e retomada | [Abrir guia](agendamento.md) |
| Auditoria | Histórico de ações administrativas dentro de Status operacional | [Abrir guia](auditoria.md) |

## Controles que aparecem em várias páginas

**Iniciar Worker:** solicita `RUNNING`, quando o backend admite a ação. **Parar Worker:** exige confirmação e aguarda o processamento ativo. **Sair:** encerra a sessão. O estado real deve ser verificado em **Status operacional**, pois o recebimento de um comando não equivale à conclusão da transição.

## Atualização da interface

O frontend consulta o status aproximadamente a cada **2 segundos**; o Dashboard tenta atualizar indicadores aproximadamente a cada **30 segundos** enquanto estiver aberto; o relógio é recalculado a cada **1 segundo**. A frequência de exibição não deve ser confundida com a frequência de captura na OLOS.

## Convenções

- `—`: dado não disponível ou não medido, **não** significa zero.
- *Desatualizado*: último dado válido preservado, mas fora da janela de frescor indicada.
- *Controle liberado*: estado de controle local, não prova de conexão ativa com o MADM.
- Horários e períodos de relatórios usam a referência de **Brasília**.
