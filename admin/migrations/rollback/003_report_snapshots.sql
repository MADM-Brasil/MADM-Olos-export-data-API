-- Manual/local only, after stopping all snapshot readers/updaters or rolling code back.
-- Removes derived analytics only. Never touches records/outbox/receipts/checkpoints.
BEGIN;
DROP TABLE IF EXISTS olos_http.report_snapshot_state;
DROP TABLE IF EXISTS olos_http.report_snapshots;
DROP FUNCTION IF EXISTS olos_http.reject_report_snapshot_update();
COMMIT;
