import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
  }
}

export interface HttpConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
  httpToken?: string;
}

export function getHttpConfig(): HttpConfig {
  return {
    host: process.env.MCP_HTTP_HOST ?? process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    maxBodyBytes: Number(process.env.MCP_MAX_BODY_BYTES ?? 10_485_760),
    httpToken: process.env.MCP_HTTP_TOKEN || undefined,
  };
}

export function assertAuthorized(req: IncomingMessage, config = getHttpConfig()): void {
  if (!config.httpToken) {
    return;
  }

  if (!safeEqual(req.headers.authorization ?? '', `Bearer ${config.httpToken}`)) {
    throw new HttpRequestError(401, 'Unauthorized');
  }
}

/** Constant-time string comparison (hashing both sides equalises lengths). */
export function safeEqual(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Env flags that make this server trust a gateway-forwarded identity header. */
export const TRUST_FORWARDED_USER_ENV_VARS = ['LASSO_TRUST_FORWARDED_USER'] as const;

/**
 * Refuses to start the HTTP transport when a forwarded identity is trusted but
 * no MCP_HTTP_TOKEN protects the endpoint — otherwise any client that can reach
 * the port could assert any identity.
 */
export function assertSafeStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const trusting = TRUST_FORWARDED_USER_ENV_VARS.filter(name => env[name] === 'true');
  if (trusting.length > 0 && !env.MCP_HTTP_TOKEN) {
    throw new Error(
      `${trusting.join(', ')}=true requires MCP_HTTP_TOKEN to be set. Refusing to start: without it any client could impersonate any user via X-MCP-User.`,
    );
  }
}

/**
 * Returns the gateway-verified caller identity when LASSO_TRUST_FORWARDED_USER
 * is enabled. Fails closed (401) when trust is enabled and the header is
 * missing, empty or repeated. Returns undefined when trust is disabled (the
 * header is ignored).
 */
export function getForwardedUser(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LASSO_TRUST_FORWARDED_USER !== 'true') {
    return undefined;
  }

  const header = req.headers['x-mcp-user'];
  const value = typeof header === 'string' ? header.trim() : '';
  if (!value) {
    throw new HttpRequestError(401, 'Missing verified caller identity (X-MCP-User).');
  }

  return value;
}

export function assertAllowedOrigin(req: IncomingMessage): void {
  if (!isOriginAllowed(req.headers.origin)) {
    throw new HttpRequestError(403, 'Origin not allowed');
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes = getHttpConfig().maxBodyBytes,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  req?: IncomingMessage,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
  };

  if (process.env.MCP_ALLOW_ANY_ORIGIN === 'true') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin || process.env.MCP_ALLOW_ANY_ORIGIN === 'true') {
    return true;
  }

  const configuredOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (configuredOrigins.length) {
    return configuredOrigins.includes(origin);
  }

  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}
