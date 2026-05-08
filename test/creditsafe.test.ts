import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import { getCreditsafeRating, resolveCvr } from '../src/lasso/creditsafe.js';

describe('creditsafe helpers', () => {
  it('extracts CVR from a company Lasso ID', () => {
    expect(resolveCvr({ lassoId: 'CVR-1-34580820' })).toBe('34580820');
  });

  it('accepts raw 8-digit CVR', () => {
    expect(resolveCvr({ cvr: '34580820' })).toBe('34580820');
    expect(resolveCvr({ cvr: 34580820 })).toBe('34580820');
  });

  it('rejects non-8-digit CVR', () => {
    expect(() => resolveCvr({ cvr: '12345' })).toThrow(/8 digits/);
    expect(() => resolveCvr({ cvr: 'abc12345' })).toThrow(/8 digits/);
  });

  it('rejects non-company Lasso IDs', () => {
    expect(() => resolveCvr({ lassoId: 'CVR-3-4004094652' })).toThrow(/companies/);
  });

  it('requires either cvr or lassoId', () => {
    expect(() => resolveCvr({})).toThrow(/either cvr or lassoId/);
  });
});

describe('creditsafe endpoint', () => {
  it('builds the rating URL with skipCache=true', async () => {
    const { client, fetchMock } = createCapturingClient();
    await getCreditsafeRating(client, { cvr: '34580820', skipCache: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/data/creditsafe/rating/34580820?skipCache=true',
    );
  });

  it('omits skipCache when not set', async () => {
    const { client, fetchMock } = createCapturingClient();
    await getCreditsafeRating(client, { lassoId: 'CVR-1-34580820' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/data/creditsafe/rating/34580820',
    );
  });
});

function createCapturingClient(): {
  client: LassoClient;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
} {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
  const client = new LassoClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
