BEGIN TRANSACTION READ ONLY;

SELECT
    'outbox_total' AS indicador,
    count(*)::bigint AS quantidade
FROM olos_http.corporate_outbox
WHERE source_key = 'olos-production'

UNION ALL

SELECT
    'outbox_pending',
    count(*)::bigint
FROM olos_http.corporate_outbox
WHERE source_key = 'olos-production'
  AND state = 'pending'

UNION ALL

SELECT
    'outbox_confirmed',
    count(*)::bigint
FROM olos_http.corporate_outbox
WHERE source_key = 'olos-production'
  AND state = 'confirmed'

UNION ALL

SELECT
    'outbox_skipped',
    count(*)::bigint
FROM olos_http.corporate_outbox
WHERE source_key = 'olos-production'
  AND state = 'skipped'

UNION ALL

SELECT
    'quarantined',
    count(*)::bigint
FROM olos_http.corporate_collision_quarantine
WHERE source_key = 'olos-production'

UNION ALL

SELECT
    'admissions_unmaterialized',
    count(*)::bigint
FROM olos_http.corporate_id_admissions
WHERE source_key = 'olos-production'
  AND NOT materialized

UNION ALL

SELECT
    'corporate_assignments',
    count(*)::bigint
FROM olos_http.corporate_id_assignments
WHERE source_key = 'olos-production'

UNION ALL

SELECT
    'local_records',
    count(*)::bigint
FROM olos_http.records
WHERE source_key = 'olos-production'
  AND target_table = '"raw"."olos_calls"'

ORDER BY indicador;

ROLLBACK;
