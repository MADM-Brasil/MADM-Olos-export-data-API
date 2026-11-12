# Continuidade com lacuna histórica explícita

Política restrita a `olos-production` e ao parent `2523225a-a46d-407a-ad5a-d1ff771e576e`. A migration local 013 cria apenas `olos_http.capture_continuity`, com autorização imutável, validade, revogação e vínculo por hash ao registro histórico completo e à configuração de persistência. Não modifica a leitura, autorização v2, evidências, contadores ou dados corporativos. Requer migrations 001/012; não requer migrations corporativas pendentes. Não é reaplicável: erros devem causar rollback, nunca ser ignorados.

A exceção permite somente novas leituras `current` e apenas quando o parent é a única leitura `reading`/`received`. Cada nova intenção guarda o UUID da autorização e `historical_gap=true`; o parent continua aparecendo no `status` original. A autorização é revalidada após reinício e em cada admissão. Ausência da tabela/autorização, expiração, revogação, mudança do parent, arquivo do parent ou configuração de spool indisponível impedem a exceção. A validade, a revogação e o hash completo do parent são conferidos também no INSERT da nova intenção. Uma mudança da evidência entre a avaliação inicial e esse INSERT impede a admissão. O advisory lock existente e a exclusão local de admissão impedem dois consumidores da mesma origem.

Uma nova leitura incerta bloqueia novamente a origem. Uma resposta nova `received` também bloqueia novas admissões enquanto coexistir com o parent; usar a recuperação local existente para processá-la, sem repetir a captura HTTP. Nenhuma verificação de `capture-reread`, cobertura ou resolução foi relaxada. Não há retomada automática de PAUSED/STOPPED por estes comandos.

## Decisão operacional e risco residual

Aceitar a lacuna de 39.150 posições candidatas não prova recuperação de registros nem segurança do cursor. Não autorizar se a requisição original ainda puder estar ativa, se houver evidência de cursor inseguro ou sobreposição não controlada conhecida. Nesses casos, manter STOPPED e obter avaliação/evidência da OLOS. O software não tem uma fonte remota capaz de provar essas condições: exige declaração explícita do operador, referência e SHA-256 da evidência revisada. Os campos são atestações administrativas, não conclusões automáticas sobre a API.

Se surgir nova evidência de insegurança, solicitar STOPPED no controle existente e revogar a autorização antes de qualquer retomada. Uma requisição já enviada não pode ser desfeita por revogação; preservar sua resposta/journal e reconciliar qualquer resultado ambíguo. O prazo limita novas admissões, não cancela uma requisição já admitida.

## Ativação — comandos não executados em produção

1. Manter scheduler STOPPED, aguardar liberação da origem e revisar o estado real. Aplicar **somente** `migrations/013_capture_continuity.sql` no PostgreSQL local da aplicação, por procedimento de migração autorizado, com erro causando ROLLBACK. O spool 012 e o volume persistente devem estar operacionais. A implementação não aplica migrações automaticamente.
2. No ambiente administrativo configurado da aplicação, executar `node dist/main.js continuity-inspect`. Não chama OLOS; retorna o hash do parent elegível. Como os demais comandos Store, adquire o lock da origem.
3. Criar um arquivo JSON privado com campos abaixo. Preencher UUID novo, hash retornado, identidade do operador, referência real e SHA-256 do documento de evidência, e prazo UTC explícito. Os valores abaixo são placeholders e não constituem autorização válida:

```json
{
  "authorizationId": "UUID-NOVO",
  "parentHash": "HASH-DO-CONTINUITY-INSPECT",
  "actor": "IDENTIDADE-DO-OPERADOR",
  "evidenceRef": "REFERENCIA-DA-DECISAO",
  "evidenceSha256": "SHA256-DA-EVIDENCIA-REVISADA",
  "expiresAt": "PRAZO-UTC-YYYY-MM-DDTHH:mm:ss.sssZ",
  "acceptedHistoricalGap": true,
  "remoteOperationSettled": true,
  "cursorAssessment": "NO_KNOWN_UNSAFE_CURSOR_OR_UNCONTROLLED_OVERLAP"
}
```

4. Somente após essa revisão operacional, executar:

```sh
node dist/main.js continuity-authorize /caminho/privado/consentimento.json AUTHORIZE_CAPTURE_WITH_HISTORICAL_GAP
```

O comando registra a exceção; não faz captura nem liga o scheduler. Se perder a confirmação PostgreSQL, repetir o mesmo arquivo/UUID: a operação é idempotente. UUID com conteúdo diferente, revogado ou expirado é recusado. Não reutilizar UUID para renovar; revogar a autorização anterior e emitir outra com nova evidência/hash/prazo.

5. Solicitar RUNNING pelo Admin existente somente após a avaliação do cursor e verificar `capture_with_historical_gap`, UUID da nova leitura e autorização no journal. Usar observação de metadados, nunca payloads/credenciais em logs. Confirmar a progressão de cada nova leitura e o enfileiramento habitual. O parent e a lacuna permanecem pendentes.

Revogação, com scheduler STOPPED e origem liberada:

```sh
node dist/main.js continuity-revoke UUID-DA-AUTORIZACAO
```

O ledger não aceita apagar registros, alterar consentimento ou reativar autorização revogada. Reverter o código preservando a tabela e o journal restaura o bloqueio anterior; não remover evidências nem resolver o parent para viabilizar rollback.

## Testes locais sem chamadas consumptivas

```sh
npm run build
node --import tsx --test test/capture-continuity.test.ts test/historical-parent.test.ts test/scheduler.test.ts test/mapping.test.ts test/read-recovery.test.ts test/capture-json-reader.test.ts test/corporate-campaign.test.ts
OLOS_DIRECT_TEST_FILES=test/capture-continuity.integration.ts bash scripts/test-corporate-delivery.sh
```

A integração usa PostgreSQL 16 descartável e corpos sintéticos gravados diretamente no spool; não chama endpoints de captura, nem mesmo um servidor OLOS simulado. Cobre ausência de autorização, decisão insegura, hash divergente, expiração, COMMIT incerto, concorrência, novas pendências reading/received, reinício, abertura do Admin sem HTTP, preservação integral do parent e revogação.

Resultados locais: build aprovado; 63/63 testes unitários selecionados; 10/10 testes PostgreSQL (incluindo agregadora); `git diff --check` aprovado. O typecheck global mantém os mesmos 17 diagnósticos do HEAD, comparados por arquivo, linha, código e mensagem, sem diagnósticos novos. A suíte completa com transporte HTTP não foi executada nesta alteração, para manter a validação sem chamadas consumptivas.
