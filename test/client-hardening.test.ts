import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import { PACKAGE_VERSION } from '../src/version.js';

const KEY = 'lasso-test-key-0123456789';

function client(fetchImpl: typeof fetch): LassoClient {
  return new LassoClient({ apiKey: KEY, fetchImpl });
}

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Lassox client hardening', () => {
  it('never follows redirects, so lasso-api-key stays on the API origin', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/x' } });
    });
    await expect(client(fetchImpl as typeof fetch).get('/cvr/search', { query: 'q' })).rejects.toThrow(
      /redirect \(HTTP 307\).*redirects are not followed/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the key before truncating error text and drops query strings', async () => {
    const body = `${'x'.repeat(490)} key ${KEY} ${'y'.repeat(200_000)}`;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 500 }));
    const error: Error & { url: string } = await client(fetchImpl as typeof fetch)
      .get('/cvr/search', { query: 'secret-query' })
      .then(
        () => {
          throw new Error('expected failure');
        },
        (e: unknown) => e as Error & { url: string },
      );
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(KEY.slice(0, 10));
    expect(error.message.length).toBeLessThan(2_000);
    expect(error.url).not.toContain('secret-query');
  });

  it('rejects an invalid LASSO_TIMEOUT_MS instead of using NaN', () => {
    process.env.LASSO_TIMEOUT_MS = 'abc';
    expect(() => new LassoClient()).toThrow(/LASSO_TIMEOUT_MS/);
    process.env.LASSO_TIMEOUT_MS = '-1';
    expect(() => new LassoClient()).toThrow(/LASSO_TIMEOUT_MS/);
    process.env.LASSO_TIMEOUT_MS = '5000';
    expect(() => new LassoClient()).not.toThrow();
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
