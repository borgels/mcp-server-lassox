import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import {
  assertCompanyLassoId,
  getCvrReports,
  getFinancialAnalysis,
} from '../src/lasso/financials.js';

describe('financials helpers', () => {
  it('rejects non-company Lasso IDs', () => {
    expect(() => assertCompanyLassoId('CVR-2-1011011010')).toThrow(/CVR-1/);
    expect(() => assertCompanyLassoId('CVR-3-4000000001')).toThrow(/CVR-1/);
    expect(() => assertCompanyLassoId('CVR-1-34580820')).not.toThrow();
  });
});

describe('financials endpoints', () => {
  it('builds the reports URL with currency conversion', async () => {
    const { call, fetchMock } = createCapturingClient();
    await getCvrReports(call, { lassoId: 'CVR-1-34580820', currency: 'EUR' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/CVR-1-34580820/reports?currency=EUR',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('omits the currency parameter when none is provided', async () => {
    const { call, fetchMock } = createCapturingClient();
    await getCvrReports(call, { entityType: 'company', id: '34580820' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/CVR-1-34580820/reports');
  });

  it('POSTs to the financial analysis module endpoint', async () => {
    const { call, fetchMock } = createCapturingClient();
    await getFinancialAnalysis(call, { lassoId: 'CVR-1-34580820' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://example.test/modules/reportanalysis/CVR-1-34580820');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('refuses non-company entities before calling Lassox', async () => {
    const { call, fetchMock } = createCapturingClient();

    await expect(
      getCvrReports(call, { lassoId: 'CVR-2-1011011010' }),
    ).rejects.toThrow(/CVR-1/);
    await expect(
      getFinancialAnalysis(call, { entityType: 'productionUnit' as never, id: '1011011010' }),
    ).rejects.toThrow(/CVR-1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createCapturingClient(): {
  call: LassoClient;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
} {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
  const call = new LassoClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });

  return { call, fetchMock };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
