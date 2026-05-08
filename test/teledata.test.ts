import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import {
  getCompanyPhoneNumbers,
  lookupPhoneNumber,
  normalizePhoneNumber,
} from '../src/lasso/teledata.js';

describe('teledata helpers', () => {
  it('strips formatting and validates digits', () => {
    expect(normalizePhoneNumber('+45 70 20 10 20')).toBe('+4570201020');
    expect(normalizePhoneNumber('70-20-10-20')).toBe('70201020');
    expect(normalizePhoneNumber('(70) 201020')).toBe('70201020');
  });

  it('rejects too-short or non-digit phone numbers', () => {
    expect(() => normalizePhoneNumber('123')).toThrow(/6-15 digits/);
    expect(() => normalizePhoneNumber('hello')).toThrow(/6-15 digits/);
  });
});

describe('teledata endpoints', () => {
  it('GETs the company phonenumbers URL for a CVR-1 company', async () => {
    const { client, fetchMock } = createCapturingClient();
    await getCompanyPhoneNumbers(client, { lassoId: 'CVR-1-34580820' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/data/teledata/CVR-1-34580820/phonenumbers',
    );
  });

  it('refuses non-company Lasso IDs for company phones', async () => {
    const { client, fetchMock } = createCapturingClient();
    await expect(
      getCompanyPhoneNumbers(client, { lassoId: 'CVR-3-4004094652' }),
    ).rejects.toThrow(/CVR-1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the reverse phone-lookup URL with includeCompany', async () => {
    const { client, fetchMock } = createCapturingClient();
    await lookupPhoneNumber(client, {
      phoneNumber: '70 20 10 20',
      includeCompany: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/data/teledata/70201020?includeCompany=true',
    );
  });

  it('omits includeCompany when not set', async () => {
    const { client, fetchMock } = createCapturingClient();
    await lookupPhoneNumber(client, { phoneNumber: '70201020' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/data/teledata/70201020');
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
