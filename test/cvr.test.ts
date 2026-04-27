import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import {
  buildCvrLassoId,
  buildCvrSearchQuery,
  getCvrEntity,
  getCvrEntityHistory,
  getRelatedEntities,
  searchCvr,
} from '../src/lasso/cvr.js';

describe('CVR helpers', () => {
  it('builds CVR Lasso IDs from structured entity inputs', () => {
    expect(buildCvrLassoId('company', '34580820')).toBe('CVR-1-34580820');
    expect(buildCvrLassoId('productionUnit', 1011011010)).toBe('CVR-2-1011011010');
    expect(buildCvrLassoId('person', '4000000001')).toBe('CVR-3-4000000001');
  });

  it('rejects non-numeric structured CVR IDs', () => {
    expect(() => buildCvrLassoId('company', 'abc')).toThrow('digits only');
  });

  it('serializes structured search filters into Lassox query syntax', () => {
    expect(
      buildCvrSearchQuery('Lasso X', {
        city: 'København',
        postalCode: 1550,
        protected: false,
      }),
    ).toBe('Lasso X city:København postalcode:1550 protected:false');
  });
});

describe('CVR endpoint URLs', () => {
  it('builds the search URL with paging and filters', async () => {
    const url = await captureUrl(client =>
      searchCvr(client, {
        query: 'Lasso X',
        type: 'company',
        status: 'all',
        pageSize: 10,
        continuationToken: 'next-page',
        filters: { city: 'København' },
      }),
    );

    expect(url).toBe(
      'https://example.test/data/cvr/search?query=Lasso+X+city%3AK%C3%B8benhavn&type=company&status=all&pageSize=10&cToken=next-page',
    );
  });

  it('builds the current entity URL', async () => {
    const url = await captureUrl(client =>
      getCvrEntity(client, {
        entityType: 'company',
        id: '34580820',
      }),
    );

    expect(url).toBe('https://example.test/CVR-1-34580820');
  });

  it('builds the entity history URL', async () => {
    const url = await captureUrl(client =>
      getCvrEntityHistory(client, {
        lassoId: 'CVR-1-34580820',
      }),
    );

    expect(url).toBe('https://example.test/CVR-1-34580820/history');
  });

  it('builds the related entities URL', async () => {
    const url = await captureUrl(client =>
      getRelatedEntities(client, {
        entityType: 'company',
        id: '34580820',
        relatedType: 'person',
        history: true,
      }),
    );

    expect(url).toBe('https://example.test/CVR-1-34580820/related/person/history');
  });
});

async function captureUrl(call: (client: LassoClient) => Promise<unknown>): Promise<string> {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
  const client = new LassoClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });

  await call(client);

  return String(fetchMock.mock.calls[0]?.[0]);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
