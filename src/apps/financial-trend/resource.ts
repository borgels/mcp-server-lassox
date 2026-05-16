import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FINANCIAL_TREND_WIDGET_HTML } from './widget.js';

export const FINANCIAL_TREND_RESOURCE_URI = 'ui://lassox/financial-trend';
export const FINANCIAL_TREND_MIME_TYPE = 'text/html;profile=mcp-app';

export function registerFinancialTrendResource(server: McpServer): void {
  server.registerResource(
    'lassox-financial-trend-widget',
    FINANCIAL_TREND_RESOURCE_URI,
    {
      title: 'Lassox financial trend chart',
      description:
        'Inline UI widget for the lassox_financial_chart tool. Renders revenue, gross profit, and net result for the last few annual reports as a line chart. Loaded by MCP Apps-capable hosts via the ui:// scheme; safe to ignore in classic MCP clients.',
      mimeType: FINANCIAL_TREND_MIME_TYPE,
      _meta: {
        'io.modelcontextprotocol/ui': {
          prefersBorder: true,
        },
      },
    },
    async uri => ({
      contents: [
        {
          uri: uri.href,
          mimeType: FINANCIAL_TREND_MIME_TYPE,
          text: FINANCIAL_TREND_WIDGET_HTML,
        },
      ],
    }),
  );
}
