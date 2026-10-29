-- Local homologation only. Runtime uses LOCAL_DATABASE_URL, never DATABASE_URL.
BEGIN;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "local_olos";

-- CreateTable
CREATE TABLE "local_olos"."checkpoints" (
    "source_key" TEXT NOT NULL,
    "baseline" TEXT NOT NULL,
    "baseline_evidence" TEXT NOT NULL,
    "contract_origin" TEXT NOT NULL,
    "contract_digest" TEXT NOT NULL,
    "identity_evidence" TEXT NOT NULL,
    "source_time_zone" TEXT,
    "completed_runs" INTEGER NOT NULL DEFAULT 0,
    "committed_records" INTEGER NOT NULL DEFAULT 0,
    "last_completed_run_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("source_key")
);

-- CreateTable
CREATE TABLE "local_olos"."ingestion_runs" (
    "id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "response_hash" TEXT NOT NULL,
    "response_body" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'received',
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "received_count" INTEGER,
    "normalized_count" INTEGER NOT NULL DEFAULT 0,
    "excluded_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_olos"."raw_records" (
    "id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "first_run_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_olos"."normalized_records" (
    "raw_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "normalized_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normalized_records_pkey" PRIMARY KEY ("raw_id","version")
);

-- CreateIndex
CREATE INDEX "ingestion_runs_source_key_state_started_at_idx" ON "local_olos"."ingestion_runs"("source_key", "state", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_source_key_response_hash_key" ON "local_olos"."ingestion_runs"("source_key", "response_hash");

-- CreateIndex
CREATE UNIQUE INDEX "raw_records_source_key_source_id_key" ON "local_olos"."raw_records"("source_key", "source_id");

-- AddForeignKey
ALTER TABLE "local_olos"."raw_records" ADD CONSTRAINT "raw_records_first_run_id_fkey" FOREIGN KEY ("first_run_id") REFERENCES "local_olos"."ingestion_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_olos"."normalized_records" ADD CONSTRAINT "normalized_records_raw_id_fkey" FOREIGN KEY ("raw_id") REFERENCES "local_olos"."raw_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE local_olos.checkpoints ADD CONSTRAINT checkpoint_counts CHECK (completed_runs>=0 AND committed_records>=0),
  ADD CONSTRAINT contract_origin_valid CHECK (contract_origin IN ('fixture','observed'));
ALTER TABLE local_olos.ingestion_runs ADD CONSTRAINT run_progress CHECK (
  processed_count>=0 AND normalized_count>=0 AND excluded_count>=0 AND duplicate_count>=0
  AND processed_count=normalized_count+excluded_count+duplicate_count
  AND (received_count IS NULL OR processed_count<=received_count)),
  ADD CONSTRAINT run_state CHECK (state IN ('received','done')),
  ADD CONSTRAINT run_done CHECK (state<>'done' OR (processed_count=received_count AND completed_at IS NOT NULL));
ALTER TABLE local_olos.normalized_records ADD CONSTRAINT normalization_version_positive CHECK (version>0),
  ADD CONSTRAINT normalized_disposition CHECK (disposition IN ('eligible','before_baseline'));
COMMIT;

