# Login OLOS e painel local — homologação de 28/10/2026

## Escopo e isolamento

O acesso agora usa apenas **Usuário OLOS / Senha OLOS**. Client ID e Secret ficam no backend, provenientes da configuração protegida, sem recadastro no frontend. A autorização é uma lista explícita `ADMIN_OLOS_USERS_JSON`, separada da autenticação. Sessões, Origin, CSRF, limitação de tentativas e auditoria foram preservados.

Não houve autenticação real na OLOS nesta entrega. Nenhum endpoint operacional foi consumido. Mapeamentos de CPF, e-mail, agentes, campanhas, tabulação e desligamento não foram alterados. Não houve escrita no destino existente, migration operacional, deploy, commit ou push. O container `export-data-v3-api-worker-1` não foi reiniciado.

O painel anterior na porta 8081 foi identificado pelo processo, diretório, comando, banco `olos_admin_homolog`, fonte `olos-admin-homolog` e Origin. Ele estava em ERROR por `SOURCE_ID_UNIQUENESS_UNCONFIRMED`. O banco anterior em `127.0.0.1:15433` tinha uma configuração criptografada salva e **não possuía `raw.olos_calls`**. Essas credenciais foram preservadas; não foram usadas em testes nem substituídas por fixtures. O encerramento controlado alterou somente o estado administrativo local do processo anterior.

A configuração de ambiente do processo anterior foi guardada com permissão 0600 fora do repositório em `/home/madm/.local/state/olos-admin-homolog/previous-panel-environment.json`. Contém informações privadas: não imprimir, versionar nem usar automaticamente para iniciar outro consumidor. A política administrativa antiga não é convertida em autorização OLOS.

Para não sobrescrever a configuração anterior, o perfil simulado usa outro PostgreSQL local, com o **mesmo nome de banco e fonte exigidos**, isolado do anterior:

| Componente | Configuração |
|---|---|
| Painel | `http://localhost:8081` |
| Banco | `olos_admin_homolog`, instância simulada em `127.0.0.1:15434` |
| Fonte | `olos-admin-homolog` |
| PostgreSQL do perfil anterior | `127.0.0.1:15433`, credenciais salvas preservadas |
| Simulador OLOS | `http://127.0.0.1:18081/WebApiExportData` |
| Estado final | `STOPPED`, sem leituras transacionais |
| Credenciais do simulador | Usuário `homolog-admin`, senha **fictícia** `homolog-password` |

O simulador aceita autenticação de `homolog-visitor`, mas essa identidade é negada pela autorização do painel. Client ID/Secret fictícios são fornecidos apenas ao backend. O simulador nunca encaminha tráfego à OLOS e rejeita qualquer rota que não seja auth (exceto estatísticas locais).

## Comandos exatos — somente painel local

```bash
cd ~/madm/export-data-v3-api
source ~/.nvm/nvm.sh
nvm use 24

# Reinicia somente o processo de painel controlado por este perfil:
node scripts/admin-homolog.mjs restart

# Inspeciona disponibilidade, sem mostrar segredos:
node scripts/admin-homolog.mjs status

# Para somente o painel; não para PostgreSQL ou worker operacional:
node scripts/admin-homolog.mjs stop

# Inicia novamente o painel local:
node scripts/admin-homolog.mjs start
```

O comando `restart` não reinicia o PostgreSQL ou qualquer container operacional. Verifica PID, horário de criação, diretório e comando antes de enviar SIGTERM; não usa SIGKILL nem mata processos por porta. Um processo desconhecido ocupando a porta é um bloqueio, não autorização para encerrá-lo. Não executar `node dist/main.js admin` em paralelo ao painel já ativo.

Em uma instalação nova, executar primeiro `npm ci`, `npm run build` e `node scripts/admin-homolog.mjs setup`. O setup gera `admin/.env.homolog` privado, sem sobrescrever um existente, inicia apenas `admin/compose.homolog.yaml` e aplica as migrations de controle nesse PostgreSQL isolado. **Não cria nem modifica `raw.olos_calls`.** O perfil não lê o `.env` da raiz, exige URL OLOS do simulador e mantém `SOURCE_ID_UNIQUENESS_CONFIRMED=false`.

Logs e identidades dos processos ficam em `admin/.homolog/`, ignorado pelo Git. A chave AES e a conexão do perfil estão no arquivo privado `admin/.env.homolog`. O volume PostgreSQL preserva configurações e auditoria. Não remover esse volume/configuração sem backup e autorização de limpeza.

## Resultados reais desta homologação

- Login válido via simulador: aceito; login inválido: recusado, sem detalhes sensíveis.
- Usuário autenticado sem autorização: acesso negado, sem sessão administrativa.
- Client ID/Secret fornecidos pelo backend; ausentes das respostas e dos campos do frontend.
- Login não cria agendador, não inicia ciclo, não altera credenciais da integração e não compartilha seu manager de tokens.
- Navegação e alteração de intervalo funcionaram em STOPPED e ERROR. Iniciar consumidor com fonte não confirmada manteve o bloqueio e mostrou a explicação no dashboard.
- Segundo processo administrativo: `SCHEDULER_ALREADY_ACTIVE`, sem autenticação OLOS ou novo consumidor. O script de restart evita iniciar uma segunda instância.
- Teste de conexão: apenas `/api/auth`. Contador do simulador de rotas não-auth: **zero**.
- PostgreSQL acessível, estrutura de destino **não validada** por ausência de `raw.olos_calls`. O dashboard mostra esse fato, não um falso sinal de saúde.
- Ingestão: **nenhum ciclo confirmado e nenhuma leitura pendente** no perfil simulado. Métricas aparecem como não medidas. Nenhum registro de destino foi criado para fazer a tela parecer saudável.
- Parada e reinício local: STOPPED persistido; sessões antigas invalidadas; novo login funcionou.

Os testes de integração de persistência usam PostgreSQL descartável separado, também denominado `olos_admin_homolog`, com fonte `olos-admin-homolog`, e tabelas sintéticas criadas apenas no container de teste. Não são executados contra o banco persistente da porta 15433 ou 15434. Os scripts criam e removem seus próprios containers.

| Validação | Resultado |
|---|---|
| Typecheck / build | Aprovados |
| Unidade / HTTP local / segurança / scheduler | 64 testes aprovados |
| Administração / indicadores em PostgreSQL descartável | 13 testes aprovados |
| Regressão de ingestão PostgreSQL | 23 testes aprovados |
| Chromium em `localhost:8081` | Login/negação, edição, segredos ocultos, autenticação isolada, navegação em ERROR, parada/reinício/logout e layout móvel aprovados |

```bash
npm run typecheck
npm run build
npm test
bash scripts/test-admin.sh
bash scripts/test-integration.sh
# Opcional: Playwright instalado externamente; perfil local precisa estar ativo.
ADMIN_PLAYWRIGHT_PATH=/caminho/para/playwright node test/admin.browser.mjs
```

## Medição sem alterar regras de ingestão

`Worker.cycle()` agora retorna os mesmos contadores já registrados em `batch_completed`, somente depois da persistência existente concluir. O adapter administrativo salva esse relatório em `admin_audit`, conferindo a leitura `done` da mesma fonte e sua contagem/progresso. Não há migration nova ou alteração nos SQLs de destino/deduplicação.

O dashboard consulta PostgreSQL em transação somente leitura e separa: autenticação da sessão, estrutura do banco, última execução, último ciclo confirmado, métricas, último erro histórico e pendências. Métricas antigas não observadas continuam NULL. `[]` persistido e concluído é sucesso, não falha de conectividade. Se falhar a gravação da evidência administrativa após o commit de dados, o consumidor para com ERROR sem repetir a leitura; o estado `done` continua consultável.

## Próxima homologação real

A lista de identidades OLOS administrativas reais ainda precisa ser definida pelo responsável, usando `ADMIN_OLOS_USERS_JSON`. Não inferir essa autorização do usuário técnico do `.env` nem da antiga conta administrativa local.

Sob autorização específica, preparar um perfil separado para autenticação real e testar **somente `/api/auth`**, mantendo consumidor parado. Não editar o perfil simulado para apontar para a fonte operacional; os seus comandos rejeitam essa alteração. A arquitetura mantém managers de autenticação separados; a coexistência de tokens no servidor OLOS precisa ser confirmada sem alegar uma garantia não documentada. O login bem-sucedido não comprova ingestão ou autoriza ativá-la.

## Arquivos desta alteração

- Backend: `src/admin/security.ts`, `credentials.ts`, `repository.ts`, `server.ts`, `main.ts`, `consumer.ts`.
- Evidência após persistência, sem alteração de mapeamento: `src/worker.ts`.
- Frontend: `admin/public/index.html`, `app.js`, `style.css`.
- Configuração/documentação: `admin/.env.example`, `admin/README.md`, `admin/homologation-login.md`, `compose.admin.yaml`, `.gitignore`, `.dockerignore`.
- Perfil simulado novo: `admin/compose.homolog.yaml`, `scripts/admin-homolog.mjs`, `scripts/mock-olos-auth.mjs`.
- Testes: `test/admin.test.ts`, `test/admin.database.ts`, `test/admin.browser.mjs`, `test/store.integration.ts`, `scripts/test-admin.sh`, `scripts/test-integration.sh`.
- Removido o gerador da autenticação local antiga: `scripts/admin-password-hash.mjs`.

Arquivos privados gerados (`admin/.env.homolog`, `admin/.homolog/`) são ignorados por Git/Docker. Nenhuma migration nova foi necessária: métricas e auditoria usam a estrutura administrativa existente.
