import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import { changeListMembers, getListEntities, getLists } from '../src/lasso/lists.js';

const SHARED_TAGS = [{ id: 'shared1', name: 'Shared' }];
const ALICE_TAGS = [{ id: 'alice1', name: 'Alice private' }, { id: 'shared1', name: 'Shared' }];
const BOB_TAGS = [{ id: 'bob1', name: 'Bob private' }];

/** Fake Lassox API: /tags returns shared lists, /tags?userId=X that user's lists. */
function fakeLassox(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/tags') {
      const userId = url.searchParams.get('userId');
      if (!userId) return jsonResponse(SHARED_TAGS);
      if (userId === 'u-alice') return jsonResponse(ALICE_TAGS);
      if (userId === 'u-bob') return jsonResponse(BOB_TAGS);
      return jsonResponse([]);
    }
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse({
        resultsFound: 1,
        results: [{ lassoId: 'CVR-1-1', name: 'Lasso X A/S', noise: 'drop-me' }],
      });
    }
    return jsonResponse(null);
  });
}

function calledUrls(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return fetchMock.mock.calls.map(call => String(call[0]));
}

describe('lists endpoints', () => {
  it('only returns shared lists without a server-derived user id', async () => {
    const fetchMock = fakeLassox();
    expect(await getLists(makeClient(fetchMock))).toEqual(SHARED_TAGS);
    expect(calledUrls(fetchMock)).toEqual(['https://example.test/tags']);
  });

  it('merges shared lists with the scoped user\'s own lists', async () => {
    const fetchMock = fakeLassox();
    const lists = await getLists(makeClient(fetchMock), { userId: 'u-alice' });
    expect(lists).toEqual([
      { id: 'shared1', name: 'Shared' },
      { id: 'alice1', name: 'Alice private' },
    ]);
    expect(calledUrls(fetchMock)).toContain('https://example.test/tags?userId=u-alice');
  });

  it('builds the list entities URL with pagination after checking access', async () => {
    const fetchMock = fakeLassox();
    await getListEntities(makeClient(fetchMock), { tagId: 'alice1', skip: 10, take: 50 }, { userId: 'u-alice' });
    expect(calledUrls(fetchMock).at(-1)).toBe('https://example.test/tags/alice1/entities?skip=10&take=50');
  });

  it('refuses to read another user\'s private list', async () => {
    const fetchMock = fakeLassox();
    await expect(
      getListEntities(makeClient(fetchMock), { tagId: 'bob1' }, { userId: 'u-alice' }),
    ).rejects.toThrow('not accessible');
    await expect(getListEntities(makeClient(fetchMock), { tagId: 'alice1' })).rejects.toThrow('not accessible');
    expect(calledUrls(fetchMock).some(url => url.includes('/entities'))).toBe(false);
  });

  it('fails closed when the list index cannot be interpreted', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ unexpected: true }));
    await expect(getListEntities(makeClient(fetchMock), { tagId: 'shared1' })).rejects.toThrow('not accessible');
  });

  it('rejects path-unsafe tag ids before any request', async () => {
    const fetchMock = fakeLassox();
    const client = makeClient(fetchMock);
    for (const tagId of ['.', '..', 'a/b', 'a\b', 'a?x=1', 'a#b', '%2e%2e', 'a%2Fb']) {
      await expect(getListEntities(client, { tagId })).rejects.toThrow(/tagId/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects fields over list entity results', async () => {
    const result = (await getListEntities(makeClient(fakeLassox()), {
      tagId: 'shared1',
      fields: ['lassoId', 'name'],
    })) as { results: unknown[] };

    expect(result.results).toEqual([{ lassoId: 'CVR-1-1', name: 'Lasso X A/S' }]);
  });

  it('rejects empty tag ids', async () => {
    const client = makeClient(vi.fn<typeof fetch>());
    await expect(getListEntities(client, { tagId: '  ' })).rejects.toThrow('tagId is required');
  });
});

describe('changeListMembers', () => {
  it('posts the documented bulk change payload and echoes a summary', async () => {
    const fetchMock = fakeLassox();
    const client = makeClient(fetchMock);

    const result = await changeListMembers(client, {
      lassoIds: ['CVR-1-34580820'],
      tagsToAdd: ['shared1'],
    });

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe('https://example.test/tags/change');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      lassoIds: ['CVR-1-34580820'],
      tagsToAdd: ['shared1'],
      tagsToRemove: [],
    });
    expect(result).toMatchObject({ ok: true, entities: 1, tagsToAdd: ['shared1'] });
  });

  it('refuses to change lists outside the caller\'s visible lists', async () => {
    const fetchMock = fakeLassox();
    const client = makeClient(fetchMock);

    await expect(
      changeListMembers(client, { lassoIds: ['CVR-1-1'], tagsToRemove: ['bob1'] }, { userId: 'u-alice' }),
    ).rejects.toThrow('not accessible');
    await expect(
      changeListMembers(client, { lassoIds: ['CVR-1-1'], tagsToAdd: ['alice1', 'bob1'] }, { userId: 'u-alice' }),
    ).rejects.toThrow('bob1');
    expect(calledUrls(fetchMock)).not.toContain('https://example.test/tags/change');

    await changeListMembers(client, { lassoIds: ['CVR-1-1'], tagsToAdd: ['alice1'] }, { userId: 'u-alice' });
    expect(calledUrls(fetchMock)).toContain('https://example.test/tags/change');
  });

  it('validates lasso ids, tag operations, and overlaps', async () => {
    const client = makeClient(vi.fn<typeof fetch>());

    await expect(changeListMembers(client, { lassoIds: [], tagsToAdd: ['t'] })).rejects.toThrow('1-1000');
    await expect(
      changeListMembers(client, { lassoIds: ['bogus'], tagsToAdd: ['t'] }),
    ).rejects.toThrow('Invalid Lasso IDs');
    await expect(changeListMembers(client, { lassoIds: ['CVR-1-1'] })).rejects.toThrow(
      'tagsToAdd or tagsToRemove',
    );
    await expect(
      changeListMembers(client, { lassoIds: ['CVR-1-1'], tagsToAdd: ['t'], tagsToRemove: ['t'] }),
    ).rejects.toThrow('both tagsToAdd and tagsToRemove');
    await expect(
      changeListMembers(client, { lassoIds: ['CVR-1-1'], tagsToAdd: ['../x'] }),
    ).rejects.toThrow('list id');
  });
});

function makeClient(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): LassoClient {
  return new LassoClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
