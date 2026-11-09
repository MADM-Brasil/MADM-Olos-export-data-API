const placeholderPattern =
  /^([0-9]+|-1|null|undefined|n\/a|unknown|desconhecido|sem operador|sem agente|não identificado|nao identificado)$/i;

export function eligibleOperator(
  agentId: string | null | undefined,
  operatorName: unknown
): boolean {
  if (!agentId || !/^[1-9][0-9]*$/.test(agentId)) {
    return false;
  }

  if (typeof operatorName !== 'string') {
    return false;
  }

  const name = operatorName.trim();

  return name.length > 0 && !placeholderPattern.test(name);
}
