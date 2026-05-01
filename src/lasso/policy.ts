export interface LassoPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'lassox_search_capabilities',
  'cvr_search',
  'cvr_get_entity',
  'cvr_get_entity_history',
  'cvr_get_related',
]);

export function checkToolPolicy(toolName: string): LassoPolicyDecision {
  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Lassox CVR tool' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
