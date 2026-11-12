-- LOCAL ONLY.
-- Registra novas tentativas de adoção após reversão concluída.
-- Não altera a autoridade ativa nem os dados históricos.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

SELECT pg_advisory_xact_lock(17320914, 3);

ALTER TABLE olos_http.corporate_id_reversions
    ADD CONSTRAINT corporate_reversions_source_request_unique
    UNIQUE (source_key, request_id);

CREATE TABLE olos_http.corporate_allocator_readoptions (
    request_id uuid PRIMARY KEY,

    source_key text NOT NULL
        REFERENCES olos_http.corporate_id_allocator(source_key),

    previous_reversion_id uuid NOT NULL,

    CONSTRAINT readoption_previous_reversion_fk
        FOREIGN KEY (source_key, previous_reversion_id)
        REFERENCES olos_http.corporate_id_reversions(source_key, request_id),

    binding text NOT NULL,

    target_table text NOT NULL,

    evidence_ref text NOT NULL
        CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),

    state text NOT NULL DEFAULT 'prepared'
        CHECK (state IN ('prepared', 'validating', 'ready', 'aborted')),

    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    validated_at timestamptz,

    validation_digest text
        CHECK (
            validation_digest IS NULL
            OR validation_digest ~ '^[0-9a-f]{64}$'
        ),

    CHECK (
        (
            state = 'ready'
            AND validated_at IS NOT NULL
            AND validation_digest IS NOT NULL
        )
        OR
        (
            state <> 'ready'
            AND validated_at IS NULL
            AND validation_digest IS NULL
        )
    ),

    UNIQUE (source_key, request_id)
);

CREATE UNIQUE INDEX corporate_allocator_readoption_one_open
ON olos_http.corporate_allocator_readoptions(source_key)
WHERE state IN ('prepared', 'validating', 'ready');

COMMENT ON TABLE olos_http.corporate_allocator_readoptions IS
'Histórico independente de readoção corporativa. Não concede autoridade de IDs nem modifica gerações anteriores.';

COMMIT;
