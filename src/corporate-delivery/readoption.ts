import { log } from '../errors.js';
import type { PoolClient } from 'pg';
import { SyncError } from '../corporate-sync/errors.js';
import type { Shape } from '../corporate-sync/mapping.js';
import type { DeliveryConfig } from './config.js';
import { quarantineMembers } from './quarantine.js';
import type { ReadoptionRequest, ReadoptionRecord } from './readoption-contract.js';

interface CorporateControlRow {
  ready: boolean;
  paused: boolean;
  id_allocator_required: boolean;
  source_key: string;
  target_table: string;
  binding: string;
  destination_shape: Array<
    [string, NonNullable<ReturnType<Shape['get']>>]
  >;
}

interface AllocatorRow {
  state: string;
  request_id: string;
  contract_hash: string | null;
  adopted_at: Date | null;
}

interface ReversionRow {
  request_id: string;
  adoption_request_id: string;
  state: string;
  validated_at: Date | null;
  source_key: string;
  target_table: string;
  binding: string;
}

export interface ReadoptionPreparation {
  readonly requestId: string;
  readonly alreadyApplied: boolean;
}

export async function prepareCorporateReadoption(
  db: PoolClient,
  request: ReadoptionRequest,
  binding: string,
  target: string,
  config: DeliveryConfig
): Promise<ReadoptionPreparation> {
  if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(request.requestId) ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(request.evidence) ||
    !request.source ||
    !/^[0-9a-f]{64}$/.test(binding)
  ) {
    throw new SyncError('READOPTION_REQUEST_INVALID');
  }

  let committing = false;

  try {
    await db.query('BEGIN');

    // Exclude concurrent homologation and administrative operations.
    // The transaction releases this shared lock on COMMIT or ROLLBACK.
    const homologation = await db.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock_shared(17320914,4) AS ok'
    );

    if (homologation.rows[0]?.ok !== true) {
      throw new SyncError('READOPTION_HOMOLOGATION_ACTIVE');
    }

    if (!(await db.query('SELECT pg_try_advisory_xact_lock(17320914,8) AS ok')).rows[0]?.ok) throw new SyncError('READOPTION_BUSY');
    await db.query('SELECT pg_advisory_xact_lock(17320914,5)');

    const controlResult = await db.query<CorporateControlRow>(
      `SELECT ready,paused,id_allocator_required,
              source_key,target_table,binding,destination_shape
       FROM olos_http.corporate_control
       WHERE singleton
       FOR UPDATE`
    );

    const control = controlResult.rows[0];

    const known=(await db.query<ReadoptionRecord>(`SELECT * FROM olos_http.corporate_allocator_readoptions
      WHERE request_id=$1 OR (source_key=$2 AND state<>'aborted')`,[request.requestId,request.source])).rows;
    if(known.length){
      if(known.length!==1||known[0]!.request_id!==request.requestId||known[0]!.source_key!==request.source
        ||known[0]!.binding!==binding||known[0]!.target_table!==target||known[0]!.evidence_ref!==request.evidence)throw new SyncError('READOPTION_REQUEST_CONFLICT');
      if(!control?.ready||control.source_key!==request.source||control.target_table!==target||control.binding!==binding)throw new SyncError('READOPTION_CONTROL_INVALID');
      await quarantineMembers(db,config,request.source,target,new Map(control.destination_shape));
      await db.query('ROLLBACK');log('corporate_readoption_idempotent',{request_id:request.requestId});
      return {requestId:request.requestId,alreadyApplied:true};
    }
    if (
      !control?.ready ||
      !control.paused ||
      control.id_allocator_required ||
      control.source_key !== request.source ||
      control.target_table !== target ||
      control.binding !== binding
    ) {
      throw new SyncError('READOPTION_CONTROL_INVALID');
    }

    await quarantineMembers(
      db,
      config,
      request.source,
      target,
      new Map(control.destination_shape)
    );

    const allocatorResult = await db.query<AllocatorRow>(
      `SELECT state,request_id,contract_hash,adopted_at
       FROM olos_http.corporate_id_allocator
       WHERE source_key=$1
       FOR UPDATE`,
      [request.source]
    );

    const allocator = allocatorResult.rows[0];

    if (
      allocator?.state !== 'legacy' ||
      allocator.contract_hash !== null ||
      allocator.adopted_at !== null
    ) {
      throw new SyncError('READOPTION_ALLOCATOR_STATE_INVALID');
    }

    const reversalResult = await db.query<ReversionRow>(
      `SELECT request_id,adoption_request_id,state,
              validated_at,source_key,target_table,binding
       FROM olos_http.corporate_id_reversions
       WHERE source_key=$1`,
      [request.source]
    );

    const reversal = reversalResult.rows[0];

    if (
      !reversal ||
      reversal.state !== 'completed' ||
      reversal.validated_at === null ||
      reversal.adoption_request_id !== allocator.request_id ||
      reversal.source_key !== request.source ||
      reversal.target_table !== target ||
      reversal.binding !== binding
    ) {
      throw new SyncError('READOPTION_REVERSAL_UNVERIFIED');
    }

    const pending = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM olos_http.corporate_id_admissions
         WHERE source_key=$1 AND NOT materialized
       ) AS exists`,
      [request.source]
    );

    if (request.requestId===allocator.request_id||request.requestId===reversal.request_id)throw new SyncError('READOPTION_REQUEST_CONFLICT');
    if (pending.rows[0]?.exists !== false) {
      throw new SyncError('READOPTION_ADMISSIONS_PENDING');
    }

    await db.query(
      `INSERT INTO olos_http.corporate_allocator_readoptions
       (
         request_id,source_key,previous_reversion_id,
         binding,target_table,evidence_ref,state
       )
       VALUES ($1,$2,$3,$4,$5,$6,'prepared')`,
      [
        request.requestId,
        request.source,
        reversal.request_id,
        binding,
        target,
        request.evidence
      ]
    );

    committing = true;
    await db.query('COMMIT');

    log('corporate_readoption_prepared',{request_id:request.requestId,previous_reversion_id:reversal.request_id});
    return {
      requestId: request.requestId,
      alreadyApplied: false
    };

  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});

    if (committing) {
      throw new SyncError('READOPTION_COMMIT_UNKNOWN');
    }

    throw error;
  }
}

export { validateReadoption,activateReadoption,abortReadoption,readoptionStatus } from './readoption-activation.js';
