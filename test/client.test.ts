import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUnknownError, LassoHttpError, redactSecrets } from '../src/errors.js';
import { LassoClient } from '../src/lasso/client.js';

const originalTimeout = process.env.LASSO_TIMEOUT_MS;

describe('LassoClient', () => {
  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.LASSO_TIMEOUT_MS;
    } else {
      process.env.LASSO_TIMEOUT_MS = originalTimeout;
    }
  });

  it('sends the Lassox API key as a header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lassoId: 'CVR-1-34580820' }));
    const client = new LassoClient({
      apiKey: 'secret-test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/CVR-1-34580820');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json',
      'lasso-api-key': 'secret-test-key',
    });
  });

  it('parses successful JSON responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ name: 'LASSO X A/S' }));
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.get('/CVR-1-34580820')).resolves.toEqual({ name: 'LASSO X A/S' });
  });

  it('includes retry-after guidance for Lassox rate limits', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          errorMessage: 'Too many requests. We allow 500 requests per minute.',
          httpStatusCode: 429,
          errorCode: 26,
          friendlyError: "Please retry your request after the seconds indicated in the 'retry-after' response-header.",
          helpLink: 'https://docs.lassox.com/gettingstarted/#rate-limits',
        },
        429,
        { 'retry-after': '17' },
      ),
    );
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.get('/CVR-1-34580820')).rejects.toThrow(/retry-after=17s/);

    try {
      await client.get('/CVR-1-34580820');
    } catch (error) {
      expect(error).toBeInstanceOf(LassoHttpError);
      expect((error as LassoHttpError).status).toBe(429);
      expect((error as LassoHttpError).retryAfter).toBe('17');
    }
  });

  it('keeps non-JSON failure bodies in the error message', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('upstream unavailable', {
          status: 503,
          headers: {
            'content-type': 'text/plain',
          },
        }),
    );
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.get('/CVR-1-34580820')).rejects.toThrow(/upstream unavailable/);
  });

  it('redacts API key material from formatted errors', async () => {
    expect(redactSecrets('lasso-api-key: secret-test-key')).toBe('lasso-api-key: [REDACTED]');
    expect(formatUnknownError(new Error('LASSO_API_KEY=secret-test-key'))).toBe(
      'LASSO_API_KEY= [REDACTED]',
    );
  });

  it('uses LASSO_TIMEOUT_MS when timeout is not passed explicitly', async () => {
    process.env.LASSO_TIMEOUT_MS = '1234';
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/CVR-1-34580820');

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });

  it('fails clearly when LASSO_API_KEY is missing', async () => {
    const client = new LassoClient({
      apiKey: '',
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(client.get('/CVR-1-34580820')).rejects.toThrow('Missing LASSO_API_KEY');
  });

  it('refuses non-https base URLs to protect the API key', () => {
    expect(
      () =>
        new LassoClient({
          apiKey: 'test-key',
          baseUrl: 'http://api.lassox.com',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/https/);
  });

  it('allows http:// for loopback (test mocks)', () => {
    expect(
      () =>
        new LassoClient({
          apiKey: 'test-key',
          baseUrl: 'http://localhost:8080',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).not.toThrow();
  });

  it('issues POST requests without a body or content-type by default', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.post('/modules/reportanalysis/CVR-1-34580820');

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      'lasso-api-key': 'test-key',
    });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('serializes JSON bodies for POST requests', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.post('/modules/example', undefined, { hello: 'world' });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"hello":"world"}');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
  });

  it('maps POST errors through LassoHttpError like GET', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          errorMessage: 'subscription required',
          errorCode: 12,
        },
        402,
      ),
    );
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.post('/modules/reportanalysis/CVR-1-34580820')).rejects.toBeInstanceOf(
      LassoHttpError,
    );
  });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}
