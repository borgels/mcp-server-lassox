import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LassoClient } from '../lasso/client.js';
import { registerFinancialTrendResource } from './financial-trend/resource.js';
import { registerFinancialTrendTool } from './financial-trend/tool.js';

export function isAppsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.LASSO_APPS;
  if (!flag) return false;
  return flag === '1' || flag.toLowerCase() === 'true';
}

export function registerLassoxApps(server: McpServer, client: LassoClient): void {
  registerFinancialTrendResource(server);
  registerFinancialTrendTool(server, client);
}
