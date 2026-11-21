// Failure metadata on gateway error results: the upstream API's HTTP status and its request id (a UUID or hex id
// only), for a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureMetadata, LassoHttpError, RedirectRefusedError, requestIdFrom, vendorRequestId } from '../src/errors.js';
import { createLassoxGateway } from '../src/gateway.js';

const KEY = 'tenant-a-key-0123456789abcdef';
const BASE = 'https://lassox.example.test';
const COMPANY = 'CVR-1-34580820';
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const BODY = { message: 'Customer Jane Doe not found', code: 'E_NOPE' };

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

function gatewayAnswering(status: number, headers: Record<string, string>, body: unknown = BODY, apiKey = KEY) {
  const fetchImpl = (async () =>
    // A 304 has no body.
    new Response(status === 304 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as typeof fetch;
  return createLassoxGateway({ apiKey, baseUrl: BASE, fetchImpl });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'abc--def',
      'abcdef12-ab',
      'abcdef1',
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error or a refused redirect only', () => {
    expect(failureMetadata(new LassoHttpError({ status: 404, url: `${BASE}/x`, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new LassoHttpError({ status: 500, url: `${BASE}/x`, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new RedirectRefusedError('refused', 302, UUID))).toEqual({ httpStatus: 302, requestId: UUID });
    // An opaque redirect has status 0: no metadata.
    expect(failureMetadata(new RedirectRefusedError('refused', 0, UUID))).toBeUndefined();
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    for (const status of [400, 402, 404, 500]) {
      const result = await gatewayAnswering(status, { 'x-request-id': UUID }).callTool('cvr_get_entity', { lassoId: COMPANY });
      expect(result.isError).toBe(true);
      expect(result.failure).toEqual({ httpStatus: status, requestId: UUID });
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('Jane Doe');
      expect(serialised).not.toContain('E_NOPE');
    }
  });

  it('carry the status and request id of a redirect, which is not followed', async () => {
    for (const status of [301, 302, 304, 307, 308]) {
      const result = await gatewayAnswering(status, { location: 'https://elsewhere.example/', 'x-request-id': UUID }).callTool(
        'cvr_get_entity',
        { lassoId: COMPANY },
      );
      expect(result.isError).toBe(true);
      expect(result.failure).toEqual({ httpStatus: status, requestId: UUID });
      expect(JSON.stringify(result)).not.toContain('elsewhere');
    }
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(403, { 'x-request-id': 'Jane Doe <jane@example.com>' }).callTool('cvr_get_entity', {
      lassoId: COMPANY,
    });
    expect(result.failure).toEqual({ httpStatus: 403 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(500, { 'x-request-id': 'deadbeef00112233' }, {}, 'tenant-deadbeef00112233-key').callTool(
      'cvr_get_entity',
      { lassoId: COMPANY },
    );
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not the upstream API', async () => {
    const gw = gatewayAnswering(200, {}, {});
    expect((await gw.callTool('cvr_get_entity', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const result = await offline.callTool('cvr_get_entity', { lassoId: COMPANY });
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering(200, { 'x-request-id': UUID }, { lassoId: COMPANY, name: 'Testfirma ApS' }).callTool(
      'cvr_get_entity',
      { lassoId: COMPANY },
    );
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
