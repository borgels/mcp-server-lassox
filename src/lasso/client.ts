import { LassoHttpError } from '../errors.js';

export interface LassoClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | null | undefined;

export class LassoClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LassoClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LASSO_API_KEY;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.LASSO_BASE_URL ?? 'https://api.lassox.com',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LASSO_TIMEOUT_MS ?? 30_000);
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    if (!this.apiKey) {
      throw new Error('Missing LASSO_API_KEY. Set it in the MCP server environment.');
    }

    const url = this.buildUrl(path, query);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'lasso-api-key': this.apiKey,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = await readResponseBody(response);

    if (!response.ok) {
      throw new LassoHttpError({
        status: response.status,
        url,
        payload: body,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof body === 'string' ? body : undefined,
      });
    }

    return body as T;
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
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
