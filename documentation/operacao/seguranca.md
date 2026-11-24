# Segurança, acesso e proteção de dados

[Operação](README.md) / Segurança

## Sessões administrativas

O backend auditado implementa:

- Login vinculado a identidade OLOS e lista autorizada.
- Cookie de sessão `HttpOnly`, `SameSite=Strict` e `Secure` quando HTTPS.
- Expiração de sessão em **8 horas**.
- Token CSRF para operações não GET e validação da origem.
- Cabeçalhos de segurança: CSP restritiva, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e HSTS quando HTTPS.
- Auditoria administrativa persistente.

## Dados sensíveis

`reads.response_body` conserva o corpo da resposta e `corporate_outbox.payload` conserva dados que podem ser pessoais. Por isso:

1. Não consultar payload completo para fins de documentação.
2. Não incluir URLs de conexão com senha, tokens, cookies ou chaves em capturas de terminal.
3. Evitar exemplos reais de CPF, telefone e e-mail; usar dados sintéticos.
4. Restringir acesso a banco local, backups e logs conforme perfis autorizados.
5. Não distribuir documentos operacionais com detalhes de infraestrutura desnecessários em repositórios públicos.

## Limites da evidência

Os controles acima foram identificados **no código**; não equivalem a auditoria de pentest, verificação completa de TLS ou certificação de segurança. O escopo de usuários autorizados, a configuração do proxy e a política de backups não foram auditados integralmente.
