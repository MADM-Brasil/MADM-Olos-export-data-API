export type ReadoptionState =
  | 'prepared'
  | 'validating'
  | 'ready'
  | 'activating'
  | 'active'
  | 'aborted';

export interface ReadoptionRequest {
  readonly source: string;
  readonly requestId: string;
  readonly evidence: string;
}

export interface ReadoptionRecord {
  readonly request_id: string;
  readonly source_key: string;
  readonly previous_reversion_id: string;
  readonly binding: string;
  readonly target_table: string;
  readonly evidence_ref: string;
  readonly state: ReadoptionState;
  readonly validated_at: Date | null;
  readonly validation_digest: string | null;
}

export function isReadoptionState(
  value: unknown
): value is ReadoptionState {
  return (
    value === 'prepared' ||
    value === 'validating' ||
    value === 'ready' ||
    value === 'activating' ||
    value === 'active' ||
    value === 'aborted'
  );
}

export interface QuarantineIdentity {
 readonly source_id:string; readonly target_id:string; readonly source_hash:string; readonly payload_hash:string; readonly request_id:string;
}
export interface ReadoptionProgress extends ReadoptionRecord {
 readonly previous_adoption_id:string|null;
 readonly predecessor_digest:string|null;
 readonly predecessor_snapshot:unknown;
 readonly quarantine_manifest:QuarantineIdentity[]|null;
 readonly remote_contract_hash:string|null;
 readonly remote_schema_hash:string|null;
 readonly registration_cursor:string|null;
 readonly registration_end:string|null;
 readonly registration_digest:string|null;
 readonly registered_count:string;
 readonly batch_count:number;
 readonly barrier_at:Date|null;
 readonly activated_at:Date|null;
 readonly last_error:string|null;
}
export interface ReadoptionActivation extends ReadoptionRequest { readonly validation:string; readonly maxBatches:number }
export interface ReadoptionHooks {
 afterValidationIntent?:()=>Promise<void>;
 beforeValidationCommit?:()=>Promise<void>;
 beforeBarrierCommit?:()=>Promise<void>;
 afterBarrierCommit?:()=>Promise<void>;
 afterReserveCommit?:()=>Promise<void>;
 beforeBatchCommit?:()=>Promise<void>;
 afterBatchCommit?:()=>Promise<void>;
 beforeActiveCommit?:()=>Promise<void>;
}
export interface ReadoptionResult {
 readonly requestId:string; readonly state:ReadoptionState; readonly completed:boolean; readonly alreadyApplied:boolean;
 readonly registered:string; readonly batches:number;
}
