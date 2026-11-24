# Guia de operação

[Início](../README.md) / Operação

Esta seção reúne procedimentos de observação e gestão de risco, sem instruções de forçar consumo remoto da OLOS.

| Necessidade | Referência |
|---|---|
| Entender containers e configurações | [Ambiente de produção](ambiente-producao.md) |
| Consultar estado e recursos | [Monitoramento seguro](monitoramento.md) |
| Publicar ou voltar uma release | [Deploy e rollback](deploy-rollback.md) |
| Proteger identidade, dados e logs | [Segurança](seguranca.md) |
| Investigar falhas sem comprometer leituras | [Troubleshooting](troubleshooting.md) |

**Princípio operacional:** confirmar o estado durável no banco e preservar evidências antes de executar ações que modifiquem scheduler, outbox, migrations ou conexões.
