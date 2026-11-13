# Continuidade com lacuna histórica explícita

Política restrita a `olos-production` e ao parent `2523225a-a46d-407a-ad5a-d1ff771e576e`. A migration local 013 cria apenas `olos_http.capture_continuity`, com autorização imutável, validade, revogação e vínculo por hash ao registro histórico completo e à configuração de persistência. Não modifica a leitura, autorização v2, evidências, contadores ou dados corporativos. Requer migrations 001/012; não requer migrations corporativas pendentes. Não é reaplicável: erros devem causar rollback, nunca ser ignorados.

A exceção permite somente novas leituras `current` e apenas quando o parent é a única leitura `reading`/`received`. Cada nova intenção guarda o UUID da autorização e `historical_gap=true`; o parent continua aparecendo no `status` original. A autorização é revalidada após reinício e em cada admissão. Ausência da tabela/autorização, expiração, revogação, mudança do parent, arquivo do parent ou configuração de spool indisponível impedem a exceção. A validade, a revogação e o hash completo do parent são conferidos também no INSERT da nova intenção. Uma mudança da evidência entre a avaliação inicial e esse INSERT impede a admissão. O advisory lock existente e a exclusão local de admissão impedem dois consumidores da mesma origem.

Uma nova leitura incerta bloqueia novamente a origem. Uma resposta nova `received` também bloqueia novas admissões enquanto coexistir com o parent; usar a recuperação local existente para processá-la, sem repetir a captura HTTP. Nenhuma verificação de `capture-reread`, cobertura ou resolução foi relaxada. Não há retomada automática de PAUSED/STOPPED por estes comandos.

## Decisão operacional e risco residual

Aceitar a lacuna de 39.150 posições candidatas não prova recuperação de registros nem segurança do cursor. O consentimento versão 2 permite ao operador priorizar novas capturas aceitando separadamente a lacuna histórica, o risco do cursor remoto desconhecido e o risco da operação original não comprovadamente reconciliada. Isso inclui a possibilidade de efeitos remotos anteriores ainda desconhecidos; o lock local impede dois consumidores locais da origem, mas não comprova o encerramento da operação remota original.

`cursorAssessment="UNKNOWN"` e `remoteOperationSettled=false` são obrigatórios. Neste contrato, `false` significa que não se atesta a conclusão/reconciliação remota. `acceptedUnknownCursorRisk=true` e `acceptedUnreconciledOperationRisk=true` autorizam novas chamadas sob esses riscos; não os eliminam. A referência e o SHA-256 identificam o documento da decisão operacional, não uma prova de cursor seguro. Ausência de qualquer aceite ou tentativa de declarar segurança/conclusão nesse consentimento é recusada. O parent permanece `reading`, com `RESPONSE_TOO_LARGE`, sem corpo e com recuperação incompleta.

Autorizações do formato anterior permanecem intactas no ledger, mas não satisfazem o novo contrato. Não há conversão, reaproveitamento automático ou alteração do consentimento antigo. Com o scheduler STOPPED, revogar a autorização antiga e emitir uma nova versão 2 com UUID próprio. O journal de cada nova captura aponta para esse consentimento imutável pelo UUID da autorização.

Se surgir nova evidência de insegurança, solicitar STOPPED no controle existente e revogar a autorização antes de qualquer retomada. Uma requisição já enviada não pode ser desfeita por revogação; preservar sua resposta/journal e reconciliar qualquer resultado ambíguo. O prazo limita novas admissões, não cancela uma requisição já admitida.

## Ativação — comandos não executados em produção

1. Manter scheduler STOPPED, aguardar liberação da origem e revisar o estado real. Confirmar `OLOS_SOURCE_KEY=olos-production`, migrations 012/013 já instaladas e volume persistente do spool operacional. Esta alteração não requer migration nova nem reaplicação da 013. Se a 013 não estiver instalada, a exceção permanece bloqueada; sua instalação fica fora deste procedimento e exige procedimento de migração separado. Nenhum comando abaixo altera automaticamente o estado do scheduler.
2. No ambiente administrativo configurado da aplicação, executar `node dist/main.js continuity-inspect`. Não chama OLOS; retorna o hash do parent elegível. Como os demais comandos Store, adquire o lock da origem.
3. Criar um arquivo JSON privado com campos abaixo. Preencher UUID novo, hash retornado, identidade do operador, referência real e SHA-256 do documento da decisão operacional, e prazo UTC explícito e futuro. O documento deve identificar esta origem/parent e os três riscos aceitos. Os valores abaixo são placeholders e não constituem autorização válida:

```json
{
  "version": 2,
  "authorizationId": "UUID-NOVO",
  "parentHash": "HASH-DO-CONTINUITY-INSPECT",
  "actor": "IDENTIDADE-DO-OPERADOR",
  "evidenceRef": "REFERENCIA-DA-DECISAO",
  "evidenceSha256": "SHA256-DA-DECISAO-OPERACIONAL",
  "expiresAt": "PRAZO-UTC-YYYY-MM-DDTHH:mm:ss.sssZ",
  "acceptedHistoricalGap": true,
  "remoteOperationSettled": false,
  "cursorAssessment": "UNKNOWN",
  "acceptedUnknownCursorRisk": true,
  "acceptedUnreconciledOperationRisk": true
}
```

4. Somente após essa revisão operacional, executar:

```sh
node dist/main.js continuity-authorize /caminho/privado/consentimento.json AUTHORIZE_CAPTURE_WITH_HISTORICAL_GAP
```

O comando registra a exceção; não faz captura nem liga o scheduler. Se perder a confirmação PostgreSQL, repetir o mesmo arquivo/UUID: a operação é idempotente. UUID com conteúdo diferente, revogado ou expirado é recusado. Não reutilizar UUID para renovar; revogar a autorização anterior e emitir outra com nova evidência/hash/prazo.

5. Conferir o registro no ledger local (consulta somente leitura abaixo), incluindo prazo, consentimento e ausência de revogação. Solicitar RUNNING pelo Admin existente somente após registrar a aceitação desses riscos e verificar `capture_with_historical_gap`, UUID da nova leitura e autorização no journal. Usar observação de metadados, nunca payloads/credenciais em logs. Confirmar a progressão de cada nova leitura e o enfileiramento habitual. O parent e a lacuna permanecem pendentes.

```sql
SELECT authorization_id, parent_id, parent_hash, approved_at, expires_at, revoked_at, consent
FROM olos_http.capture_continuity
WHERE source_key = 'olos-production'
  AND parent_id = '2523225a-a46d-407a-ad5a-d1ff771e576e'
ORDER BY approved_at DESC;
```

Revogação, com scheduler STOPPED e origem liberada:

```sh
node dist/main.js continuity-revoke UUID-DA-AUTORIZACAO
```

O ledger não aceita apagar registros, alterar consentimento ou reativar autorização revogada. Para rollback: manter STOPPED, aguardar liberação da origem, revogar a autorização e verificar `revoked_at`; depois reverter somente o código por procedimento de publicação separado. Preservar a tabela 013, journal, spool, checkpoints, outbox e todas as evidências históricas. Não remover a migration nem resolver o parent. A versão anterior não aceita consentimento v2: sem revogação, ela também bloqueará, mas poderá apresentar `CONTINUITY_CONSENT_INVALID`. Após revogar, o parent volta a causar o bloqueio normal de reconciliação. Uma captura já admitida não é desfeita pelo rollback e deve conservar sua evidência e recuperação local.

## Testes locais sem chamadas consumptivas

```sh
npm run build
npm test
OLOS_DIRECT_TEST_FILES='test/capture-continuity.integration.ts test/capture-spool.integration.ts test/store.integration.ts test/corporate-delivery.integration.ts test/corporate-recovery.integration.ts' bash scripts/test-corporate-delivery.sh
```

A integração usa PostgreSQL 16 descartável em rede Docker interna sem portas publicadas. O runner cria os schemas de teste com os SQL existentes somente nesses bancos descartáveis; não usa bancos/configuração do ambiente publicado. A suíte de continuidade injeta transporte em memória no `Worker`/`OlosApi` e usa `captureToDisk`, parser incremental, journal e persistência reais. As demais suítes usam servidores HTTP sintéticos locais. Nenhuma chama OLOS real.

A suíte de continuidade cobre os modos local e Corporate Delivery, aceites obrigatórios, formato antigo recusado, hash divergente, expiração/revogação bloqueando o scheduler, COMMIT incerto, concorrência, novas pendências reading/received, reinício, preservação integral do parent, transmissão pelo streaming existente, retomada de checkpoint sem replay e outbox congelada. Corporate Delivery fica com escrita desabilitada nessa suíte; as regressões de entrega estão nas suítes corporativas existentes. Resultados de execução devem ser registrados por rodada; a existência dos testes não equivale a validação no ambiente publicado.
