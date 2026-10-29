import type { PoolClient } from 'pg';
import { WorkerError } from './errors.js';
export async function lockSource(client: PoolClient, sourceKey: string): Promise<void> {
  const result=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
    [`olos-http:AttemptsRawData:${sourceKey}`]);
  if (!result.rows[0].acquired) throw new WorkerError('CONSUMER_ALREADY_ACTIVE');
}
