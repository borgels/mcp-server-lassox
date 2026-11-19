import { ConfigError, readEnvInteger } from '../config-env.js';
import { LassoHttpError, limitDepth } from '../errors.js';
import { describeUrl, discardBody, isRedirect, registerSecret, SecretRedactor } from '../upstream-http.js';

/** Lasso X's production API. */
export const DEFAULT_BASE_URL = 'https://api.lassox.com';
/** Default request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface LassoClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Where a missing apiKey, baseUrl or timeoutMs is read from. Default
   * process.env (the MCP server). The gateway passes {}: an embedded instance
   * never reads LASSO_API_KEY, LASSO_BASE_URL or LASSO_TIMEOUT_MS.
   */
  credentialEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * The instance's own redactor (the gateway). Without one the key is
   * redacted by the MCP server's process-wide redactor.
   */
  redactor?: SecretRedactor;
}

export type QueryValue = string | number | boolean | null | undefined;

export class LassoClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  /** Redacts this client's key; the gateway runs every call with it in scope. */
  readonly redactor: SecretRedactor;

  constructor(options: LassoClientOptions = {}) {
    const env = options.credentialEnv ?? process.env;
    this.apiKey = options.apiKey ?? env.LASSO_API_KEY;
    this.redactor = options.redactor ?? new SecretRedactor();
    this.redactor.addSecret(this.apiKey);
    if (!options.redactor) {
      // The MCP server: its errors are redacted outside any call scope.
      registerSecret(this.apiKey);
    }
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? env.LASSO_BASE_URL ?? DEFAULT_BASE_URL);
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs =
      options.timeoutMs ?? readEnvInteger('LASSO_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { max: MAX_TIMEOUT_MS }, { ...env });
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new ConfigError('timeoutMs must be a positive integer of at most 600000.');
    }
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T>(
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    return this.request<T>('POST', path, query, body);
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error('Missing LASSO_API_KEY. Set it in the MCP server environment.');
    }

    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'lasso-api-key': this.apiKey,
    };

    const init: RequestInit = {
      method,
      headers,
      // Never follow redirects: fetch would re-send the custom lasso-api-key
      // header to wherever the Location points, including other origins.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw transportError(error, method, this.timeoutMs);
    }

    if (response.type === 'opaqueredirect' || isRedirect(response.status)) {
      // The Location is Lasso X's text and is never quoted, and the address is configuration.
      await discardBody(response);
      throw new Error(
        `Lasso X API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
          'redirects are not followed, so the key is never sent to another host. Check the configured base URL.',
      );
    }

    if (!response.ok) {
      // The body is Lasso X's text: it is never read into an error, a result or an audit record.
      await discardBody(response);
      throw new LassoHttpError({
        status: response.status,
        method,
        url: describeUrl(url),
        retryAfter: response.headers.get('retry-after') ?? undefined,
      });
    }

    return (await readResponseBody(response, method)) as T;
  }
}

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A network failure in our own words: only a system error code from a fixed list, never a message. */
function transportError(error: unknown, method: string, timeoutMs: number): Error {
  // The address is configuration and is not quoted.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return timeoutError(`Lasso X API request timed out after ${timeoutMs} ms (${method}).`);
  }
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
  return new Error(`Network error calling the Lasso X API (${method})${shown}.`);
}

/** Our own text for a timeout, named TimeoutError so the audit records it as `timeout`. */
function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

/** Whether a content type is JSON: application/json or a +json type, with or without parameters. */
function isJsonContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

/**
 * Reads a successful response body: empty (null) or JSON (depth-limited). Anything else (another content type, or
 * JSON that does not parse) is refused with a fixed text: it would reach the caller without the masking that applies
 * to data.
 */
async function readResponseBody(response: Response, method: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Anything thrown while reading the body is replaced by our own text: its message is not ours.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw timeoutError(`Lasso X API response timed out while it was being read (${method}).`);
    }
    throw new Error(`The Lasso X API response could not be read (${method}).`);
  }

  if (!text) {
    return null;
  }

  if (!isJsonContentType(response.headers.get('content-type') ?? '')) {
    throw new Error(`Lasso X API answered with a content type this server does not read (${method}).`);
  }

  try {
    // Depth-limited at once, so nothing downstream (a handler's JSON text, the gateway) can exhaust the stack.
    return limitDepth(JSON.parse(text) as unknown);
  } catch {
    throw new Error(`Lasso X API answered with JSON that could not be read (${method}).`);
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // The value is not quoted: configuration is never echoed.
    throw new Error('The Lasso X base URL is not a valid URL.');
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    'Refusing to send the Lasso X API key over a connection that is not https. Use https:// (loopback http:// is allowed for local mocks).',
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
