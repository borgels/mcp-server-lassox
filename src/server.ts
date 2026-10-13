import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LassoClient, type LassoClientOptions } from './lasso/client.js';
import { resolveListScope } from './lasso/identity.js';
import { registerCvrTools } from './tools/cvr.js';

export interface CreateServerOptions {
  client?: LassoClient;
  clientOptions?: LassoClientOptions;
  /**
   * Gateway-verified caller email (X-MCP-User). Only honoured when
   * LASSO_TRUST_FORWARDED_USER=true; used to derive which private Lassox lists
   * the caller may see via LASSO_USER_MAP.
   */
  callerEmail?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'lassox-cvr',
    version: '0.4.0',
  });

  const client = options.client ?? new LassoClient(options.clientOptions);
  registerCvrTools(server, client, {
    getListScope: () => resolveListScope({ callerEmail: options.callerEmail }),
  });

  return server;
}
