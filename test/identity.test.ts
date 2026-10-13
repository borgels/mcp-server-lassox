import { describe, expect, it } from 'vitest';
import { parseUserMap, resolveListScope } from '../src/lasso/identity.js';
import { assertSafePathSegment, encodePathSegment } from '../src/lasso/path.js';

describe('Lassox caller identity mapping', () => {
  it('parses pair and JSON user maps case-insensitively', () => {
    expect(parseUserMap('Alice@Example.com=u-alice, bob@example.com=u-bob')).toEqual(
      new Map([
        ['alice@example.com', 'u-alice'],
        ['bob@example.com', 'u-bob'],
      ]),
    );
    expect(parseUserMap('{"Alice@example.com":"u-alice"}').get('alice@example.com')).toBe('u-alice');
    expect(parseUserMap(undefined).size).toBe(0);
    expect(() => parseUserMap('alice@example.com')).toThrow();
    expect(() => parseUserMap('{bad')).toThrow();
  });

  it('fails closed when forwarded identity is trusted but missing', () => {
    const env = { LASSO_TRUST_FORWARDED_USER: 'true', LASSO_USER_MAP: 'alice@example.com=u-alice' };
    expect(() => resolveListScope({ env })).toThrow('No verified caller identity');
    expect(() => resolveListScope({ env, callerEmail: '  ' })).toThrow('No verified caller identity');
  });

  it('maps verified callers to their own Lassox user and unmapped callers to shared lists only', () => {
    const env = {
      LASSO_TRUST_FORWARDED_USER: 'true',
      LASSO_USER_MAP: 'alice@example.com=u-alice',
      LASSO_DEFAULT_USER_ID: 'u-admin',
    };
    expect(resolveListScope({ env, callerEmail: 'ALICE@example.com' })).toMatchObject({ userId: 'u-alice' });
    // The default user id is never used for forwarded callers.
    expect(resolveListScope({ env, callerEmail: 'mallory@example.com' }).userId).toBeUndefined();
  });

  it('uses LASSO_DEFAULT_USER_ID only for single-user deployments', () => {
    expect(resolveListScope({ env: { LASSO_DEFAULT_USER_ID: 'u-me' } })).toEqual({ userId: 'u-me' });
    expect(resolveListScope({ env: {} })).toEqual({});
    // A caller email is ignored when forwarded identity is not trusted.
    expect(resolveListScope({ env: { LASSO_USER_MAP: 'a@x.dk=u-a' }, callerEmail: 'a@x.dk' })).toEqual({});
  });
});

describe('path segment guard', () => {
  it('rejects traversal, separators, query/fragment and encoded dots or slashes', () => {
    for (const value of ['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e', '%2E%2E', 'a%2fb', 'a%5Cb', 'a\nb']) {
      expect(() => assertSafePathSegment(value, 'id'), value).toThrow();
    }
  });

  it('encodes safe values', () => {
    expect(encodePathSegment('cHfb90')).toBe('cHfb90');
    expect(encodePathSegment('a b+c')).toBe('a%20b%2Bc');
  });
});
