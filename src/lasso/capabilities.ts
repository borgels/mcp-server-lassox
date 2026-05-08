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
  {
    id: 'cvr_get_reports',
    title: 'Get CVR Reports (Key Figures / Nøgletal)',
    description:
      'Fetch annual report key figures (nøgletal) for a Danish company, converted by Lassox from XBRL.',
    risk: 'read',
    examples: [
      { entityType: 'company', id: '34580820' },
      { lassoId: 'CVR-1-34580820', currency: 'EUR' },
    ],
    identifierFormats: ['CVR-1-{cvr}'],
    safetyNotes: [
      'Read-only. Only company Lasso IDs (CVR-1-*) are accepted.',
      'Optional ISO 4217 currency code triggers Lassox currency conversion.',
    ],
    keywords: [
      'reports',
      'nøgletal',
      'key figures',
      'finance',
      'financial',
      'xbrl',
      'annual report',
      'regnskab',
      'ebitda',
    ],
  },
  {
    id: 'cvr_get_network',
    title: 'Get CVR Person Network',
    description:
      'Fetch a person\'s professional network from Lassox: connected companies, current roles, and time-overlapping relations with other people.',
    risk: 'read',
    examples: [
      { entityType: 'person', id: '4004094652' },
      { lassoId: 'CVR-3-4004094652' },
    ],
    identifierFormats: ['CVR-3-{personId}'],
    safetyNotes: [
      'Read-only. Only person Lasso IDs (CVR-3-*) are accepted.',
      'Lassox Module API. May require a separate subscription.',
    ],
    keywords: ['network', 'netværk', 'person', 'roles', 'connections', 'professional'],
  },
  {
    id: 'cvr_get_ownership_graph',
    title: 'Get CVR Ownership / Voting Graph',
    description:
      'Build an ownership and voting-rights graph for one or more entities, with optional enrichment (company info, person info, financial reports, ultimate owners).',
    risk: 'read',
    examples: [
      {
        ids: ['CVR-1-34580820'],
        relationTypes: ['ownership'],
        enrichments: ['companyinfo', 'ultimateOwners'],
        outgoingDepth: 2,
      },
    ],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}', 'CVR-3-{personId}'],
    safetyNotes: [
      'Read-only. Lassox Module API; may require a separate subscription.',
      'Higher depth values traverse more edges and increase response size — start small.',
      'Up to 25 seed ids and depth 0-10 are accepted.',
    ],
    keywords: [
      'ownership',
      'ejerstruktur',
      'voting',
      'votingrights',
      'ubo',
      'ultimate owners',
      'beneficial',
      'graph',
      'shareholders',
    ],
  },
  {
    id: 'creditsafe_get_rating',
    title: 'Get Creditsafe Rating',
    description:
      'Fetch the Creditsafe credit rating for a Danish company via Lassox. Returns current and previous scores, descriptions, credit max, currency, and a PDF link.',
    risk: 'read',
    examples: [
      { cvr: '34580820' },
      { lassoId: 'CVR-1-34580820', skipCache: true },
    ],
    identifierFormats: ['8-digit CVR', 'CVR-1-{cvr}'],
    safetyNotes: [
      'Read-only. Lassox caches Creditsafe responses for 24 hours.',
      'skipCache=true forces a fresh upstream call and may incur extra cost.',
    ],
    keywords: ['creditsafe', 'credit', 'rating', 'kredit', 'score', 'risk', 'due diligence'],
  },
  {
    id: 'teledata_get_company_phones',
    title: 'Get Company Phone Numbers (Teledata)',
    description: 'Fetch phone numbers registered to a Danish company via the Lassox Teledata API.',
    risk: 'read',
    examples: [{ entityType: 'company', id: '34580820' }, { lassoId: 'CVR-1-34580820' }],
    identifierFormats: ['CVR-1-{cvr}'],
    safetyNotes: ['Read-only. Only company Lasso IDs are accepted.'],
    keywords: ['teledata', 'phone', 'phonenumbers', 'telefon', 'numbers', 'subscriber'],
  },
  {
    id: 'teledata_lookup_phone',
    title: 'Lookup Phone Number Owner (Teledata)',
    description:
      'Reverse-lookup a Danish phone number via Lassox Teledata. Returns subscriber name, address, supplier, and protection codes.',
    risk: 'read',
    examples: [
      { phoneNumber: '70201020' },
      { phoneNumber: '+4570201020', includeCompany: true },
    ],
    identifierFormats: ['6-15 digit phone number, optional + prefix'],
    safetyNotes: [
      'Read-only. Returns publicly-registered subscriber data; respect Danish privacy rules.',
      'Set includeCompany=true to enrich with CVR data when the number belongs to a company.',
    ],
    keywords: ['teledata', 'phone', 'lookup', 'reverse', 'telefon', 'subscriber', 'owner'],
  },
  {
    id: 'lassox_financial_analysis',
    title: 'Get Lassox Financial Analysis',
    description:
      'Run the Lassox Financial Analysis (Regnskabsanalyse) module on a Danish company. Returns HTML-formatted textual analysis plus the latest and previous reports.',
    risk: 'read',
    examples: [
      { entityType: 'company', id: '34580820' },
      { lassoId: 'CVR-1-34580820' },
    ],
    identifierFormats: ['CVR-1-{cvr}'],
    safetyNotes: [
      'Read-only. Only company Lasso IDs (CVR-1-*) are accepted.',
      'Lassox Module API. May require a separate subscription on your Lassox account.',
      'Response text contains HTML formatting tags such as <br/> and <ul>.',
    ],
    keywords: [
      'financial analysis',
      'regnskabsanalyse',
      'module',
      'analysis',
      'credit',
      'ebitda',
      'working capital',
    ],
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
