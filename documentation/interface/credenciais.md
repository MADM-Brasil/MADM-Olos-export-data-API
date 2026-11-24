# Credenciais OLOS

[Manual do painel](README.md) / Credenciais OLOS

## Finalidade

Configurar e testar a identidade e a URL usadas para autenticação na API OLOS.

## Campos e ações

| Item | Função |
|---|---|
| URL da API | Origem HTTP(S) aprovada para o serviço OLOS |
| Usuário OLOS | Identidade de integração configurada |
| Senha OLOS | Campo secreto; deixar vazio preserva a senha existente conforme o contrato exibido |
| Salvar credenciais | `PUT /api/credentials` com controle de revisão |
| Testar conexão salva | `POST /api/credentials/test`: valida a autenticação sem consumir chamadas |

A interface informa se a configuração está completa, se a origem é **ambiente** ou **banco criptografado**, e se há senha configurada. O resultado do último teste exibe status, código, duração e horário.

## Orientações

1. Antes de editar, confirme a autorização e o endpoint correto.
2. Use **Testar conexão salva** para validar autenticação, sem consumir o endpoint de leitura.
3. Se editar, salve apenas uma vez; acompanhe o resultado e a auditoria.
4. Não compartilhe nem registre senhas, tokens ou chaves de criptografia.

> [!IMPORTANT]
> Sucesso no teste de autenticação **não comprova disponibilidade, autorização ou sucesso de uma chamada consumidora do ExportDataV3**.

## Segurança

No backend auditado, as credenciais podem ser armazenadas criptografadas e as alterações são auditadas. As URLs são submetidas a política de origens permitidas. Consulte [Segurança](../operacao/seguranca.md).
