import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { LassoClient } from '../../lasso/client.js';
import { parseCvrEntityInput } from '../../lasso/cvr.js';
import { assertCompanyLassoId, getCvrReports } from '../../lasso/financials.js';
import { TOOL_ANNOTATIONS } from '../../lasso/capabilities.js';
import { writeAuditEvent } from '../../lasso/audit.js';
import { checkToolPolicy } from '../../lasso/policy.js';
import { formatUnknownError } from '../../errors.js';
import { transformFinancialTrend, type FinancialTrendData } from './transform.js';
import { FINANCIAL_TREND_RESOURCE_URI } from './resource.js';

export const FINANCIAL_TREND_TOOL_NAME = 'lassox_financial_chart';

const inputSchema = {
  lassoId: z
    .string()
    .trim()
    .regex(/^CVR-1-\d+$/, 'Use a CVR company Lasso ID like CVR-1-34580820.')
    .optional(),
  entityType: z.literal('company').optional(),
  id: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  years: z.number().int().min(1).max(20).default(4),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Use an ISO 4217 currency code such as DKK, EUR, or USD.')
    .optional(),
};

export function registerFinancialTrendTool(server: McpServer, client: LassoClient): void {
  server.registerTool(
    FINANCIAL_TREND_TOOL_NAME,
    {
      title: 'Lassox Financial Trend Chart',
      description:
        'Returns a narrow time-series of revenue (omsætning), gross profit (bruttofortjeneste), and net result (årets resultat) for a Danish company\'s last N annual reports, ready for chart rendering. Use this when the user asks for a financial trend or graph; otherwise prefer cvr_get_reports for the full Lassox payload. MCP Apps clients render the accompanying ui://lassox/financial-trend widget inline.',
      inputSchema,
      annotations: TOOL_ANNOTATIONS,
      _meta: {
        'io.modelcontextprotocol/ui': {
          resourceUri: FINANCIAL_TREND_RESOURCE_URI,
        },
      },
    },
    async input => {
      const policy = checkToolPolicy(FINANCIAL_TREND_TOOL_NAME);
      const target = { lassoId: input.lassoId, entityType: input.entityType, id: input.id, years: input.years, currency: input.currency };

      if (!policy.allowed) {
        await writeAuditEvent({
          tool: FINANCIAL_TREND_TOOL_NAME,
          action: 'policy_denied',
          target,
          reason: policy.reason,
        });
        throw new Error(policy.reason);
      }

      await writeAuditEvent({
        tool: FINANCIAL_TREND_TOOL_NAME,
        action: 'start',
        target,
        reason: policy.reason,
      });

      try {
        const lassoId = parseCvrEntityInput(input);
        assertCompanyLassoId(lassoId);

        const rawReports = await getCvrReports(client, {
          lassoId,
          currency: input.currency,
        });

        const data = transformFinancialTrend({
          lassoId,
          years: input.years,
          rawReports,
        });

        await writeAuditEvent({
          tool: FINANCIAL_TREND_TOOL_NAME,
          action: 'finish',
          target,
          status: 'ok',
        });

        return buildToolResult(data);
      } catch (error) {
        await writeAuditEvent({
          tool: FINANCIAL_TREND_TOOL_NAME,
          action: 'error',
          target,
          status: 'error',
          error: formatUnknownError(error),
        });
        throw error;
      }
    },
  );
}

function buildToolResult(data: FinancialTrendData) {
  return {
    content: [
      {
        type: 'text' as const,
        text: buildTextSummary(data),
      },
    ],
    structuredContent: data as unknown as Record<string, unknown>,
  };
}

function buildTextSummary(data: FinancialTrendData): string {
  const header = `Financial trend for ${data.company.name ?? data.company.lassoId}${
    data.company.cvr ? ` (CVR ${data.company.cvr})` : ''
  }${data.currency ? ` — ${data.currency}` : ''}`;

  if (data.reports.length === 0) {
    return `${header}\n\nNo annual reports available from Lassox for the requested period.`;
  }

  const rows = data.reports
    .map(row => {
      const cells = [
        String(row.year),
        formatCell(row.revenue),
        formatCell(row.grossProfit),
        formatCell(row.profitLossForPeriod),
      ];
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');

  return [
    header,
    '',
    '| Year | Revenue | Gross profit | Net result |',
    '| --- | ---: | ---: | ---: |',
    rows,
    '',
    'MCP Apps-capable clients (Inspector, ChatGPT Apps SDK hosts, etc.) render an inline chart from this tool\'s structured output via ui://lassox/financial-trend.',
  ].join('\n');
}

function formatCell(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}
