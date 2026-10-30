import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';

// Billing's current projectAttempts marks conflict when its target row is absent locally.
// Do not silently break that contract or modify Billing as part of this transition.
export async function assertLocalConsumersCompatible(local: PoolClient, source: string): Promise<void> {
  const present = (await local.query("SELECT to_regclass('olos_billing.sources') IS NOT NULL AS present")).rows[0].present;
  if (present && (await local.query('SELECT 1 FROM olos_billing.sources WHERE attempts_source=$1 LIMIT 1', [source])).rowCount) {
    throw new SyncError('BILLING_LOCAL_CALLS_DEPENDENCY');
  }
}
