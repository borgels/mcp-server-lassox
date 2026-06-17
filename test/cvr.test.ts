import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import {
  buildCvrLassoId,
  buildCvrSearchQuery,
  getCvrEntitiesBatch,
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

describe('getCvrEntitiesBatch', () => {
  it('fetches every entity, isolates failures, and reports progress in order', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/CVR-1-2')) {
        return jsonResponse({ message: 'not found' }, 404);
      }
      return jsonResponse({ url });
    });
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const progress: Array<{ completed: number; total: number; label: string; ok: boolean }> = [];
    const result = await getCvrEntitiesBatch(
      client,
      {
        items: [
          { lassoId: 'CVR-1-1' },
          { lassoId: 'CVR-1-2' },
          { entityType: 'company', id: '34580820' },
        ],
        concurrency: 1,
      },
      {
        onProgress: event =>
          void progress.push({
            completed: event.completed,
            total: event.total,
            label: event.label,
            ok: event.ok,
          }),
      },
    );

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[1]).toMatchObject({ index: 1, label: 'CVR-1-2', ok: false });
    expect(result.results[1]?.error).toContain('404');
    expect(result.results[2]).toMatchObject({ label: 'CVR-1-34580820', ok: true });
    expect(progress.map(p => p.completed)).toEqual([1, 2, 3]);
  });

  it('records invalid items as failures without calling Lassox', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await getCvrEntitiesBatch(client, {
      items: [{ entityType: 'company' }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({ ok: false, label: '(invalid item)' });
  });

  it('throws when items is empty', async () => {
    const client = new LassoClient({ apiKey: 'test-key', baseUrl: 'https://example.test' });
    await expect(getCvrEntitiesBatch(client, { items: [] })).rejects.toThrow('at least one');
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
