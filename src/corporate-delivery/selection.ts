import { parsePreservedHistory, validatePreservedHistory } from './preserved-history.js';
import { SyncError } from '../corporate-sync/errors.js';
import type { DeliveryConfig } from './config.js';

export interface DeliverySelection {
  sourceIds: readonly string[];
  confirmation: string;
  historyReadId?: string;
}

// Deliberately independent of the authorization for the general queue. Bind consent
// to the exact ordered list; never infer IDs from target_id, a range or a LIMIT.
export function validateSelection(cfg: DeliveryConfig | undefined, selection: DeliverySelection, action: 'delivery' | 'reconciliation' = 'delivery', attemptId?: string): string[] {
  if (!cfg) throw new SyncError('CORPORATE_MODE_REQUIRED');
  if (cfg.connection.writeEnabled) throw new SyncError('SELECTIVE_REQUIRES_GENERAL_WRITE_DISABLED');
  const ids = [...selection.sourceIds];
  validatePreservedHistory(selection.historyReadId, ids);
  if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) {
    throw new SyncError('SELECTIVE_SOURCE_IDS_INVALID');
  }
  const authorization = action === 'delivery' ? 'AUTHORIZE_EXPORTDATA_SELECTIVE_DELIVERY' : `AUTHORIZE_EXPORTDATA_SELECTIVE_RECONCILIATION:${attemptId}`;
  if (action === 'reconciliation' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId ?? '')) {
    throw new SyncError('SELECTIVE_ATTEMPT_ID_INVALID');
  }
  if (selection.confirmation !== `${authorization}:${ids.join(',')}`) {
    throw new SyncError('SELECTIVE_WRITE_NOT_AUTHORIZED');
  }
  return ids;
}

export function parseSelection(cfg: DeliveryConfig | undefined, args: string[]): DeliverySelection {
  const { args: parameters, ...history } = parsePreservedHistory(args);
  args = parameters;
  if (args.length !== 4 || args[0] !== '--source-ids' || args[2] !== '--confirm') {
    throw new SyncError('SELECTIVE_PARAMETERS_INVALID');
  }
  const selection = { ...history, sourceIds: args[1]!.split(','), confirmation: args[3]! };
  validateSelection(cfg, selection);
  return selection;
}

export interface ReconciliationSelection extends DeliverySelection { attemptId: string }
export function parseReconciliation(cfg: DeliveryConfig | undefined, args: string[]): ReconciliationSelection {
  const { args: parameters, ...history } = parsePreservedHistory(args);
  args = parameters;
  if (args.length !== 6 || args[0] !== '--source-ids' || args[2] !== '--attempt-id' || args[4] !== '--confirm') {
    throw new SyncError('SELECTIVE_PARAMETERS_INVALID');
  }
  const selection = { ...history, sourceIds: args[1]!.split(','), attemptId: args[3]!, confirmation: args[5]! };
  validateSelection(cfg, selection, 'reconciliation', selection.attemptId);
  return selection;
}
