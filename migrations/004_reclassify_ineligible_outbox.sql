-- Reclassificacao de pendencias inelegiveis.
-- Executar somente depois da migracao 003.
-- Um lote por execucao, preservando registros e hashes.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

WITH candidates AS MATERIALIZED (
  SELECT o.source_key, o.source_id
  FROM olos_http.corporate_outbox o
  JOIN olos_http.records r
    USING (source_key, source_id)
  WHERE o.source_key = 'olos-production'
    AND o.state = 'pending'
    AND (
      r.agent_id IS NULL
      OR r.agent_id !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(o.payload->'nome_agente')
         IS DISTINCT FROM 'string'
      OR btrim(o.payload->>'nome_agente',
         U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = ''
      OR btrim(o.payload->>'nome_agente',
         U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') ~*
         '^([0-9]+|-1|null|undefined|n/a|unknown|desconhecido|sem operador|sem agente|não identificado|nao identificado)$'
    )
  ORDER BY o.target_id
  LIMIT 1000
  FOR UPDATE OF o SKIP LOCKED
),
updated AS (
  UPDATE olos_http.corporate_outbox o
  SET state = 'skipped'
  FROM candidates c
  WHERE o.source_key = c.source_key
    AND o.source_id = c.source_id
    AND o.state = 'pending'
  RETURNING o.source_id
)
SELECT COUNT(*) AS reclassified
FROM updated;

COMMIT;
