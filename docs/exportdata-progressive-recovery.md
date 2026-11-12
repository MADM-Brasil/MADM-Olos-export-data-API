# ExportDataV3 — captura progressiva v2

Somente procedimento: nenhuma operação na VPS ou API real foi executada nesta implementação. Não há migração, scheduler ou serviço novo.

## Alteração mínima e fronteira de segurança

O manifesto **v1 permanece compatível**, inclusive seus hashes e exigência de IDs conhecidos. O v2 autoriza somente captura progressiva, com o mesmo journal, lock de origem, intenção durável, transporte one-shot e processamento transacional existentes. Não exige declarações sem evidência de `remoteOperationComplete`, `rereadCursorSafe` ou `exactIdsConfirmed`. Esses campos não pertencem ao v2 e são rejeitados se adicionados; `expectedIds` também não pertence aos seus blocos.

O log oficial fundamenta DateExport, DateRead, limites e Quantity. A referência ao Manual ExportDataV3 v1.1.0 registra a justificativa administrativa para usar `re-read-data` em dados já consumidos, conforme a descrição fornecida pelo solicitante. O manual não estava disponível no clone nem foi encontrado em fonte pública oficial nesta implementação; não se afirma uma garantia adicional de cursor a partir dessa referência. A aplicação verifica hashes e correspondência do log, mas não autentica externamente um arquivo entregue pelo operador.

O pai permanece `reading`, com corpo NULL, erro e checkpoint originais. No v2:

- `done` no filho significa somente **corpo HTTP recebido e processado**, nunca cobertura integral de sua faixa.
- Uma resposta `[]` fica preservada e processada com zero registros. Isso permite observar os demais blocos; não comprova ausência de IDs nem libera o pai. No v1, uma resposta vazia para IDs esperados continua recusada.
- ID fora da faixa, duplicata divergente, conflito com persistência existente ou exclusão por baseline bloqueiam o processamento antes do primeiro lote. Duplicatas idênticas não aumentam cobertura.
- Erro HTTP, timeout, resposta grande ou resultado incerto deixam o filho pendente. Não há retry nem avanço automático para outro bloco. Corpo recebido e checkpoint confirmado podem ser retomados localmente, sem outra chamada de dados.
- A verificação enumera **posições candidatas**, dentro dos limites oficiais, e compara cada ID realmente observado com os hashes e a persistência local. Não usa o maior ID local nem considera uma posição não observada um registro comprovadamente inexistente.
- `coverage_complete=true` requer todas as posições observadas individualmente, hashes/persistência válidos, contagem distinta compatível com Quantity e todos os corpos processados. Coincidência de extremos ou contagem de linhas não basta. Se Quantity for menor que a largura da faixa, o v2 não transforma os buracos em ausência comprovada.
- Mesmo com cobertura observada integral, **`complete=false`, `resolution_allowed=false` e `reconciliation_required=true`**. `coverage_digest` é somente uma prova local de cobertura; não é aceito por `resolve`. Este patch não implementa encerramento do pai v2. A reconciliação da operação/cursor permanece separada; não substituir o plano por um v1 com declarações inventadas.
- Outbox, admissões e marcadores são somente consultados pela auditoria. Enfileiramento continua no caminho existente; não há novas regras de entrega, recibos ou quarentena.

## Procedimento da leitura de 12/11/2026

Manter o scheduler **STOPPED**, sem consumidores externos concorrentes. Usar a imagem candidata somente após aprovação de publicação, Node 24 e o ambiente privado correto da origem, com credenciais OLOS, fuso e baseline existentes. Não imprimir credenciais. Os comandos abaixo pressupõem esse ambiente já disponível na raiz da aplicação; um `--env-file` não sobrepõe variáveis preexistentes.

```bash
export RECOVERY_MAX_RESPONSE_BYTES=2097152
parent='2523225a-a46d-407a-ad5a-d1ff771e576e'
node dist/main.js status
umask 077
recovery_dir="$(mktemp -d /tmp/olos-progressive.XXXXXX)"
```

Confirmar o UUID, `reading`, RESPONSE_TOO_LARGE e processed=0. Guardar o `started_at` exibido. Sob autorização da consulta do log, obter o arquivo oficial sem imprimi-lo:

```bash
node dist/main.js log-read 2026-11-12 "$recovery_dir/official-log.json"
```

A evidência deve pertencer à mesma conta/instância/tabela e à operação original. Conferir privadamente a entrada de limites **51698102–51737251**, Quantity **39150**, data **2026-11-12**, e seu **DateRead exato**. A igualdade aritmética `51737251 - 51698102 + 1 = 39150` define somente o domínio candidato; não é prova de IDs recuperados.

Gerar o manifesto abaixo, preenchendo os dois timestamps com os valores reais indicados. O script cria **392 blocos de até 100 posições**, sem inventar uma lista de IDs existentes. O último bloco é 51737202–51737251.

```bash
node --input-type=module - "$recovery_dir" \
  'STARTED_AT_EXATO_DO_STATUS' 'DATEREAD_EXATO_DO_LOG_OFICIAL' <<'NODE'
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {config} from './dist/config.js';
const [dir,parentStartedAt,dateRead]=process.argv.slice(2),cfg=config();
const evidence=await readFile(`${dir}/official-log.json`);
const ranges=[];
for(let start=51698102n;start<=51737251n;start+=100n){
  const end=start+99n>51737251n?51737251n:start+99n;
  ranges.push({start:String(start),end:String(end)});
}
const manifest={version:2,mode:'progressive',documentationRef:'ExportDataV3-v1.1.0/re-read-data',
  sourceKey:cfg.sourceKey,targetTable:`"${cfg.schema}"."${cfg.table}"`,
  parentId:'2523225a-a46d-407a-ad5a-d1ff771e576e',parentStartedAt,date:'2026-11-12',
  evidenceRef:'OLOS-LOG-2026-11-12-51698102-51737251',
  evidenceSha256:createHash('sha256').update(evidence).digest('hex'),
  operation:{start:'51698102',end:'51737251',quantity:'39150',dateRead},ranges};
await writeFile(`${dir}/manifest.json`,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
NODE
manifest_sha="$(sha256sum "$recovery_dir/manifest.json" | cut -d ' ' -f 1)"
OLOS_REREAD_CONFIRMATION=AUTHORIZE_EXPORTDATA_REREAD_RECOVERY \
  node dist/main.js recovery-authorize \
  "$recovery_dir/manifest.json" "$recovery_dir/official-log.json" "$manifest_sha"
```

Guardar o `authorization_hash` retornado; ele não é necessariamente o hash do arquivo. Se já houver outra aprovação, a aplicação recusa sobrescrevê-la. Não apagar/editar metadados no banco para contornar essa recusa. Preservar manifesto, log e registros operacionais em armazenamento privado durável; `/tmp` do Dokploy é efêmero. O manifesto v2 conserva os limites existentes de 2.000 blocos e 200.000 posições candidatas.

Executar **um bloco por vez**, começando pelo exemplo real abaixo. Somente avançar ao próximo bloco aprovado após sucesso da captura e do processamento. Não automatizar retry de um comando que falhou.

```bash
authorization_hash='HASH_RETORNADO_PELA_APROVACAO'
node dist/main.js capture-reread "$parent" 2026-11-12 51698102 51698201 \
  --authorization "$authorization_hash"
node dist/main.js recover-local
node dist/main.js status
```

`status` deve deixar apenas o pai pendente. O próximo bloco começa em 51698202 e termina em 51698301, seguindo o manifesto. Registrar o bloco e UUID do filho. Reexecução de bloco já tentado é recusada; não é uma ordem para repetir a requisição. `recover-local` pode consultar referências estáticas OLOS, conforme o comportamento existente, mas não relê AttemptsRawData.

**Falha/reinício:** filho `received`: retomar somente recover-local. Filho `reading` sem corpo: interromper todas as capturas dessa origem e reconciliar o resultado externo. Falha em um lote não avança seu checkpoint; lotes anteriores confirmados permanecem válidos. Não resolver filho, trocar UUID, aumentar limite ou partir para outro bloco após erro ambíguo.

## Auditar e tratar posições não observadas

Gerar um arquivo novo a cada auditoria; o comando não sobrescreve arquivos anteriores:

```bash
node dist/main.js recovery-verify "$parent" --output "$recovery_dir/audit-001.json"
```

No v2 o exit code continua **1**, porque o pai não foi reconciliado, inclusive quando `coverage_complete=true`. Conferir a presença do evento `recovery_coverage`, do arquivo novo e de `verified_at`; `worker_stopped` ou arquivo ausente indicam erro, não auditoria válida. O stdout contém somente resumo; `unobserved_ranges` fica no arquivo privado.

Interpretar:

- `expected`: Quantity do log, não uma lista conhecida de IDs.
- `observed_unique` / `covered`: IDs distintos realmente recebidos / com persistência local verificada.
- `missing`: IDs observados cuja persistência local não foi comprovada; `conflicts`: divergências detectadas.
- `unobserved_positions` e `unobserved_ranges`: posições sem observação comprovada; não significam ausência oficial de registros.
- `coverage_complete`: cobertura observada ponto a ponto; `complete` e `resolution_allowed` continuam false.

Se um bloco terminou com corpo válido, mas há posições não observadas dentro dele, é possível **uma tentativa complementar explícita** por subfaixa exclusivamente não observada:

```bash
node dist/main.js capture-reread "$parent" 2026-11-12 INICIO_DA_LACUNA FIM_DA_LACUNA \
  --authorization "$authorization_hash" --missing-only
node dist/main.js recover-local
node dist/main.js recovery-verify "$parent" --output "$recovery_dir/audit-002.json"
```

Usar limites copiados da auditoria, contidos em um único bloco primário. A aplicação exige o bloco anterior done, corpo/checkpoint/hash válidos e nenhum ID já observado na subfaixa. Sobreposição com qualquer tentativa complementar anterior é recusada, mesmo se ela retornou vazia. Não há loop automático nem segunda tentativa sobre resultado ambíguo.

Se continuar ausente, conservar corpo e metadados e solicitar à OLOS retenção, limites efetivos do endpoint e fornecimento dos registros ou prova individual de ausência. Não converter `[]`, HTTP 200, Quantity coincidente ou contagem local em prova de inexistência. No caso atual, um buraco é incompatível com cobertura ponto a ponto dos 39150 candidatos; a aplicação não decide qual hipótese externa explica isso. Uma prova futura de ausência não é aplicada automaticamente por este patch.

Mesmo recuperando todos os 39150 IDs, **não executar resolve nem retomar o scheduler por esta autorização v2**. Guardar o digest de cobertura e reconciliar separadamente a operação/cursor com evidência real. O pai, recibos, quarentenas e controles corporativos permanecem preservados.
