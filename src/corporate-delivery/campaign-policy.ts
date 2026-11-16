import { eligibleOperator } from './operator-eligibility.js';

export function classifyCorporateDelivery(
  campaignId: string | number | null | undefined,
  agentId: string | null | undefined,
  operatorName: unknown
): {
  state: 'pending' | 'skipped';
  deliveryPolicyCode: string | null;
} {
  const manualCampaignIds = new Set(['25', '48']);

  if (manualCampaignIds.has(String(campaignId))) {
    return {
      state: 'skipped',
      deliveryPolicyCode: 'MANUAL_CAMPAIGN_EXCLUDED',
    };
  }

  return {
    state: eligibleOperator(agentId, operatorName)
      ? 'pending'
      : 'skipped',
    deliveryPolicyCode: null,
  };
}
