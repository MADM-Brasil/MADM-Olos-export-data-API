# Recuperação, consistência e leituras incertas

[Início](../README.md) / Backend

## Por que existe bloqueio

Uma leitura da API OLOS pode ser consumidora. Se o processo for interrompido depois da invocação e antes da persistência da resposta, o sistema **não pode presumir** que a origem não entregou os dados. Por isso, uma leitura `reading` sem resolução pode impedir novas capturas e emitir `RECOVERY_REQUIRED`.

## Estados relevantes

- `reading`: intenção persistida; resposta ainda não está duravelmente marcada como recebida.
- `received`: resposta durável, com processamento local possivelmente parcial.
- `done`: processamento concluído conforme contadores persistidos.
- `resolved`: estado encerrado com justificativa/evidência (`resolution`).

## Recuperação local segura

Para respostas `received`, o `Store.drain()` pode retomar batches a partir de `processed_count` sem solicitar uma nova resposta à origem. Para uma chamada `reading` incerta, a recuperação requer evidências externas e autorizações de faixa; **não** basta atualizar manualmente o estado no banco.

## Exceção histórica da produção

Foi identificada uma autorização de continuidade estritamente delimitada a **duas leituras históricas** de 12/11/2026 em `olos-production`, guardada por uma variável de confirmação explícita e verificações de identidade/manifesto. Trata-se de exceção de compatibilidade, **não de permissão geral para ignorar `reading`**.

## O que nunca fazer como primeira resposta

- Reexecutar `read-data-current-day` manualmente.
- Limpar linhas `reading` / `received` ou apagar `response_body`.
- Dar `UPDATE` direto em recibos, hashes ou cursores.
- Subir outro processo consumidor com o mesmo `source_key`.
- Reiniciar em ciclo sem registrar evidências do erro.

## Roteiro de suporte

1. Confirme Admin, scheduler, erros e leituras pendentes **somente por leitura**.
2. Identifique `read_id`, estado, horários, progresso e se há resposta persistida, **sem imprimir payload**.
3. Determine se o problema é captura remota incerta, processamento local ou entrega corporativa.
4. Preserve logs e registros para análise por responsáveis autorizados.
5. Aplique apenas o runbook de recuperação correspondente e validado para o incidente.

**Veja:** [Troubleshooting](../operacao/troubleshooting.md).
