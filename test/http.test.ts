import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAuthorized,
  assertSafeStartupConfig,
  getForwardedUser,
  getHttpConfig,
  HttpRequestError,
  isOriginAllowed,
  readJsonBody,
  safeEqual,
} from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
const SECRET = 'secret-0123456789abcdef0123456789abcdef';

describe('HTTP transport hardening', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('binds to loopback and uses a 10 MiB request limit by default', () => {
    expect(getHttpConfig({})).toMatchObject({
      host: '127.0.0.1',
      maxBodyBytes: 10_485_760,
    });
  });

  it('allows loopback origins by default and supports explicit origin allowlists', () => {
    expect(isOriginAllowed('http://localhost:5173', {})).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', {})).toBe(true);
    expect(isOriginAllowed('https://evil.example', {})).toBe(false);

    const config = getHttpConfig({ MCP_ALLOWED_ORIGINS: 'https://app.example' });
    expect(isOriginAllowed('https://app.example', config)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', config)).toBe(false);
  });

  it('requires the optional HTTP token when configured', () => {
    const config = { httpToken: SECRET };
    expect(() => assertAuthorized({ headers: {} } as never, config)).toThrow(HttpRequestError);
    expect(() =>
      assertAuthorized({ headers: { authorization: `Bearer ${SECRET}` } } as never, config),
    ).not.toThrow();
  });

  it('rejects oversized JSON request bodies', async () => {
    await expect(readJsonBody(Object.assign(Readable.from(['{"ok":true}']), { headers: {} }) as never, 4)).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('forwarded identity and startup checks', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('compares the HTTP token in constant time and rejects near misses', () => {
    expect(safeEqual('Bearer secret', 'Bearer secret')).toBe(true);
    expect(safeEqual('Bearer secreT', 'Bearer secret')).toBe(false);
    expect(safeEqual('', 'Bearer secret')).toBe(false);

    const config = { httpToken: SECRET };
    expect(() => assertAuthorized({ headers: { authorization: `Bearer ${SECRET}2` } } as never, config)).toThrow(HttpRequestError);
    expect(() => assertAuthorized({ headers: { authorization: SECRET } } as never, config)).toThrow(HttpRequestError);
  });

  it('refuses to start when forwarded identity is trusted without MCP_HTTP_TOKEN', () => {
    expect(() => assertSafeStartupConfig({ LASSO_TRUST_FORWARDED_USER: 'true' })).toThrow(/MCP_HTTP_TOKEN/);
    expect(() => assertSafeStartupConfig({ LASSO_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: '' })).toThrow();
    expect(() => assertSafeStartupConfig({ LASSO_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 'x' })).not.toThrow();
    expect(() => assertSafeStartupConfig({})).not.toThrow();
  });

  it('requires X-MCP-User when forwarded identity is trusted and ignores it otherwise', () => {
    const trust = { LASSO_TRUST_FORWARDED_USER: 'true' };
    expect(() => getForwardedUser({ headers: {} } as never, trust)).toThrow(HttpRequestError);
    expect(() => getForwardedUser({ headers: { 'x-mcp-user': '  ' } } as never, trust)).toThrow(HttpRequestError);
    expect(() => getForwardedUser({ headers: { 'x-mcp-user': ['a', 'b'] } } as never, trust)).toThrow(HttpRequestError);
    // Node joins a repeated header into one comma-separated value.
    expect(() => getForwardedUser({ headers: { 'x-mcp-user': 'alice@example.com, mallory@example.com' } } as never, trust)).toThrow(
      /Invalid X-MCP-User/,
    );
    expect(getForwardedUser({ headers: { 'x-mcp-user': 'alice@example.com' } } as never, trust)).toBe('alice@example.com');

    expect(getForwardedUser({ headers: { 'x-mcp-user': 'alice@example.com' } } as never, {})).toBeUndefined();
  });
});
