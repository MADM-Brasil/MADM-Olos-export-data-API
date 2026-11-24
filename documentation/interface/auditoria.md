# Auditoria administrativa

[Manual do painel](README.md) / Auditoria

## Onde encontrar

Selecione **Auditoria** no menu lateral. O painel abre **Status operacional**, rola até **Auditoria administrativa** e foca a seção. Portanto, não é uma sétima página independente.

## Dados exibidos

| Coluna | Conteúdo |
|---|---|
| Horário | Momento da ação |
| Administrador | Identidade registrada como responsável |
| Ação | Evento administrativo auditado |

Os registros são consultados pelo endpoint `GET /api/audit` e persistidos em `olos_http.admin_audit` com `actor`, `action`, `occurred_at` e `metadata`.

## O que consultar

Use a auditoria para reconstruir a sequência de alterações de intervalo, solicitações de estado, autenticação e ajustes de credenciais, conforme eventos efetivamente gravados. Ela **não substitui** as evidências técnicas de ingestão e entrega; combine-a com os estados de `reads`, scheduler e outbox em investigações.

**Veja também:** [Segurança](../operacao/seguranca.md) e [Status operacional](status-operacional.md).
