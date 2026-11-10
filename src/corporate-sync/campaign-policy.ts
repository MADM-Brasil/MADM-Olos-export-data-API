import { SyncError } from './errors.js';

// Campaign.Description mapped to nome_campanha_olos. No inferred/Billing IDs.
export const manualCampaignNames = ['ligacao manual','ligacao manual gs'] as const;
export const campaignWhitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export type CampaignPolicyCode = 'MANUAL_CAMPAIGN_EXCLUDED'|'CAMPAIGN_IDENTIFICATION_REQUIRED';
export function campaignPolicyCode(name:unknown):CampaignPolicyCode|null {
  if(typeof name!=='string')return 'CAMPAIGN_IDENTIFICATION_REQUIRED';
  const normalized=name.trim().replace(/\s+/gu,' ').toLowerCase();
  if(!normalized)return 'CAMPAIGN_IDENTIFICATION_REQUIRED';
  return manualCampaignNames.some(blocked=>blocked===normalized)?'MANUAL_CAMPAIGN_EXCLUDED':null;
}
export function assertCampaignAllowed(name:unknown):void {
  const code=campaignPolicyCode(name);if(code)throw new SyncError(code);
}
export function isCampaignPolicyError(error:unknown):boolean {
  return error instanceof SyncError&&['MANUAL_CAMPAIGN_EXCLUDED','CAMPAIGN_IDENTIFICATION_REQUIRED'].includes(error.code);
}
// Same whitespace set/case comparison as JS. Callers provide static expressions,
// not input SQL. JSON callers additionally require a JSON string value.
export function campaignAdmissionSql(expression:string,parameter:number):{sql:string;parameters:unknown[]} {
  const trimmed=`(btrim(${expression},$${parameter}) COLLATE "C")`;
  return {sql:`(${trimmed}<>'' AND lower(regexp_replace(${trimmed},$${parameter+1},' ','g'))<>ALL($${parameter+2}::text[]))`,
    parameters:[campaignWhitespace,`[${campaignWhitespace}]+`,[...manualCampaignNames]]};
}
