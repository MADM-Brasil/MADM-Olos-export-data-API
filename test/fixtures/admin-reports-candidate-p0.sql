-- Rejected P0 experiment: equivalent counts, failed performance gate. TEST ONLY.
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
      ) SELECT day::text,
        sum(calls)::text AS calls, sum(collected_today)::text AS collected_today,
        coalesce(sum(calls) FILTER (WHERE name_check.valid AND agent_id ~ '^[1-9][0-9]*$'),0)::text AS identified_calls,
        -- JSON preserves textual IDs while avoiding pg's per-character text[] decoder.
        json_agg(DISTINCT agent_id) FILTER (WHERE name_check.valid AND agent_id ~ '^[1-9][0-9]*$') AS operator_ids,
        sum(with_cpf)::text AS with_cpf, sum(with_email)::text AS with_email,
        coalesce(sum(calls) FILTER (WHERE delivery='confirmed'),0)::text AS confirmed,
        coalesce(sum(calls) FILTER (WHERE delivery='pending'),0)::text AS pending,
        coalesce(sum(calls) FILTER (WHERE delivery='not_queued'),0)::text AS not_queued,
        coalesce(sum(calls) FILTER (WHERE delivery='inconsistent'),0)::text AS inconsistent,
        sum(missing_mapping)::text AS missing_mapping
      FROM per_identity
      -- A one-row projection fence evaluates the exact name rule once per
      -- identity group, shared by the sum and distinct-ID aggregate. Without
      -- the fence PostgreSQL inlines the regex separately into both filters.
      CROSS JOIN LATERAL (SELECT coalesce(agent_name<>'' AND agent_name !~* $3,false) AS valid OFFSET 0) name_check
      GROUP BY day ORDER BY day
