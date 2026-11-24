# OLOS ExportData V3 — MADM Brasil

> **Plataforma de Operações · Documentação funcional, técnica e operacional**
> Edição: **1.0 (rascunho auditado)** · Referência: **24/11/2026** · Produção observada: `20261119-enqueue-bulk-v1`

[Começar](introducao/primeiros-passos.md) · [Manual do painel](interface/README.md) · [Arquitetura](introducao/arquitetura.md) · [Operação](operacao/README.md) · [Referência API](referencia/endpoints.md)

---

## O que é

O **OLOS ExportData V3 — MADM** é uma aplicação de ingestão e administração que consulta dados disponibilizados pela API OLOS ExportDataV3, preserva o histórico de captura, normaliza os registros e os mantém em um PostgreSQL local. Por meio de uma **outbox durável**, prepara e controla a entrega de registros elegíveis ao banco corporativo da MADM. Um painel web permite acompanhar a operação, consultar indicadores e relatórios, administrar o agendamento, consultar eventos e gerenciar credenciais OLOS.

**Não é a discadora integrada nem o sistema que origina as ligações.** Esta aplicação atua na esteira de extração, persistência, entrega e observabilidade.

## Visão do fluxo

```mermaid
flowchart LR
  A[API OLOS ExportDataV3] --> B[Captura controlada]
  B --> C[Resposta durável em reads]
  C --> D[Mapeamento e batches]
  D --> E[records no PostgreSQL local]
  E --> F[corporate_outbox]
  F --> G[Entrega controlada]
  G --> H[PostgreSQL corporativo MADM]
  I[Painel administrativo] --> J[API administrativa]
  J --> K[Scheduler e observabilidade]
  K --> B
  J --> E
  J --> H
```

## O que o sistema oferece

| Área | Capacidades | Consulte |
|---|---|---|
| Captura | Autenticação OLOS, polling, armazenamento da resposta e processamento incremental | [Ingestão](backend/worker-ingestao.md) |
| Persistência | Identidade de origem, deduplicação, controle transacional e progresso | [Banco de dados](banco-de-dados/modelo-de-dados.md) |
| Entrega | Elegibilidade, estados `pending` / `confirmed` / `skipped`, fila e recibos | [Entrega corporativa](backend/entrega-corporativa.md) |
| Operação | Scheduler, estados operacionais, administração e auditoria | [Agendamento](interface/agendamento.md) |
| Visualização | Dashboard, status, relatórios, terminal e logs | [Manual do painel](interface/README.md) |

## Como usar esta documentação

- **Operadores e gestores:** comecem pelo [manual do painel](interface/README.md) e pelo [dicionário de indicadores](referencia/indicadores.md).
- **Suporte e administradores:** consultem [monitoramento](operacao/monitoramento.md), [troubleshooting](operacao/troubleshooting.md) e [segurança](operacao/seguranca.md).
- **Desenvolvedores:** consultem [arquitetura](introducao/arquitetura.md), [API](referencia/endpoints.md) e [modelo de dados](banco-de-dados/modelo-de-dados.md).

## Informações importantes

> [!IMPORTANT]
> **Captura local não é confirmação corporativa.** Uma resposta pode ser processada e persistida localmente antes de a entrega ao banco MADM ser confirmada.

> [!WARNING]
> **Não repita chamadas consumidoras da API OLOS para investigar uma leitura incerta.** O projeto mantém mecanismos de bloqueio e recuperação destinados a preservar a integridade; consulte [recuperação](backend/recuperacao.md).

> [!NOTE]
> Esta edição foi fundamentada nas **auditorias 01–07** (inventário, UI, rotas, ingestão, esquema, indicadores e configuração). Onde o comportamento não foi comprovado na execução em produção, ele está marcado como dependente de validação. Algumas telas contêm rótulos históricos que não correspondem exatamente à fonte ativa dos dados.

## Navegação completa

Veja [SUMMARY.md](SUMMARY.md) para o índice hierárquico, compatível com leitores Markdown e portais do tipo GitBook.
