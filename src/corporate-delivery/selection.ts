import { campaignAdmissionSql } from '../corporate-sync/campaign-policy.js';

// Match JavaScript trim semantics for operator admission.
const operatorNameWhitespace =
  '\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680' +
  '\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007' +
  '\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';

const operatorNamePlaceholderPattern =
  '^([0-9]+|-1|null|undefined|n/a|unknown|desconhecido|sem operador|sem agente|não identificado|nao identificado)$';

// Shared by automatic delivery and administrative verification (same SQL semantics).
export function pendingAdmission(firstParameter: number) {
  const campaign = campaignAdmissionSql("o.payload->>'nome_campanha_olos'", firstParameter + 2);
  return {
    sql: `r.agent_id ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(o.payload->'nome_agente')='string'
      AND btrim(o.payload->>'nome_agente',$${firstParameter})<>''
      AND btrim(o.payload->>'nome_agente',$${firstParameter}) !~* $${firstParameter + 1}
      AND jsonb_typeof(o.payload->'nome_campanha_olos')='string'
      AND ${campaign.sql}`,
    parameters: [operatorNameWhitespace, operatorNamePlaceholderPattern, ...campaign.parameters],
  };
}
