# Recuperação controlada de lacunas históricas v1

Base conferida: `feature/exportdata-history`, `39f810b81024ef4740a6e048cd759d6fa03d07b2`.
A extensão reaproveita `capture-reread`, `recover-local`, `olos_http.reads`, o
transporte limitado e a persistência/deduplicação corporativa existentes. Não
inicia outro consumidor, scheduler ou mecanismo de entrega.

## Evidência e escopo

O responsável informou 90 intervalos e 575.268 registros no log OLOS de
`DateExport=2026-10-28`, com estas diferenças:

| Intervalo | Informados pela OLOS | Existentes informados | Diferença |
|---|---:|---:|---:|
| 46671511–46800030 | 128.520 | 0 | 128.520 |
| 46800031–46839630 | 39.600 | 2.963 | 36.637 |
| 46839631–46856400 | 16.770 | 16.763 | 7 |
| Total | 184.890 | 19.726 | 165.164 |

São evidências fornecidas, não consultas realizadas nesta implementação. Os outros
87 intervalos não foram autorizados. Igualdade de contagens não comprova igualdade
dos conjuntos nem cobertura completa de setembro/outubro. DateExport não é StartDate.

O preparador aceita somente subintervalos desses três ranges e dessa data, sem
sobreposição. Divide cada range em blocos de amplitude inclusiva máxima de 10.000
IDs; os três completos produzem 19 blocos. Limites: 20 ranges de entrada e 40 blocos
por manifesto. Blocos sem lacunas são omitidos antes da autorização. Cada captura
executa **um único bloco autorizado**, sem laço ilimitado ou retry do POST.

O inventário enumera todos os IDs candidatos por bloco e compara com `records`,
inclusive buracos interiores. O manifesto guarda a lista exata de ausentes e os
snapshots dos existentes. O SHA-256 do log vincula a revisão humana; o programa
não interpreta nem autentica o formato externo desse log. Todos os ausentes
aprovados precisam aparecer na resposta salva antes da persistência. Ausência
local, contagem ou diferença entre limites não prova, sozinha, retorno da OLOS.

## Migration e journals locais

`migrations/007_history_gaps.sql` é um pré-requisito **exclusivamente local**,
dependente das estruturas anteriores, inclusive 003 e 005. Recusa database `madm`
e não é executada pelo CLI. Aplicação operacional exige janela/autorização próprias.
Nenhuma coluna, tabela ou trigger corporativo é alterado.

- `history_gap_plans`: manifesto imutável, UUID/hash, ranges/ausentes/existentes,
  snapshot integral do pai, origem/destino/binding/schema, hashes de evidência e
  referências, fuso de origem, hash da URL/conta/clientId/TLS (sem senhas), limite
  de resposta e timeout HTTP. Captura e recuperação exigem a mesma configuração.
- `history_gap_children`: vínculo imutável manifesto/bloco/read_id, único por bloco.
  Intenção em `reads` e vínculo são confirmados juntos **antes do POST**.
- `history_gap_responses`: hash e tamanho do corpo, confirmados na mesma transação
  que salva o texto original em `reads.response_body`, estado `received`.
- `history_gap_members`: proveniência de cada ausente persistido, com read_id,
  source_id/target_id/source_hash/payload_hash. Gravada na mesma transação da
  outbox e do checkpoint de cada lote local.

UPDATE/DELETE/TRUNCATE dos journals são rejeitados. Manifestos podem conter dados
pessoais dos registros existentes: restringir acesso, backup e retenção. O arquivo
exportado usa `0600` e não sobrescreve outro. Logs/status mostram apenas controle,
contagens e erros. Um administrador que altera/desativa triggers está fora da
garantia de imutabilidade do papel aplicativo.

## Proteções e persistência

Exige Admin inativo, scheduler desabilitado/STOPPED, Delivery pronto e pausado,
`OLOS_CORPORATE_WRITE_ENABLED=false`. Preserva locks de origem/Corporate Sync,
Delivery, Admin e histórico. Planos de entrega/identidade abertos, COMMIT incerto,
outra leitura pendente ou mudança de evidência/configuração bloqueiam a operação.

O pai `132eb226-f4e4-419d-b79f-21dd0e6e64c1` permanece integralmente em
`reading/RESPONSE_TOO_LARGE`, processados 0, sem resposta/resolução. Nenhuma função
do protocolo atualiza o pai. `resolve` recusa pais/filhos vinculados aos journals.

Autenticação e catálogo ocorrem após verificar autorização; a intenção vem antes
do POST e há nova verificação depois da obtenção do token, imediatamente antes
de enviar. O POST `re-read-data` não é repetido em 401/429, timeout, conexão perdida
ou resposta grande. Captura não normaliza nem escreve na MADM.
Se controles mudarem depois do POST, o corpo retornado ainda é salvo no filho
autorizado; a normalização permanece bloqueada até restaurar as pré-condições.
Não se descarta uma resposta recebida apenas por mudança de controle operacional.

O novo `recover-local` processa somente o filho autorizado e aplica a exceção ao
baseline apenas nesse escopo. **Não faz HTTP**: recebe referências previamente
auditadas em arquivo privado, cujo SHA-256 já integra o manifesto. Formato exato:

```json
{"users":[["7","Nome aprovado"]],"campaigns":[["8","Campanha"]],"dispositions":[["9","Tabulação"]]}
```

IDs e nomes são strings. Duplicações de referência e campos extras, inclusive
Password, são rejeitados. Não inventar nomes. Referências ausentes permanecem
ausentes; a obtenção externa de referências exige autorização separada. O comando
antigo sem parâmetros continua bloqueado pelo pai e mantém seu comportamento
anterior fora deste protocolo.

Antes de persistir, valida toda a resposta quanto a faixa, ausentes e duplicações
divergentes. Origem + AttemptsRawDataID deduplicam; source_hash diferente bloqueia.
Linhas existentes, payloads e recibos não são reescritos. Novos registros usam
o ID original e v1. Todas as tentativas recuperadas ficam locais, inclusive sem
operador. Perda de ACK local é tratada pelo checkpoint transacional, sem nova captura.

Somente membros de filhos `done`, com manifesto/corpo/proveniência íntegros,
podem passar pela exceção temporal da drenagem. Essa prova integra o novo manifesto
corporativo. Registros posteriores sem proveniência continuam excluídos. AgentId
válido e nome preenchido continuam obrigatórios. Planos anteriores não são
reinterpretados. Esses novos registros já possuem IDs originais e não precisam
da migração de IDs legados.

## Homologação de um único intervalo pequeno

**Procedimento futuro, não executado nesta implementação.** Homologar primeiro a
captura/persistência de até 100 IDs, sem acoplar entrega corporativa.

1. Após autorização operacional, conferir pré-requisitos e instalação local da
   migration 007. Manter processos parados. Revisar retenção, atribuição do log à
   conta/origem e referências. Conferir os hashes dos arquivos privados:

   ```bash
   sha256sum /caminho/privado/log-read-2026-10-28.json /caminho/privado/references.json
   ```

2. Preparar `gap-input.json`, substituindo os hashes. O intervalo abaixo é candidato
   dentro da faixa informada como ausente; sua situação local será reconsultada:

   ```json
   {
     "evidenceSha256": "SHA256_REAL_DO_LOG_REVISADO",
     "referencesSha256": "SHA256_REAL_DO_ARQUIVO_REFERENCES",
     "ranges": [{"date":"2026-10-28","start":"46671511","end":"46671610"}]
   }
   ```

   ```bash
   OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js capture-reread \
     --prepare /caminho/privado/gap-input.json --output /caminho/privado/gap-plan.json
   sha256sum /caminho/privado/gap-plan.json
   ```

   A preparação grava o journal local; não chama OLOS/MADM. Revisar os IDs ausentes,
   bloco e limites. O hash canônico do manifesto retornado pelo CLI é distinto do
   checksum do arquivo formatado. Se o arquivo não puder ser gravado após o COMMIT,
   recuperar a evidência durável por leitura local autorizada; não apagar o plano.

3. Autorizar somente o bloco 1 pelo UUID/hash canônico revisado:

   ```bash
   gap_id='UUID_REVISADO'
   gap_hash='HASH_CANONICO_REVISADO'
   OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js capture-reread \
     --plan-id "$gap_id" --plan-hash "$gap_hash" --block 1 \
     --confirm "AUTHORIZE_HISTORY_GAP_CAPTURE:$gap_id:$gap_hash:1"
   OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js capture-reread --status "$gap_id"
   ```

   Esperado: filho `received`, corpo salvo, nenhuma chamada normalizada nessa
   etapa, pai intacto. Revisar evidências privadas antes de persistir.

4. Autorizar a persistência local do mesmo bloco:

   ```bash
   OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js recover-local \
     --plan-id "$gap_id" --plan-hash "$gap_hash" --block 1 \
     --references /caminho/privado/references.json \
     --confirm "AUTHORIZE_HISTORY_GAP_PERSIST:$gap_id:$gap_hash:1"
   OLOS_CORPORATE_WRITE_ENABLED=false node dist/main.js capture-reread --status "$gap_id"
   ```

   Conferir `done`, prova de todos os ausentes, duplicados/recibos preservados,
   novos IDs originais, hashes/proveniência e snapshot integral do pai. Separar
   quantidade recuperada da quantidade elegível por operador.

5. Parar para revisão antes de aprovar outro bloco. Entrega continua separada pelo
   [procedimento de drenagem](backlog-drain-v1.md), começando com 100 elegíveis.
   Recuperar 100 tentativas não garante 100 operadores; não completar nomes nem
   relaxar limites para preencher um lote.

## Falhas, reinício e rollback

- Antes do COMMIT da intenção, nenhum POST consumidor é autorizado. Consultar
  status para distinguir ausência do filho de confirmação local incerta.
- Filho `reading`: resultado remoto incerto. Reexecutar captura não repete POST;
  outros blocos/sobreposições ficam bloqueados. Não dividir automaticamente uma
  faixa já tentada após resposta grande. Exige investigação/evidência externa;
  esta versão não oferece desbloqueio automático para bytes não armazenados.
- Filho `received`: repetir somente a recuperação local autorizada. ACK perdido
  de armazenamento não provoca recaptura. Corpo incompleto/divergente fica salvo
  e bloqueado, sem fingir conclusão.
- COMMIT local incerto: outbox, proveniência e checkpoint são atômicos por lote.
  Reabrir o mesmo manifesto/bloco e usar `recover-local`. Progresso já confirmado
  não é reaplicado. Não existe COMMIT corporativo nesse comando.
- Filho `done`: captura retorna sem HTTP; persistência verifica a evidência e
  retorna. Mudanças posteriores nas evidências podem exigir revisão, sem rehash.

Não usar `reset-read-data`, `resolve`, `read-data-previous-days`, redução global
do baseline ou SQL de desbloqueio. Não apagar outbox, chamadas ou journals.
Rollback de binário exige processos parados e preservação da migration/evidência;
versões anteriores não entendem o protocolo. Não desfazer entregas confirmadas.

## Validação

Testes em PostgreSQL descartável/OLOS simulada cobrem lacunas totais/interiores,
deduplicação, referências, limites, intenção, resposta grande, falhas antes/depois
de HTTP/COMMIT, reinício, CLI offline, preservação do pai/confirmados, operadores
e drenagem limitada. Não comprovam retenção, saúde ou contagens da produção.
Nenhuma VPS/MADM/OLOS real ou migration operacional foi acessada/executada.

Resultados locais em Node 24/PostgreSQL 16 descartável: typecheck e build aprovados;
109/109 unitários, 156/156 testes no runner corporativo (inclui Store/Admin) e
39/39 Corporate Sync, sem skips. `git diff --check` aprovado. A CLI foi exercitada
com HTTP simulado; preparação e recuperação local tiveram zero requisições HTTP.
