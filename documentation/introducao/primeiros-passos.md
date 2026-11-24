# Primeiros passos

[Início](../README.md) / Introdução

## 1. Entrar

Acesse o endereço corporativo autorizado do painel (o URL não foi registrado nas auditorias), informe o **usuário OLOS** e a **senha OLOS**, e selecione **Entrar**. A autenticação do painel depende de a identidade estar na lista administrativa autorizada. Não compartilhe senhas nem credenciais em tickets.

## 2. Confirmar a operação

Abra **Status operacional** e verifique o estado **real** e o estado **solicitado**. `RUNNING / RUNNING` indica execução ativa confirmada nos estados observados. Examine as seções de PostgreSQL, ingestão, última execução e último erro.

## 3. Conferir as chamadas

Abra **Dashboard** para acompanhar o volume de chamadas na MADM e a próxima leitura. Para análise por período, abra **Relatórios** e escolha o intervalo de datas. Consulte o [dicionário de indicadores](../referencia/indicadores.md) antes de comparar contagens de fontes diferentes.

## 4. Investigar eventos

Abra **Terminal / Logs**; filtre por termo ou nível e consulte as últimas 100 leituras. O terminal visual não é um shell do sistema operacional.

## 5. Encerrar sessão

Use **Sair**. O painel possui sessão administrativa com validade definida no backend e controles de origem/CSRF.

> [!CAUTION]
> Não utilize **Parar Worker**, **Pausar agendamento**, **Salvar credenciais** ou **Salvar intervalo** para fins de exploração. São ações operacionais reais.

**Próximo:** [visão geral das abas](../interface/README.md).
