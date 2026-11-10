-- LOCAL DATABASE ONLY; manual. No corporate DDL or historical payload changes.
-- Existing pending/confirmed/skipped rows remain untouched (NULL policy code).
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
ALTER TABLE olos_http.corporate_outbox ADD COLUMN IF NOT EXISTS delivery_policy_code text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='olos_http.corporate_outbox'::regclass AND conname='corporate_outbox_delivery_policy_check') THEN
    ALTER TABLE olos_http.corporate_outbox ADD CONSTRAINT corporate_outbox_delivery_policy_check CHECK(
      delivery_policy_code IS NULL OR
      (delivery_policy_code='MANUAL_CAMPAIGN_EXCLUDED' AND state='skipped') OR
      (delivery_policy_code='CAMPAIGN_IDENTIFICATION_REQUIRED' AND state='pending')
    ) NOT VALID;
  END IF;
END $$;
COMMIT;
