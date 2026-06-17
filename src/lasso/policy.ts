export interface LassoPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'lassox_search_capabilities',
  'cvr_search',
  'cvr_get_entity',
  'cvr_batch_get_entities',
  'cvr_get_entity_history',
  'cvr_get_related',
  'cvr_get_reports',
  'lassox_financial_analysis',
  'cvr_get_network',
  'cvr_get_ownership_graph',
  'creditsafe_get_rating',
  'teledata_get_company_phones',
  'teledata_lookup_phone',
]);

export function checkToolPolicy(toolName: string): LassoPolicyDecision {
  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Lassox tool' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
