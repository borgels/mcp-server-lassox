// The sink check (README, "Embedding"): nothing that leaves a gateway holds a piece of 6 characters of the key. Every
// output is checked in its final form; known counterexamples and keys spliced from real outputs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLassoxGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';

const BASE = 'https://lassox.example.test';
let dir: string;

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ['LASSO_ENABLE_WRITES', 'LASSO_AUDIT_LOG', 'LASSO_USER_MAP', 'LASSO_DEFAULT_USER_ID', 'LASSO_TIMEOUT_MS']) {
    vi.stubEnv(name, '');
  }
  dir = mkdtempSync(join(tmpdir(), 'lassox-sink-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const upstream: typeof fetch = async url => {
  const path = new URL(String(url)).pathname;
  if (path === '/tags') return json([{ id: 'shared1', name: 'Kunder' }]);
  if (path === '/data/cvr/search') return json({ results: [{ lassoId: 'CVR-1-34580820', name: 'Testfirma ApS' }], resultsReturned: 1 });
  return json({ errorMessage: 'not found' }, 404);
};

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(key).filter(piece => texts.some(text => text.includes(piece)));
}

/** Every output of a normal session with this key, or the refusal when it is not admitted. */
async function outputs(apiKey: string, viaFile = false): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  const auditPath = join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  if (viaFile) vi.stubEnv('LASSO_AUDIT_LOG', auditPath);
  let gw: ReturnType<typeof createLassoxGateway>;
  try {
    gw = createLassoxGateway({
      apiKey,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream,
      ...(viaFile ? {} : { policy: { audit: (record: Record<string, unknown>) => void records.push(record) } }),
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('lists_index', {}, { caller: 'person-1', requestId: 'r1', lassoUserId: 'u-1' }),
    await gw.callTool('cvr_search', { query: 'Testfirma', pageSize: 5 }),
    await gw.callTool('search_capabilities', { query: 'ownership' }),
    await gw.callTool('cvr_get_entity', { lassoId: 'CVR-1-34580820' }),
    await gw.callTool('list_change', { lassoIds: ['CVR-1-34580820'], tagsToAdd: ['shared1'] }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('lists_index', { unknown: 1 }),
  ];
  let lines = '';
  try {
    lines = readFileSync(auditPath, 'utf8');
  } catch {
    lines = '';
  }
  return { outputs: [gw.tools, ...results, ...records, lines] };
}

describe('the sink check', () => {
  it('holds for known counterexamples, through the audit sink and the audit file', async () => {
    for (const apiKey of [
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'URI malformedQz7pX2vK9mWb\uD800',
      'x"ok": y-0123456789',
      'Qz7pX2vK9"data":[{"id"',
    ]) {
      for (const viaFile of [false, true]) {
        const { refused, outputs: seen } = await outputs(apiKey, viaFile);
        if (refused !== undefined) expect(refused, apiKey).toMatch(/key was refused/);
        expect(leaked(apiKey, seen), `${apiKey} ${viaFile}`).toEqual([]);
      }
    }
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU', true);
    expect(base.refused).toBeUndefined();
    // Spliced from the results and audit records (the tool list is refused whole by admission).
    const texts = base.outputs
      .slice(1)
      .flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)))
      .filter(text => text.length >= 6);
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 80; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiKey = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiKey, round % 2 === 0);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });

  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [apiKey, baseUrl] of [
      ['Qz7way.jsV8k2mP9X', 'invalid'],
      ['Qz7way.tsV8k2mP9X', 'invalid'],
      ['short', 'invalid'],
    ] as const) {
      let caught: Error | undefined;
      try {
        createLassoxGateway({ apiKey, baseUrl, timeoutMs: 1_000, policy: {} });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiKey).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(apiKey, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });
});

describe('credentials the upstream echoes, which are not the instance key', () => {
  const KEY = 'tenant-a-key-0123456789abcdef';
  const SESSION = 'opaque-session-secret-778899';
  const echoing: typeof fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/data/cvr/search') {
      return json({
        data: [
          {
            id: 'c1',
            name: 'Testfirma ApS',
            note: `Authorization: Bearer ${SESSION}`,
            header: `Basic ${SESSION}`,
            accessToken: SESSION,
            nested: { refresh_token: SESSION, client_secret: SESSION, password: SESSION, apiKey: SESSION },
            text: `token=${SESSION}`,
          },
        ],
        pagination: { hasNextPage: false },
      });
    }
    return json({ message: 'not found' }, 404);
  };

  it('are masked in structuredContent and in the text block', async () => {
    const gw = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, timeoutMs: 5_000, fetchImpl: echoing, policy: { enableWrites: false } });
    const result = await gw.callTool('cvr_search', { query: 'x' });
    expect(result.isError).toBeFalsy();
    const all = JSON.stringify(result);
    expect(all).not.toContain(SESSION);
    expect(all).toContain('Testfirma ApS');
    const company = (result.structuredContent as { data: Array<Record<string, unknown>> }).data[0]!;
    expect(company.accessToken).toBe('‹redacted›');
    expect((company.nested as Record<string, unknown>).refresh_token).toBe('‹redacted›');
    expect(String(company.note)).toMatch(/^Authorization: \[REDACTED\]|Bearer \[REDACTED\]/);
    expect(result.content[0]!.text).not.toContain(SESSION);
  });
});

describe('credential variants the upstream echoes (review round 2)', () => {
  const KEY = 'tenant-a-key-0123456789abcdef';
  const S = 'opaque-session-secret-778899';
  const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${'q1w2e3r4'.repeat(3)}`;
  const record = {
    id: 'c1',
    name: 'Testfirma ApS',
    lower: `bearer ${S}`,
    lowerBasic: `basic ${S}`,
    plan: 'basic plan',
    mixed: `BEARER ${S}`,
    list: [`bearer ${S}`, 'plain text'],
    [`bearer ${S}`]: 'key holds it',
    accessToken: [S],
    refreshToken: { value: S },
    'x-api-key': S,
    'X-Auth-Token': S,
    'api-key': S,
    'Api_Key': S,
    jwtText: `see ${JWT} here`,
    jwtList: [JWT],
  };
  const echoing: typeof fetch = async url =>
    new URL(String(url)).pathname === '/data/cvr/search'
      ? json({ data: [record], pagination: { hasNextPage: false } })
      : json({ message: 'not found' }, 404);

  it('are all masked, in structuredContent and in the text block, whole for credential-named fields', async () => {
    const gw = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, timeoutMs: 5_000, fetchImpl: echoing, policy: { enableWrites: false } });
    const result = await gw.callTool('cvr_search', { query: 'x' });
    expect(result.isError).toBeFalsy();
    const all = JSON.stringify(result);
    for (const secret of [S, JWT, JWT.split('.')[2]!]) expect(all).not.toContain(secret);
    expect(result.content[0]!.text).not.toContain(S);
    expect(all).toContain('Testfirma ApS');
    expect(all).toContain('plain text');
    const out = (result.structuredContent as { data: Array<Record<string, unknown>> }).data[0]!;
    for (const field of ['accessToken', 'refreshToken', 'x-api-key', 'X-Auth-Token', 'api-key', 'Api_Key']) {
      expect(out[field], field).toBe('‹redacted›');
    }
    expect(out.name).toBe('Testfirma ApS');
    // An ordinary word after "basic" is not a credential.
    expect(out.plan).toBe('basic plan');
    expect(out.id).toBe('c1');
  });
});

describe('round 3: text variants, unexpected answers and the audit', () => {
  const KEY = 'tenant-a-key-0123456789abcdef';
  const S = 'opaquealphabeticsecret';

  it('masks bearer and basic in any case, and credential assignments in text, but leaves a short word', async () => {
    const texts = {
      a: `bearer ${S}`,
      b: `basic ${Buffer.from('user:pass').toString('base64')}`,
      c: `X-Api-Key: ${S}`,
      d: `client_secret=${S}`,
      e: `https://x.example.test/cb?api_key=${S}&page=2`,
      plan: 'basic plan',
    };
    const fetchImpl: typeof fetch = async () => json({ data: [{ id: 'c1', name: 'Testfirma ApS', ...texts }], pagination: {} });
    const gw = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, timeoutMs: 5_000, fetchImpl, policy: { enableWrites: false } });
    const result = await gw.callTool('cvr_search', { query: 'x' });
    const all = JSON.stringify(result);
    for (const secret of [S, Buffer.from('user:pass').toString('base64')]) expect(all).not.toContain(secret);
    expect(all).toContain('basic plan');
    expect(all).toContain('Testfirma ApS');
  });

  it('refuses an answer that is not JSON, or JSON that does not parse, instead of passing it on', async () => {
    const answers: Array<[string, string]> = [
      ['text/plain', JSON.stringify({ 'x-api-key': S })],
      ['text/html', '<p>hello</p>'],
      ['application/json', `{"x-api-key":"${S}",`],
    ];
    for (const [type, body] of answers) {
      const fetchImpl: typeof fetch = async () => new Response(body, { status: 200, headers: { 'content-type': type } });
      const gw = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, timeoutMs: 5_000, fetchImpl, policy: { enableWrites: false } });
      const result = await gw.callTool('cvr_search', { query: 'x' });
      expect(result.isError, type).toBe(true);
      expect(JSON.stringify(result), type).not.toContain(S);
    }
    const ok: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200, headers: { 'content-type': 'application/vnd.lassox+json; charset=utf-8' } });
    const gw = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, timeoutMs: 5_000, fetchImpl: ok, policy: { enableWrites: false } });
    expect((await gw.callTool('cvr_search', { query: 'x' })).isError).toBeFalsy();
  });

  it('writes no caller, request id or unknown tool name of the host to the audit', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: async () => json({ data: [], pagination: {} }),
      policy: { enableWrites: false, audit: record => void records.push(record as Record<string, unknown>) },
    });
    const context = { caller: 'person@example.test', requestId: 'person@example.test' };
    await gw.callTool('cvr_search', { query: 'x' }, context);
    const unknown = await gw.callTool('person@example.test', {}, context);
    expect(JSON.stringify(unknown)).not.toContain('person@example.test');
    expect(records.length).toBeGreaterThan(2);
    expect(JSON.stringify(records)).not.toContain('person@example.test');
    expect(records.some(record => record.tool === 'unknown_tool')).toBe(true);
  });
});

describe('round 4: a sink that fails at finish', () => {
  it('records the failure as a fixed code, never its message', async () => {
    const KEY = 'tenant-a-key-0123456789abcdef';
    const records: Array<Record<string, unknown>> = [];
    const gw = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: async () => json({ data: [], pagination: {} }),
      policy: {
        enableWrites: false,
        audit: record => {
          records.push(record as Record<string, unknown>);
          if ((record as { action?: string }).action === 'finish') {
            throw new Error('sink down: person@example.test at /srv/internal/audit.db');
          }
        },
      },
    });
    await gw.callTool('cvr_search', { query: 'x' }, { caller: 'person@example.test' });
    const all = JSON.stringify(records);
    expect(all).not.toMatch(/person@example\.test|sink down|internal/);
    for (const record of records) {
      if (record.error !== undefined) expect(['error', 'timeout']).toContain(String(record.error).replace(/^http_\d{3}$/, 'error'));
    }
  });
});

describe('the audit records a tool failure by its code', () => {
  async function errorRecord(fetchImpl: typeof fetch, timeoutMs = 5_000): Promise<Record<string, unknown> | undefined> {
    const records: Array<Record<string, unknown>> = [];
    const gw = createLassoxGateway({
      apiKey: 'tenant-a-key-0123456789abcdef',
      baseUrl: BASE,
      timeoutMs,
      fetchImpl,
      policy: { enableWrites: false, audit: record => void records.push(record as Record<string, unknown>) },
    });
    const result = await gw.callTool('cvr_search', { query: 'x' });
    expect(result.isError).toBe(true);
    return records.find(record => record.action === 'error');
  }

  it('writes http_429 for a rate limit, http_500 for a server error, never the message', async () => {
    const r429 = await errorRecord(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }));
    expect(r429?.error).toBe('http_429');
    const r500 = await errorRecord(async () => new Response('boom', { status: 500 }));
    expect(r500?.error).toBe('http_500');
    expect(JSON.stringify([r429, r500])).not.toMatch(/slow down|boom|Lasso X API/);
  });

  it('writes timeout when the request times out, and when the answer times out while it is read', async () => {
    const timedOut = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    expect((await errorRecord(timedOut))?.error).toBe('timeout');

    const slowBody: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      }) as unknown as Response;
    expect((await errorRecord(slowBody))?.error).toBe('timeout');
  });

  it('writes error for a network failure', async () => {
    const down = async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443');
    };
    const record = await errorRecord(down);
    expect(record?.error).toBe('error');
    expect(JSON.stringify(record)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });
});

describe('a scheme word before a value that holds the marker', () => {
  const values = ['Basic ‹redacted›cGFzcw==', 'basic ‹redacted›abcdef', 'BEARER ‹redacted›abcdef', 'Bearer ‹redacted›x'];
  const masked = ['Basic [REDACTED]', 'basic [REDACTED]', 'BEARER [REDACTED]', 'Bearer [REDACTED]'];

  it('masks the whole value, whatever the length of the tail after the marker', async () => {
    const { redactCredentialPatterns, redactSecrets } = await import('../src/errors.js');
    values.forEach((text, i) => {
      expect(redactCredentialPatterns(text), text).toBe(masked[i]);
      expect(redactSecrets(text), text).toBe(masked[i]);
    });
    expect(redactSecrets('"Bearer ‹redacted›x", next')).toBe('"Bearer [REDACTED]", next');
    expect(redactSecrets('a basic plan')).toBe('a basic plan');
  });

  it('masks it through the gateway, in structuredContent and in the text block', async () => {
    const gw = createLassoxGateway({
      apiKey: 'tenant-a-key-0123456789abcdef',
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: async () => json({ data: [{ id: 'c1', name: values.join(' | ') }], pagination: {} }),
      policy: { enableWrites: false },
    });
    const result = await gw.callTool('cvr_search', { query: 'x' });
    expect(JSON.stringify(result.structuredContent)).toContain(masked.join(' | '));
    expect(JSON.stringify(result)).not.toMatch(/cGFzcw|abcdef|‹redacted›x/);
  });
});
