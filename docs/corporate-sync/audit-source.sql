-- OPTIONAL, LOCAL SOURCE ONLY, read-only aggregates. Not executed against real databases in this delivery.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT count(*) AS total_calls,
  count(*) FILTER (WHERE tma_origem IS NOT NULL AND tma_origem::numeric <> trunc(tma_origem::numeric)) AS fractional_tma,
  count(*) FILTER (WHERE tma_origem::numeric < -2147483648 OR tma_origem::numeric > 2147483647) AS tma_outside_integer,
  count(*) FILTER (WHERE NULLIF(btrim(olos_call_id),'') IS NULL OR data_ligacao IS NULL
    OR NULLIF(btrim(telefone),'') IS NULL OR NULLIF(btrim(id_campanha_olos),'') IS NULL) AS incomplete_identity
FROM raw.olos_calls;
SELECT count(*) AS duplicated_logical_groups FROM (
  SELECT 1 FROM raw.olos_calls GROUP BY olos_call_id, data_ligacao, telefone, id_campanha_olos HAVING count(*) > 1
) duplicates;
ROLLBACK;
