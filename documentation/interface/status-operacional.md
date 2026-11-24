# Status operacional

[Manual do painel](README.md) / Status operacional

## Finalidade

Exibir evidências distintas da saúde da plataforma: autenticação da sessão, PostgreSQL, persistência OLOS, scheduler e último ciclo. Não é um único indicador binário de disponibilidade.

## Cartões de saúde

- **Autenticação OLOS:** mostra aceitação da identidade na sessão web. **Não prova ingestão da API**.
- **PostgreSQL:** conectividade e validade da estrutura são observadas separadamente.
- **Ingestão OLOS:** interpreta estados como persistência confirmada, leituras pendentes ou evidência indisponível.

## Execução

| Campo | Significado |
|---|---|
| Próxima leitura | Data/hora de execução programada |
| Intervalo | Frequência configurada entre ciclos, em minutos |
| Operação atual | Indica se existe leitura/persistência em andamento |
| Estado real / desejado | Compara estado efetivo com o comando persistido |
| Última execução | Início da leitura mais recente |
| Último ciclo confirmado | Término do ciclo duravelmente confirmado |
| Recebidos / inseridos / duplicidades | Contadores **do último ciclo medido**, não totais históricos |
| Tempo de processamento | Duração registrada do ciclo; `Não medido` quando indisponível |
| Último erro | Código reportado pela operação ou ingestão |

## Auditoria administrativa

A página apresenta uma tabela com **horário, administrador e ação**. O item **Auditoria** do menu lateral salta para essa seção; consulte [Auditoria](auditoria.md).

## Como interpretar

- `RUNNING / RUNNING`: o estado solicitado e o observado coincidem em execução.
- `RUNNING / STOPPED`: não afirme que há leitura ativa; investigue a transição, inclusive no início do processo.
- `PAUSING` / `STOPPING`: transições que aguardam a operação em curso.
- `ERROR`: requer análise do código de erro e do estado durável; não significa que seja seguro consumir novamente da origem.

A API principal é `GET /api/status`. Mais detalhes: [Estados](../referencia/estados.md).
