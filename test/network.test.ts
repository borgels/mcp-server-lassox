import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import {
  assertPersonLassoId,
  getCvrNetwork,
  getOwnershipGraph,
} from '../src/lasso/network.js';

describe('network helpers', () => {
  it('rejects non-person Lasso IDs for the network endpoint', () => {
    expect(() => assertPersonLassoId('CVR-1-34580820')).toThrow(/CVR-3/);
    expect(() => assertPersonLassoId('CVR-2-1011011010')).toThrow(/CVR-3/);
    expect(() => assertPersonLassoId('CVR-3-4004094652')).not.toThrow();
  });
});

describe('network endpoints', () => {
  it('GETs the network module URL for a person', async () => {
    const { client, fetchMock } = createCapturingClient();
    await getCvrNetwork(client, { lassoId: 'CVR-3-4004094652' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/modules/network/CVR-3-4004094652');
    expect(init?.method).toBe('GET');
  });

  it('refuses non-person entities before calling Lassox', async () => {
    const { client, fetchMock } = createCapturingClient();
    await expect(
      getCvrNetwork(client, { entityType: 'company' as never, id: '34580820' }),
    ).rejects.toThrow(/CVR-3/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the ownership graph with only the supplied fields', async () => {
    const { client, fetchMock } = createCapturingClient();
    await getOwnershipGraph(client, {
      ids: ['CVR-1-34580820', 'CVR-3-4004094652'],
      enrichments: ['companyinfo', 'ultimateOwners'],
      outgoingDepth: 2,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/modules/relations/graph');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      ids: ['CVR-1-34580820', 'CVR-3-4004094652'],
      relationTypes: ['ownership'],
      enrichments: ['companyinfo', 'ultimateOwners'],
      outgoingDepth: 2,
    });
    expect(body.ingoingDepth).toBeUndefined();
    expect(body.onDate).toBeUndefined();
  });

  it('passes through onDate and custom relationTypes', async () => {
    const { client, fetchMock } = createCapturingClient();
    await getOwnershipGraph(client, {
      ids: ['CVR-1-34580820'],
      relationTypes: ['votingrights', 'unknownOwnership'],
      onDate: '2024-12-31',
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.relationTypes).toEqual(['votingrights', 'unknownOwnership']);
    expect(body.onDate).toBe('2024-12-31');
  });

  it('rejects empty ids and malformed Lasso IDs', async () => {
    const { client, fetchMock } = createCapturingClient();
    await expect(getOwnershipGraph(client, { ids: [] })).rejects.toThrow(/at least one/);
    await expect(
      getOwnershipGraph(client, { ids: ['not-a-lasso-id'] }),
    ).rejects.toThrow(/Invalid Lasso ID/);
    expect(fetchMock).not.toHaveBeenCalled();
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
