# Visão geral e escopo

[Início](../README.md) / Introdução

## Finalidade

Centralizar, rastrear e administrar a ingestão da **OLOS ExportDataV3** e o encaminhamento dos registros elegíveis à base corporativa MADM. O sistema separa três fatos: **a resposta da origem foi recebida**, **a persistência local foi concluída** e **a entrega corporativa foi confirmada**.

## Processos atendidos

1. Agendamento de ciclos de leitura.
2. Autenticação e consumo controlado da API OLOS.
3. Registro durável da intenção e da resposta de cada leitura.
4. Mapeamento, validação e persistência por lotes.
5. Classificação e enfileiramento da entrega corporativa.
6. Escrita e confirmação controladas no destino.
7. Monitoramento, auditoria e relatórios para usuários autorizados.

## Limites de responsabilidade

| Responsabilidade | Dentro do projeto? |
|---|---|
| Originar chamadas telefônicas | Não |
| Disponibilizar registros na API ExportDataV3 | OLOS (sistema externo) |
| Consultar dados disponibilizados, com controle de captura | Sim |
| Garantir que uma ligação já foi disponibilizada pela OLOS | Não, depende da origem |
| Manter integridade da captura e da fila local | Sim, conforme contratos implementados |
| Registrar confirmação local da escrita corporativa | Sim |
| Provar conectividade corporativa somente pelo indicador `ready` | Não |

## Público-alvo

**Operações:** acompanhamento diário e leitura de indicadores. **Administradores:** credenciais, scheduler e ações operacionais. **Suporte técnico:** investigação segura de erros. **Engenharia:** manutenção de API, banco, deploy e recuperação.

## Ambiente auditado

Em 24/11/2026, a imagem observada era `olos-madm-admin-optimized:20261119-enqueue-bulk-v1` com `OLOS_SOURCE_KEY=olos-production`. A configuração detalhada fica em [ambiente de produção](../operacao/ambiente-producao.md).
