import { searchCapabilities } from './lasso/capabilities.js';
import { LassoClient, type LassoClientOptions } from './lasso/client.js';
import { getCvrEntity, getCvrEntityHistory, searchCvr } from './lasso/cvr.js';
import { getCvrReports, getFinancialAnalysis } from './lasso/financials.js';
import { getOwnershipGraph } from './lasso/network.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface LassoxGatewayOptions extends LassoClientOptions {}

const emptySearchInput = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'number', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const entityInput = {
  type: 'object',
  properties: {
    lassoId: { type: 'string', description: 'Lassox id such as CVR-1-34580820.' },
    entityType: { type: 'string', enum: ['company', 'productionUnit', 'person'] },
    id: { type: ['string', 'number'] },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

export const lassoxGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'search_capabilities',
    title: 'Search Lasso X capabilities',
    description: 'Find supported CVR, company intelligence, and ownership tools.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: emptySearchInput,
  },
  {
    name: 'cvr_search',
    title: 'Search CVR',
    description: 'Search Danish companies and people through Lasso X CVR data.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['company', 'person', 'all'] },
        status: { type: 'string', enum: ['active', 'inactive', 'all'] },
        pageSize: { type: 'number', minimum: 1, maximum: 100 },
        continuationToken: { type: 'string' },
        filters: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cvr_get_entity',
    title: 'Get CVR entity',
    description: 'Fetch current CVR basic information for a company, production unit, or person.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: entityInput,
  },
  {
    name: 'cvr_get_entity_history',
    title: 'Get CVR entity history',
    description: 'Fetch historical CVR basic information from Lassox.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: entityInput,
  },
  {
    name: 'cvr_get_reports',
    title: 'Get CVR reports',
    description: 'Fetch annual report key figures for a Danish company.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        lassoId: { type: 'string' },
        entityType: { type: 'string', enum: ['company'] },
        id: { type: ['string', 'number'] },
        currency: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'financial_analysis',
    title: 'Get Lasso X financial analysis',
    description: 'Run the Lasso X financial analysis module for a Danish company.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: entityInput,
  },
  {
    name: 'ownership_graph',
    title: 'Get ownership graph',
    description: 'Build an ownership and voting-rights graph for one or more CVR entities.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        relationTypes: { type: 'array', items: { type: 'string' } },
        enrichments: { type: 'array', items: { type: 'string' } },
        ingoingDepth: { type: 'number', minimum: 0, maximum: 10 },
        outgoingDepth: { type: 'number', minimum: 0, maximum: 10 },
        onDate: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

export function createLassoxGateway(options: LassoxGatewayOptions = {}) {
  const client = new LassoClient(options);

  return {
    tools: lassoxGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      switch (toolName) {
        case 'search_capabilities':
          return jsonResult('Found Lasso X capabilities.', searchCapabilities(
            stringValue(input.query) ?? '',
            numberValue(input.limit) ?? 20,
          ));

        case 'cvr_search':
          return jsonResult('Found CVR results.', await searchCvr(client, input as unknown as Parameters<typeof searchCvr>[1]));

        case 'cvr_get_entity':
          return jsonResult('Fetched CVR entity.', await getCvrEntity(client, input as Parameters<typeof getCvrEntity>[1]));

        case 'cvr_get_entity_history':
          return jsonResult('Fetched CVR entity history.', await getCvrEntityHistory(client, input as Parameters<typeof getCvrEntityHistory>[1]));

        case 'cvr_get_reports':
          return jsonResult('Fetched CVR reports.', await getCvrReports(client, input as Parameters<typeof getCvrReports>[1]));

        case 'financial_analysis':
          return jsonResult('Fetched financial analysis.', await getFinancialAnalysis(client, input as Parameters<typeof getFinancialAnalysis>[1]));

        case 'ownership_graph':
          return jsonResult('Fetched ownership graph.', await getOwnershipGraph(client, input as unknown as Parameters<typeof getOwnershipGraph>[1]));

        default:
          return errorResult(`Unsupported Lasso X gateway tool: ${toolName}`);
      }
    },
  };
}

function stringValue(value: GatewayJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: GatewayJsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
