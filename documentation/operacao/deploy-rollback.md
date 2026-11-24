# Deploy e rollback

[Operação](README.md) / Publicação

## Objetivo

Publicar alterações preservando um único consumidor da origem OLOS, os dados duráveis e um caminho conhecido de retorno.

## Checklist de pré-publicação

1. Identificar versão em execução, digest da imagem e imagens de rollback disponíveis.
2. Executar build, testes de unidade e integrações relevantes em ambiente **descartável**, sem acesso ao consumo OLOS de produção.
3. Verificar compatibilidade de migrations e de campos usados pelo frontend/backend.
4. Consultar **somente por leitura** as leituras `reading`/`received` não resolvidas; registrar qualquer exceção histórica autorizada.
5. Validar Compose, portas, recursos e variáveis não secretas.
6. Definir plano de interrupção graciosa e rollback com responsáveis autorizados.

## Durante publicação

A revisão da release `enqueue-bulk-v1` foi aplicada recriando **somente o Admin** com Docker Compose, mantendo o banco PostgreSQL e usando `stop_grace_period: 120s`. Não reproduza comandos de deploy sem validar os arquivos do ambiente vigente e a ausência de leitura incerta.

## Pós-publicação

Confirmar imagem, `running`, contagem de reinícios, `desired_state` / `runtime_state`, controle da entrega, eventos e erros. Um `scheduler_started` não garante sozinho que o scheduler esteja efetivamente `RUNNING`.

## Rollback

O retorno exige inspeção do estado atual e avaliação de compatibilidade de esquema/alterações. **Não executar rollback durante uma captura remota incerta.** Antes de voltar, confirmar que a versão anterior existe e que o banco permanece compatível.

> [!IMPORTANT]
> Esta página é um **procedimento de decisão**, não um script de deploy autoexecutável. Publicações devem seguir mudança autorizada e janela operacional apropriada.
