export type CapabilityRisk = 'read';

export interface LassoCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const LASSO_CAPABILITIES: LassoCapability[] = [
  {
    id: 'lassox_search_capabilities',
    title: 'Search Lassox Capabilities',
    description: 'Find the Lassox MCP tool to use for CVR lookup, history, relations, or search.',
    risk: 'read',
    examples: [{ query: 'company search' }],
    identifierFormats: ['Tool id such as cvr_search or cvr_get_entity.'],
    safetyNotes: ['Discovery only. Does not call Lassox.'],
    keywords: ['discover', 'search tools', 'help', 'capabilities'],
  },
  {
    id: 'cvr_search',
    title: 'Search CVR',
    description:
      'Search Lassox CVR companies and people. Use this to find Lasso IDs before fetching full records.',
    risk: 'read',
    examples: [{ query: 'Lasso X', type: 'company', pageSize: 5 }],
    identifierFormats: ['Free text', 'CVR number', 'phone number', 'Lasso ID'],
    safetyNotes: ['Read-only. Returns Lassox pagination fields and scores unchanged.'],
    keywords: ['search', 'company', 'person', 'cvr', 'lookup'],
  },
  {
    id: 'cvr_get_entity',
    title: 'Get CVR Entity',
    description:
      'Fetch current CVR basic information for a company, production unit, or person.',
    risk: 'read',
    examples: [{ entityType: 'company', id: '34580820' }, { lassoId: 'CVR-1-34580820' }],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}', 'CVR-3-{personId}'],
    safetyNotes: ['Read-only. Does not fetch historical field wrappers.'],
    keywords: ['current', 'entity', 'company', 'production unit', 'person'],
  },
  {
    id: 'cvr_get_entity_history',
    title: 'Get CVR Entity History',
    description: 'Fetch historical CVR basic information for a company, production unit, or person.',
    risk: 'read',
    examples: [{ lassoId: 'CVR-1-34580820' }],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}', 'CVR-3-{personId}'],
    safetyNotes: ['Read-only. Historical responses are returned unchanged from Lassox.'],
    keywords: ['history', 'historical', 'entity', 'changes'],
  },
  {
    id: 'cvr_get_related',
    title: 'Get Related CVR Entities',
    description:
      'Fetch documented related entities: company to person/place, or production unit to company.',
    risk: 'read',
    examples: [{ entityType: 'company', id: '34580820', relatedType: 'person' }],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}'],
    safetyNotes: ['Read-only. Unsupported relation combinations are rejected before calling Lassox.'],
    keywords: ['related', 'relation', 'person', 'place', 'production unit'],
  },
];

export function searchCapabilities(query: string, limit = 20): LassoCapability[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return LASSO_CAPABILITIES.slice(0, limit);
  }

  return LASSO_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: LassoCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
