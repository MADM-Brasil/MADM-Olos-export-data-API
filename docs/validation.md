# Validação local — 28/10/2026

Resultados obtidos neste checkout, sem OLOS real ou banco corporativo.

| Validação | Resultado |
|---|---|
| `npm run typecheck` | passou, TypeScript strict |
| `npm test` | 18 testes aprovados, zero ignorados |
| `bash scripts/test-integration.sh` | 19 testes aprovados, PostgreSQL 16 descartável, zero ignorados |
| `npm run build` | passou |
| Migration `001_ingestion.sql` | aplicada em cada fixture PostgreSQL real da suíte |
| `docker build -t olos-http-worker:local-validation .` | passou, multi-stage |
| `bash scripts/test-docker.sh` | passou, rede Docker interna sem OLOS externo |
| `docker compose config --quiet` | passou com variáveis sintéticas |
| `npm audit --omit=dev` | zero vulnerabilidades conhecidas reportadas nessa execução |
| Runtime Docker | Node v24.22.1, UID 1000, filesystem readonly, capabilities removidas |

Os testes locais fora do container usaram Node v24.16.0 instalado no host; o Docker build resolveu Node v24.22.1. O projeto fixa a linha major 24 e as versões npm via lockfile.

## Cobertura

- Autenticação inicial, single-flight, `expires_in` real, margem curta/longa, múltiplos vencimentos, rotação/preservação de refresh, refresh revogado 400/401, indisponibilidade, resposta inválida e retry único de 401.
- HTTP multipart em sockets reais locais, keep-alive, 200 com registros e `[]`, catálogo inválido, timeout, limite de resposta, Retry-After e distinção entre retry seguro e consumo incerto.
- IDs maiores que Number.MAX_SAFE_INTEGER, zeros em campos textuais, microssegundos, fuso obrigatório, datas inválidas/ambíguas, campos sem fonte NULL e referências ausentes.
- Cache por TTL, refresh atômico e descarte de Users.Password.
- Polling sequencial: espera começa ao final do ciclo, sem sobreposição, backoff limitado.
- PostgreSQL real: inserts/UPSERT em lotes, atomicidade entre destino/marcador/progresso, duplicatas com mesmo CallId e IDs de origem diferentes, colisão de conteúdo, restart e commit parcial, perda da confirmação de COMMIT já efetivado, lock entre consumidores e baseline/esquema incompatíveis.
- Falha PostgreSQL antes do HTTP não consome. Queda do banco após resposta deixa intenção durável que bloqueia novo consumo. Falha remota ambígua não provoca segunda requisição.
- Backfill e reread compartilham deduplicação. Releitura não resolve automaticamente a incerteza original; faixa retornada é validada e registros inválidos ficam preservados.
- Smoke Docker: serviço real compilado, servidor HTTP sintético, PostgreSQL em rede interna, papel de runtime sem superuser, nomes resolvidos, deduplicação, shutdown e múltiplas renovações de token sem reinício. Uma execução observou 1 password grant, 6 refresh grants e 31 leituras para uma única linha de destino. Contagens variam com o tempo de execução.

Foi exercitado lote sintético de 1.201 registros em três transações de até 500 registros. Uma execução levou 93 ms e outra 186 ms na entrega local, variando com a carga do host. Isso **não é benchmark corporativo nem promessa de latência**; não inclui disponibilização pela OLOS.

## Não validado

- Login HTTP real, refresh real, formato exato de catálogo/envelopes, limites e disponibilidade da API OLOS.
- Destino corporativo atual, baseline do histórico, mapeamento de ID interno sem geração e significado de timestamps legados.
- Unicidade/imutabilidade global de AttemptsRawDataID entre dias reais.
- Atomicidade remota, atribuição/retensão/completude de LogReadData/ReReadData, semântica dos erros HTTP e backfill real.
- Fontes dos sete campos pendentes no README.
- Operação prolongada, consumo real de memória/CPU, contenção de escritores corporativos, políticas de backup/retenção e deploy Dokploy.

Não foram feitos commit, push, deploy, DDL/DML no projeto antigo ou chamadas transacionais reais na OLOS.
