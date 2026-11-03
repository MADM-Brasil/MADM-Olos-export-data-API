// Admission policy only: never normalize names, replace IDs or rewrite frozen payloads.
// AgentId is lossless text. Require a canonical positive decimal integer, without
// Number coercion (CallId and AttemptsRawDataID are independent identifiers).
export const identifiedAgentPattern = '^[1-9][0-9]*$';
// Explicit ECMAScript trim characters keep PostgreSQL btrim and JS in agreement,
// independently of the database locale, including tabs and nonbreaking spaces.
export const operatorNameWhitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const agentPattern = new RegExp(identifiedAgentPattern);
export function hasIdentifiedOperator(entry: { agent_id: unknown; payload: Record<string, unknown> }): boolean {
  return typeof entry.agent_id === 'string' && agentPattern.exec(entry.agent_id)?.[0] === entry.agent_id &&
    typeof entry.payload.nome_agente === 'string' && entry.payload.nome_agente.trim().length > 0;
}
