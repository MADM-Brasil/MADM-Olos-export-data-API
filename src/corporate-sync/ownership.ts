import type { Client, PoolClient } from 'pg';
import { SyncError } from './errors.js';

export async function assertNoDirectOwnership(db: Client | PoolClient): Promise<void> {
  const present = (await db.query("SELECT to_regclass('olos_http.corporate_control') IS NOT NULL AS present")).rows[0].present;
  if (present && (await db.query('SELECT 1 FROM olos_http.corporate_control WHERE singleton')).rowCount) {
    throw new SyncError('DIRECT_DELIVERY_OWNS_DESTINATION');
  }
}
