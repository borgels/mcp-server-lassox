import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import { checkToolPolicy } from '../src/lasso/policy.js';
import { isAppsEnabled, registerLassoxApps } from '../src/apps/register.js';
import { FINANCIAL_TREND_TOOL_NAME } from '../src/apps/financial-trend/tool.js';
import {
  FINANCIAL_TREND_MIME_TYPE,
  FINANCIAL_TREND_RESOURCE_URI,
} from '../src/apps/financial-trend/resource.js';
import { FINANCIAL_TREND_WIDGET_HTML } from '../src/apps/financial-trend/widget.js';
import { transformFinancialTrend } from '../src/apps/financial-trend/transform.js';

describe('financial trend transform', () => {
  it('extracts revenue / gross profit / net result keyed by year from a wrapped list', () => {
    const data = transformFinancialTrend({
      lassoId: 'CVR-1-34580820',
      years: 4,
      rawReports: {
        entity: { name: 'Lasso X ApS' },
        currency: 'DKK',
        reports: [
          { periodEnd: '2021-12-31', revenue: 1_000_000, grossProfit: 400_000, profitLossForPeriod: 80_000 },
          { periodEnd: '2022-12-31', revenue: 1_500_000, grossProfit: 600_000, profitLossForPeriod: 120_000 },
          { periodEnd: '2023-12-31', revenue: 2_100_000, grossProfit: 900_000, profitLossForPeriod: 200_000 },
          { periodEnd: '2024-12-31', revenue: 2_400_000, grossProfit: 1_050_000, profitLossForPeriod: 240_000 },
        ],
      },
    });

    expect(data.company).toEqual({ lassoId: 'CVR-1-34580820', name: 'Lasso X ApS', cvr: '34580820' });
    expect(data.currency).toBe('DKK');
    expect(data.reports.map(r => r.year)).toEqual([2021, 2022, 2023, 2024]);
    expect(data.reports[3]).toEqual({
      year: 2024,
      revenue: 2_400_000,
      grossProfit: 1_050_000,
      profitLossForPeriod: 240_000,
    });
  });

  it('handles {value, unit} field wrappers and a bare array response', () => {
    const data = transformFinancialTrend({
      lassoId: 'CVR-1-12345678',
      years: 4,
      rawReports: [
        {
          year: 2022,
          revenue: { value: 500, unit: 'EUR' },
          grossProfit: { value: 200, unit: 'EUR' },
          profitLossForPeriod: { value: 30, unit: 'EUR' },
        },
        {
          year: 2023,
          revenue: { value: 700, unit: 'EUR' },
          grossProfit: { value: 250, unit: 'EUR' },
          profitLossForPeriod: { value: 50, unit: 'EUR' },
        },
      ],
    });

    expect(data.currency).toBe('EUR');
    expect(data.reports).toHaveLength(2);
    expect(data.reports[0]).toMatchObject({ year: 2022, revenue: 500, grossProfit: 200, profitLossForPeriod: 30 });
  });

  it('trims to the requested number of years and keeps the most recent', () => {
    const data = transformFinancialTrend({
      lassoId: 'CVR-1-00000001',
      years: 2,
      rawReports: {
        reports: [
          { periodEnd: '2020-12-31', revenue: 1 },
          { periodEnd: '2021-12-31', revenue: 2 },
          { periodEnd: '2022-12-31', revenue: 3 },
          { periodEnd: '2023-12-31', revenue: 4 },
        ],
      },
    });

    expect(data.reports.map(r => r.year)).toEqual([2022, 2023]);
  });

  it('treats missing nøgletal as null without crashing', () => {
    const data = transformFinancialTrend({
      lassoId: 'CVR-1-00000002',
      years: 4,
      rawReports: {
        reports: [
          { periodEnd: '2023-12-31', revenue: 100 },
          { periodEnd: '2024-12-31' },
        ],
      },
    });

    expect(data.reports).toEqual([
      { year: 2023, revenue: 100, grossProfit: null, profitLossForPeriod: null },
      { year: 2024, revenue: null, grossProfit: null, profitLossForPeriod: null },
    ]);
  });

  it('returns an empty report list when Lassox returns an unrelated payload', () => {
    const data = transformFinancialTrend({
      lassoId: 'CVR-1-99999999',
      years: 4,
      rawReports: { error: 'not found' },
    });

    expect(data.reports).toEqual([]);
    expect(data.company.cvr).toBe('99999999');
  });
});

describe('apps feature flag', () => {
  it('only enables apps when LASSO_APPS=1 or LASSO_APPS=true', () => {
    expect(isAppsEnabled({})).toBe(false);
    expect(isAppsEnabled({ LASSO_APPS: '' })).toBe(false);
    expect(isAppsEnabled({ LASSO_APPS: '0' })).toBe(false);
    expect(isAppsEnabled({ LASSO_APPS: '1' })).toBe(true);
    expect(isAppsEnabled({ LASSO_APPS: 'true' })).toBe(true);
    expect(isAppsEnabled({ LASSO_APPS: 'TRUE' })).toBe(true);
  });
});

describe('financial trend MCP Apps wiring', () => {
  it('registers a ui:// resource with the MCP Apps mime type', () => {
    const { resources } = captureRegistrations();
    const widget = resources[FINANCIAL_TREND_RESOURCE_URI];

    expect(widget).toBeDefined();
    expect(widget?.config.mimeType).toBe(FINANCIAL_TREND_MIME_TYPE);
    expect(widget?.config.mimeType).toMatch(/profile=mcp-app/);
    expect(widget?.uri).toBe('ui://lassox/financial-trend');
  });

  it('serves the widget HTML when the resource is read', async () => {
    const { resources } = captureRegistrations();
    const widget = resources[FINANCIAL_TREND_RESOURCE_URI];
    if (!widget) throw new Error('widget resource was not registered');

    const result = await widget.readCallback(new URL(FINANCIAL_TREND_RESOURCE_URI));
    expect(result.contents).toHaveLength(1);
    const first = result.contents[0];
    if (!first) throw new Error('expected resource contents');
    expect(first).toMatchObject({
      uri: FINANCIAL_TREND_RESOURCE_URI,
      mimeType: FINANCIAL_TREND_MIME_TYPE,
    });
    expect(first.text).toBe(FINANCIAL_TREND_WIDGET_HTML);
    expect(first.text).toContain('postMessage');
    expect(first.text).not.toContain('window.openai');
  });

  it('links the tool to the widget via _meta and registers structured output', () => {
    const { tools } = captureRegistrations();
    const tool = tools[FINANCIAL_TREND_TOOL_NAME];

    expect(tool).toBeDefined();
    expect(tool?.config.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool?.config._meta).toEqual({
      'io.modelcontextprotocol/ui': {
        resourceUri: FINANCIAL_TREND_RESOURCE_URI,
      },
    });
  });

  it('allowlists the new tool in the read-only policy', () => {
    expect(checkToolPolicy(FINANCIAL_TREND_TOOL_NAME)).toMatchObject({ allowed: true });
  });

  it('returns both a text fallback and structuredContent from the tool handler', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entity: { name: 'Test ApS' },
          currency: 'DKK',
          reports: [
            { periodEnd: '2022-12-31', revenue: 100, grossProfit: 40, profitLossForPeriod: 5 },
            { periodEnd: '2023-12-31', revenue: 150, grossProfit: 70, profitLossForPeriod: 12 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { tools } = captureRegistrations(client);
    const tool = tools[FINANCIAL_TREND_TOOL_NAME];
    if (!tool) throw new Error('tool not registered');

    const result = await tool.handler({ lassoId: 'CVR-1-34580820', years: 4 });
    const textBlock = result.content[0];
    if (!textBlock) throw new Error('expected at least one content block');

    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toContain('Test ApS');
    expect(textBlock.text).toContain('| 2023 |');
    expect(result.structuredContent).toMatchObject({
      source: 'lassox-reports',
      company: { lassoId: 'CVR-1-34580820', cvr: '34580820', name: 'Test ApS' },
      currency: 'DKK',
      reports: [
        { year: 2022, revenue: 100, grossProfit: 40, profitLossForPeriod: 5 },
        { year: 2023, revenue: 150, grossProfit: 70, profitLossForPeriod: 12 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-company Lasso IDs before calling Lassox', async () => {
    const fetchMock = vi.fn();
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { tools } = captureRegistrations(client);
    const tool = tools[FINANCIAL_TREND_TOOL_NAME];
    if (!tool) throw new Error('tool not registered');

    await expect(tool.handler({ lassoId: 'CVR-3-1234567', years: 4 })).rejects.toThrow(/compan/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

interface CapturedTool {
  config: { annotations?: unknown; _meta?: unknown };
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

interface CapturedResource {
  uri: string;
  config: { mimeType?: string; _meta?: unknown };
  readCallback: (uri: URL) => Promise<{
    contents: Array<{ uri: string; mimeType?: string; text: string }>;
  }>;
}

function captureRegistrations(client?: LassoClient) {
  const tools: Record<string, CapturedTool> = {};
  const resources: Record<string, CapturedResource> = {};
  const server = {
    registerTool: vi.fn((name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) => {
      tools[name] = { config, handler };
    }),
    registerResource: vi.fn(
      (
        _name: string,
        uri: string,
        config: CapturedResource['config'],
        readCallback: CapturedResource['readCallback'],
      ) => {
        resources[uri] = { uri, config, readCallback };
      },
    ),
  };

  const lassoClient =
    client ??
    new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

  registerLassoxApps(server as never, lassoClient);

  return { tools, resources };
}
