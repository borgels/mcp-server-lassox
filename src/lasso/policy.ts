import { currentInstancePolicy } from './scope.js';

/*
 * Outside a gateway call (the MCP server) the policy comes from the
 * environment: LASSO_ENABLE_WRITES. Inside a gateway call (src/lasso/scope.ts)
 * it is never read: writes follow the host's policy.enableWrites (false when
 * the host passes no policy), tools in policy.disabledTools are refused, and
 * refusals are worded for the host.
 */

export interface LassoPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'lassox_search_capabilities',
  'cvr_search',
  'cvr_segment_search',
  'cvr_get_entity',
  'cvr_batch_get_entities',
  'cvr_get_entity_history',
  'cvr_get_related',
  'cvr_get_reports',
  'cvr_get_changes',
  'lassox_financial_analysis',
  'lassox_lists_index',
  'lassox_list_get_entities',
  'cvr_get_network',
  'cvr_get_ownership_graph',
  'creditsafe_get_rating',
  'teledata_get_company_phones',
  'teledata_lookup_phone',
]);

// The only write surface in this server. It changes Lassox list membership
// (tags) — never CVR data, which stays read-only by design. Writes are off by
// default and must be enabled with LASSO_ENABLE_WRITES=true (MCP server) or
// policy.enableWrites (gateway, where list_change is enabledByDefault: false).
const ALLOWED_WRITE_TOOLS = new Set(['lassox_list_change']);

export const WRITE_TOOL_NAMES: ReadonlySet<string> = ALLOWED_WRITE_TOOLS;

/** Whether write tools may run: the host's policy inside a gateway call, LASSO_ENABLE_WRITES outside one. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const hosted = currentInstancePolicy();
  return hosted ? hosted.enableWrites : env.LASSO_ENABLE_WRITES === 'true';
}

export function checkToolPolicy(toolName: string, env: NodeJS.ProcessEnv = process.env): LassoPolicyDecision {
  const hosted = currentInstancePolicy();
  if (hosted?.disabledTools.has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance by the embedding host: ${toolName}` };
  }

  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Lassox tool' };
  }

  if (ALLOWED_WRITE_TOOLS.has(toolName)) {
    if (hosted) {
      return hosted.enableWrites
        ? { allowed: true, reason: 'writes enabled by the embedding host' }
        : { allowed: false, reason: 'writes are disabled. The embedding host has not enabled writes for this instance.' };
    }
    if (!writesEnabled(env)) {
      return { allowed: false, reason: `write tools are disabled; set LASSO_ENABLE_WRITES=true to enable ${toolName}` };
    }
    return { allowed: true, reason: 'allowlisted Lassox write tool (list membership only)' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
