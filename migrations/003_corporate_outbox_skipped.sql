-- OLOS ExportDataV3
-- Permite classificar registros inelegiveis como skipped.
-- Aplicacao manual, somente no banco local.
-- Nao altera registros existentes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE olos_http.corporate_outbox
  DROP CONSTRAINT corporate_outbox_state_check;

ALTER TABLE olos_http.corporate_outbox
  ADD CONSTRAINT corporate_outbox_state_check
  CHECK (
    state IN ('pending', 'confirmed', 'skipped')
  );

COMMENT ON COLUMN olos_http.corporate_outbox.state IS
  'pending: aguardando entrega; confirmed: entrega confirmada; skipped: inelegivel para entrega corporativa';

COMMIT;
