import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLassoxGateway, lassoxGatewayTools } from '../src/gateway.js';

describe('Lasso X gateway export', () => {
  it('exposes a curated company intelligence surface with one gated write', () => {
    expect(lassoxGatewayTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'cvr_search',
      'cvr_get_entity',
      'ownership_graph',
      'cvr_segment_search',
      'lists_index',
      'list_get_entities',
      'list_change',
      'cvr_get_changes',
    ]));

    const writes = lassoxGatewayTools.filter(tool => tool.riskLevel !== 'read');
    expect(writes.map(tool => tool.name)).toEqual(['list_change']);
    // The write tool must stay opt-in.
    expect(writes[0]?.enabledByDefault).toBe(false);
  });

  it('supports local capability search without upstream calls', async () => {
    const gateway = createLassoxGateway({ apiKey: 'test' });
    const result = await gateway.callTool('search_capabilities', { query: 'ownership' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeTruthy();
  });
});

describe('Lasso X gateway list scoping', () => {
  const originalEnv = { ...process.env };

  function fakeFetch() {
    return vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      const userId = url.searchParams.get('userId');
      let body: unknown = { results: [] };
      if (url.pathname === '/tags') {
        body = userId === 'u-alice' ? [{ id: 'alice1' }] : userId === 'u-bob' ? [{ id: 'bob1' }] : [{ id: 'shared1' }];
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('does not expose userId and scopes lists to the gateway caller', async () => {
    const listsTool = lassoxGatewayTools.find(tool => tool.name === 'lists_index');
    expect(Object.keys((listsTool?.inputSchema.properties ?? {}) as object)).toEqual([]);

    process.env.LASSO_USER_MAP = 'alice@example.com=u-alice,bob@example.com=u-bob';
    const fetchMock = fakeFetch();
    const gateway = createLassoxGateway({ apiKey: 'test', baseUrl: 'https://example.test', fetchImpl: fetchMock });

    await gateway.callTool('lists_index', { userId: 'u-bob' }, { user: 'alice@example.com' });
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls).toContain('https://example.test/tags?userId=u-alice');
    expect(urls.some(url => url.includes('u-bob'))).toBe(false);

    await expect(
      gateway.callTool('list_get_entities', { tagId: 'bob1' }, { user: 'alice@example.com' }),
    ).rejects.toThrow('not accessible');
    await expect(gateway.callTool('list_get_entities', { tagId: 'alice1' })).rejects.toThrow('not accessible');
    await expect(
      gateway.callTool('list_get_entities', { tagId: 'alice1' }, { user: 'alice@example.com' }),
    ).resolves.toMatchObject({ structuredContent: { results: [] } });
  });
});
