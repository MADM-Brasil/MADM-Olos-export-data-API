# Glossário

[Início](../README.md) / Referência

| Termo | Definição |
|---|---|
| **OLOS ExportDataV3** | Serviço externo de disponibilização de dados de operação |
| **Worker** | Processo que executa a captura e o processamento de respostas |
| **Scheduler** | Controlador da frequência e do estado de execução |
| **Read / leitura** | Intenção durável e histórico de uma solicitação à origem |
| **Batch** | Subconjunto de registros processado e persistido em uma etapa |
| **Source ID** | Identidade de registro proveniente da origem |
| **Outbox** | Fila local persistente que dissocia captura da entrega corporativa |
| **Recibo** | Evidência local da confirmação da entrega corporativa |
| **Skipped** | Registro intencionalmente excluído da entrega pela política |
| **MADM** | Ambiente corporativo de destino e de análise de chamadas |
| **Snapshot** | Agregado persistido com data de observação e contrato de integridade |
| **Idempotência** | Capacidade de tratar reapresentação de dados sem criar nova identidade lógica indevida |
| **Data da ligação** | Data/hora do fato telefônico, usada na consulta corporativa |
| **Primeira persistência** | Momento em que o registro entrou pela primeira vez no PostgreSQL local |
| **Data de confirmação** | Momento em que a entrega corporativa foi reconhecida e registrada |
| **Reading incerto** | Leitura cuja situação perante a origem não está comprovada localmente |
