# Evidências, rastreabilidade e pontos a validar

[Início](../README.md) / Referência

## Fontes desta edição

A redação foi baseada em **sete auditorias compartilhadas em 24/11/2026**, com saídas de comandos `find`, `grep`, `sed`, leitura de migrations, versões da imagem Docker e variáveis selecionadas. Foram inspecionados trechos de:

- `admin/public/index.html`, `app.js`, `dashboard.js`, `corporate-report.js`, `ui.js`;
- `src/admin/server.ts`, `main.ts`, `repository.ts`, `reports.ts`, `corporate-daily.ts`, `corporate-receipts.ts`, `report-snapshot.ts`, `report-updater.ts`;
- `src/worker.ts`, `src/store.ts`, `src/api.ts`, `src/auth.ts`, `src/scheduler.ts`;
- `src/corporate-delivery/campaign-policy.ts`, `operator-eligibility.ts`, `delivery.ts` (métodos identificados);
- `migrations/*.sql` e `admin/migrations/*.sql`.

## Níveis de evidência

**Confirmado na configuração:** versão da imagem, flags selecionadas e presença dos containers.
**Confirmado no código:** rotas, campos, regras visíveis, migrations e contratos principais.
**Observado anteriormente em operação:** scheduler `RUNNING / RUNNING`, ciclos `batch_completed` e confirmação corporativa.
**Pendente de validação:** comportamento de todas as ramificações de erro, integração completa de cada endpoint OLOS, acesso e autorização por perfil, alterações futuras das migrations e verificação visual com screenshots do painel final.

## Divergências relevantes entre layout e fonte

1. O frontend ativo apresenta **Chamadas no MADM hoje** consultando `/api/corporate/daily`, enquanto o endpoint local `/api/today` tem semântica de primeira persistência.
2. Certos rótulos de tabelas e de gráficos parecem originados do contrato de snapshots locais, mas a consulta corporativa atual pode não fornecer essas dimensões. A UI exibe `—` em campos sem dado.
3. A página de **Auditoria** é atalho para **Status operacional**, não página exclusiva.
4. O atualizador local de snapshots estava `false`, enquanto escrita corporativa estava `true`.

## Regras para revisão futura

Ao mudar versão, atualizar **data da evidência**, **imagem efetiva**, **flags**, **screenshots**, **contratos de API**, **migrations**, **fontes de indicadores** e **políticas de entrega**. Não copiar valores da produção antiga como se fossem atuais.
