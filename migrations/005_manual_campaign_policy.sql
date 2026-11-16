-- Politica de exclusao de campanhas manuais
-- Aplicacao no PostgreSQL local, nunca no MADM.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE olos_http.corporate_outbox
  ADD COLUMN IF NOT EXISTS delivery_policy_code text;

ALTER TABLE olos_http.corporate_outbox
  ADD CONSTRAINT corporate_outbox_delivery_policy_check
  CHECK (
    delivery_policy_code IS NULL
    OR (
      delivery_policy_code = 'MANUAL_CAMPAIGN_EXCLUDED'
      AND state = 'skipped'
    )
  );

COMMIT;
