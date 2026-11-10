-- Frozen query immediately before P0 optimization. Disposable equivalence/EXPLAIN only.
WITH classified AS NOT MATERIALIZED (
        SELECT (d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          r.agent_id, btrim(d.nome_agente,$2) AS agent_name,
          r.created_at >= $5::timestamptz AND r.created_at < $6::timestamptz AS collected_today,
          d.internal_id_olos IS NOT NULL AS mapped,
          coalesce(btrim(d.cpf,$2)<>'',false) AS has_cpf,
          coalesce(btrim(d.email,$2)<>'',false) AS has_email, CASE WHEN o.source_id IS NULL THEN 'not_queued'
        WHEN o.target_id<>r.target_id OR o.source_hash<>r.source_hash THEN 'inconsistent'
        WHEN o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL THEN 'confirmed'
        WHEN o.state='pending' AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL THEN 'pending'
        ELSE 'inconsistent' END AS delivery
        FROM olos_http.records r LEFT JOIN "raw"."olos_calls" d ON d.internal_id_olos=r.target_id
        LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id
        WHERE r.source_key=$1 AND r.target_table=$4
      ), per_identity AS (
        SELECT day, agent_id, agent_name, delivery, count(*) AS calls,
          count(*) FILTER (WHERE collected_today) AS collected_today,
          count(*) FILTER (WHERE has_cpf) AS with_cpf,
          count(*) FILTER (WHERE has_email) AS with_email,
          count(*) FILTER (WHERE NOT mapped) AS missing_mapping
        FROM classified GROUP BY day, agent_id, agent_name, delivery
      ), per_operator AS (
        SELECT day, CASE WHEN agent_id ~ '^[1-9][0-9]*$' AND agent_name<>''
          AND agent_name !~* $3 THEN agent_id END AS identified_agent, sum(calls) AS calls,
          sum(collected_today) AS collected_today,
          sum(with_cpf) AS with_cpf, sum(with_email) AS with_email,
          coalesce(sum(calls) FILTER (WHERE delivery='confirmed'),0) AS confirmed,
          coalesce(sum(calls) FILTER (WHERE delivery='pending'),0) AS pending,
          coalesce(sum(calls) FILTER (WHERE delivery='not_queued'),0) AS not_queued,
          coalesce(sum(calls) FILTER (WHERE delivery='inconsistent'),0) AS inconsistent,
          sum(missing_mapping) AS missing_mapping
        FROM per_identity GROUP BY day, identified_agent
      ) SELECT day::text,
        sum(calls)::text AS calls, sum(collected_today)::text AS collected_today,
        coalesce(sum(calls) FILTER (WHERE identified_agent IS NOT NULL),0)::text AS identified_calls,
        array_agg(identified_agent) FILTER (WHERE identified_agent IS NOT NULL) AS operator_ids,
        sum(with_cpf)::text AS with_cpf, sum(with_email)::text AS with_email,
        sum(confirmed)::text AS confirmed, sum(pending)::text AS pending,
        sum(not_queued)::text AS not_queued, sum(inconsistent)::text AS inconsistent,
        sum(missing_mapping)::text AS missing_mapping
      FROM per_operator GROUP BY day ORDER BY day
