import { describe, expect, it, vi } from 'vitest';
import { LassoHttpError } from '../src/errors.js';
import { LassoClient } from '../src/lasso/client.js';

describe('LassoClient', () => {
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

  it('fails clearly when LASSO_API_KEY is missing', async () => {
    const client = new LassoClient({
      apiKey: '',
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(client.get('/CVR-1-34580820')).rejects.toThrow('Missing LASSO_API_KEY');
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
