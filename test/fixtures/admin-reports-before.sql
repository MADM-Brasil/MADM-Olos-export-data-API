-- Frozen pre-optimization oracle. Disposable tests only; outbox present.
WITH calls AS MATERIALIZED (
        SELECT r.source_id,r.agent_id,(d.data_ligacao AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          d.internal_id_olos IS NOT NULL AS mapped,
          coalesce(r.agent_id ~ '^[1-9][0-9]*$' AND btrim(d.nome_agente,$4)<>'' AND btrim(d.nome_agente,$4) !~* $5,false) AS identified,
          coalesce(btrim(d.cpf,$4)<>'',false) AS has_cpf,coalesce(btrim(d.email,$4)<>'',false) AS has_email,
          CASE WHEN o.source_id IS NULL THEN 'not_queued'
        WHEN o.target_id<>r.target_id OR o.source_hash<>r.source_hash THEN 'inconsistent'
        WHEN o.state='confirmed' AND o.remote_raw_id IS NOT NULL AND o.confirmed_at IS NOT NULL THEN 'confirmed'
        WHEN o.state='pending' AND o.remote_raw_id IS NULL AND o.confirmed_at IS NULL THEN 'pending'
        ELSE 'inconsistent' END AS delivery
        FROM olos_http.records r LEFT JOIN "raw"."olos_calls" d ON d.internal_id_olos=r.target_id
        LEFT JOIN olos_http.corporate_outbox o ON o.source_key=r.source_key AND o.source_id=r.source_id
        WHERE r.source_key=$1 AND r.target_table=$6
      ), summary AS (SELECT count(*)::text AS calls,
        count(*) FILTER (WHERE identified)::text AS identified_calls,
        count(DISTINCT agent_id) FILTER (WHERE identified)::text AS operators,
        count(*) FILTER (WHERE has_cpf)::text AS with_cpf,
        count(*) FILTER (WHERE has_email)::text AS with_email,
        count(*) FILTER (WHERE delivery='confirmed')::text AS confirmed,
        count(*) FILTER (WHERE delivery='pending')::text AS pending,
        count(*) FILTER (WHERE delivery='not_queued')::text AS not_queued,
        count(*) FILTER (WHERE delivery='inconsistent')::text AS inconsistent,count(*) FILTER (WHERE day IS NULL)::text AS undated,
          count(*) FILTER (WHERE NOT mapped)::text AS missing_mapping FROM calls),
      daily AS (SELECT day::text,count(*)::text AS calls,
        count(*) FILTER (WHERE identified)::text AS identified_calls,
        count(DISTINCT agent_id) FILTER (WHERE identified)::text AS operators,
        count(*) FILTER (WHERE has_cpf)::text AS with_cpf,
        count(*) FILTER (WHERE has_email)::text AS with_email,
        count(*) FILTER (WHERE delivery='confirmed')::text AS confirmed,
        count(*) FILTER (WHERE delivery='pending')::text AS pending,
        count(*) FILTER (WHERE delivery='not_queued')::text AS not_queued,
        count(*) FILTER (WHERE delivery='inconsistent')::text AS inconsistent FROM calls WHERE day BETWEEN $2::date AND $3::date GROUP BY day),
      period AS (SELECT count(*)::text AS calls,
        count(*) FILTER (WHERE identified)::text AS identified_calls,
        count(DISTINCT agent_id) FILTER (WHERE identified)::text AS operators,
        count(*) FILTER (WHERE has_cpf)::text AS with_cpf,
        count(*) FILTER (WHERE has_email)::text AS with_email,
        count(*) FILTER (WHERE delivery='confirmed')::text AS confirmed,
        count(*) FILTER (WHERE delivery='pending')::text AS pending,
        count(*) FILTER (WHERE delivery='not_queued')::text AS not_queued,
        count(*) FILTER (WHERE delivery='inconsistent')::text AS inconsistent FROM calls WHERE day BETWEEN $2::date AND $3::date)
      SELECT (SELECT row_to_json(summary) FROM summary) AS summary,
        (SELECT row_to_json(period) FROM period) AS period,
        coalesce((SELECT json_agg(daily ORDER BY day) FROM daily),'[]') AS daily,
        (SELECT count(*)::text FROM olos_http.reads WHERE source_key=$1 AND error_code IS NOT NULL) AS failed_reads,
        transaction_timestamp() AS observed_at
