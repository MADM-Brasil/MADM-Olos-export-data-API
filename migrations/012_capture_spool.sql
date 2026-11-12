-- Metadados duraveis das respostas HTTP ExportDataV3.
-- Nao altera o estado das leituras existentes.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE olos_http.capture_spool (
    read_id uuid PRIMARY KEY
        REFERENCES olos_http.reads(id),

    file_name text NOT NULL UNIQUE,

    byte_size bigint NOT NULL
        CHECK (byte_size >= 0),

    sha256 text NOT NULL
        CHECK (sha256 ~ '^[a-f0-9]{64}$'),

    state text NOT NULL
        CHECK (state IN ('complete', 'verified')),

    created_at timestamptz NOT NULL
        DEFAULT clock_timestamp(),

    verified_at timestamptz,
    record_count integer CHECK (record_count >= 0),

    CONSTRAINT capture_spool_file_name_valid
        CHECK (
            file_name =
            read_id::text || '.json'
        ),

    CONSTRAINT capture_spool_verified_consistent
        CHECK (
            state <> 'verified'
            OR (verified_at IS NOT NULL AND record_count IS NOT NULL)
        )
);


-- Referencia opcional para capturas armazenadas em arquivo.
ALTER TABLE olos_http.reads
ADD COLUMN response_spool_read_id uuid;

ALTER TABLE olos_http.reads
ADD CONSTRAINT reads_response_spool_fk
FOREIGN KEY (response_spool_read_id)
REFERENCES olos_http.capture_spool(read_id)
DEFERRABLE INITIALLY DEFERRED;

-- Substituir somente a restricao antiga de corpo obrigatorio.
DO $$
DECLARE
    old_constraint text;
    matching_count integer;
    expected text;
BEGIN
    -- Compare the parsed canonical expression, not a broad LIKE that could drop a custom guard.
    CREATE TEMP TABLE capture_old_constraint_reference (
      state text, response_body text,
      CHECK (state NOT IN ('received','done') OR response_body IS NOT NULL)
    ) ON COMMIT DROP;
    SELECT pg_get_expr(conbin,conrelid) INTO expected FROM pg_constraint
      WHERE conrelid='pg_temp.capture_old_constraint_reference'::regclass AND contype='c';
    SELECT count(*), min(conname)
      INTO matching_count, old_constraint
    FROM pg_constraint
    WHERE conrelid = 'olos_http.reads'::regclass
      AND contype = 'c'
      AND pg_get_expr(conbin,conrelid) = expected;

    IF matching_count <> 1 THEN
        RAISE EXCEPTION 'READS_BODY_CONSTRAINT_NOT_UNIQUE';
    END IF;

    EXECUTE format(
        'ALTER TABLE olos_http.reads DROP CONSTRAINT %I',
        old_constraint
    );
END $$;

ALTER TABLE olos_http.reads
ADD CONSTRAINT reads_response_durable_required
CHECK (
    state NOT IN ('received', 'done')
    OR (
        response_body IS NOT NULL
        AND response_spool_read_id IS NULL
    )
    OR (
        response_body IS NULL
        AND response_spool_read_id IS NOT NULL
    )
);

-- Uma leitura somente pode referenciar o proprio arquivo.
ALTER TABLE olos_http.reads
ADD CONSTRAINT reads_response_spool_identity
CHECK (
    response_spool_read_id IS NULL
    OR response_spool_read_id = id
);

ALTER TABLE olos_http.reads ADD CONSTRAINT reads_response_single_storage
CHECK (response_body IS NULL OR response_spool_read_id IS NULL);

COMMIT;
