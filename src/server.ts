import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAppsEnabled, registerLassoxApps } from './apps/register.js';
import { LassoClient, type LassoClientOptions } from './lasso/client.js';
import { registerCvrTools } from './tools/cvr.js';

export interface CreateServerOptions {
  client?: LassoClient;
  clientOptions?: LassoClientOptions;
  enableApps?: boolean;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'lassox-cvr',
    version: '0.1.0',
  });

  const client = options.client ?? new LassoClient(options.clientOptions);
  registerCvrTools(server, client);

  if (options.enableApps ?? isAppsEnabled()) {
    registerLassoxApps(server, client);
  }

  return server;
}
