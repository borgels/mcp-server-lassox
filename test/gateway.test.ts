import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets } from '../src/errors.js';
import { callerPseudonym } from '../src/lasso/audit.js';
import { LassoClient } from '../src/lasso/client.js';
import {
  createLassoxGateway,
  GatewayConfigError,
  lassoxGatewayTools,
  lassoxToolCatalog,
  type GatewayJsonObject,
} from '../src/gateway.js';
import { registerCvrTools } from '../src/tools/cvr.js';

const KEY = 'tenant-a-key-0123456789abcdef';
const OTHER = 'tenant-b-key-fedcba9876543210';
const BASE = 'https://lassox.example.test';
const COMPANY = 'CVR-1-34580820';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lassox-gateway-'));
  vi.unstubAllEnvs();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them.
  vi.stubEnv('LASSO_API_KEY', 'env-key-must-not-be-used-000000');
  vi.stubEnv('LASSO_BASE_URL', 'https://env-base.example.test');
  vi.stubEnv('LASSO_TIMEOUT_MS', 'not-a-number');
  vi.stubEnv('LASSO_ENABLE_WRITES', 'true');
  vi.stubEnv('LASSO_AUDIT_LOG', join(dir, 'env-audit.jsonl'));
  vi.stubEnv('LASSO_USER_MAP', 'person@example.test=u-alice');
  vi.stubEnv('LASSO_DEFAULT_USER_ID', 'u-alice');
  vi.stubEnv('LASSO_TRUST_FORWARDED_USER', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fake Lasso X API: /tags has a shared list, and with userId=u-alice also her private list. */
function apiFetch() {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/tags') {
      return jsonResponse(url.searchParams.get('userId') === 'u-alice' ? [{ id: 'alice1' }] : [{ id: 'shared1' }]);
    }
    if (url.pathname === '/tags/change') return new Response(null, { status: 200 });
    return jsonResponse({ results: [{ lassoId: COMPANY, name: 'Testfirma ApS' }] });
  });
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

/** A valid minimal input per gateway tool. */
const MINIMAL_INPUT: Record<string, GatewayJsonObject> = {
  search_capabilities: {},
  cvr_search: { query: 'Testfirma' },
  cvr_get_entity: { lassoId: COMPANY },
  cvr_get_entity_history: { lassoId: COMPANY },
  cvr_get_reports: { lassoId: COMPANY },
  financial_analysis: { lassoId: COMPANY },
  cvr_segment_search: { postalCodes: [8000], maxRequests: 10 },
  lists_index: {},
  list_get_entities: { tagId: 'shared1' },
  list_change: { lassoIds: [COMPANY], tagsToAdd: ['shared1'] },
  cvr_get_changes: { since: '2026-07-01' },
  ownership_graph: { ids: [COMPANY] },
};

function matchesTemplate(request: string, template: string): boolean {
  const pattern = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[A-Za-z]+\\?\}/g, '[^/]+');
  return new RegExp(`^${pattern}$`).test(request);
}

describe('Lasso X gateway surface', () => {
  it('keeps the tool set: reads enabled by default, the one write off', () => {
    expect(lassoxGatewayTools.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault])).toEqual([
      ['search_capabilities', 'read', true],
      ['cvr_search', 'read', true],
      ['cvr_get_entity', 'read', true],
      ['cvr_get_entity_history', 'read', true],
      ['cvr_get_reports', 'read', true],
      ['financial_analysis', 'read', true],
      ['cvr_segment_search', 'read', true],
      ['lists_index', 'read', true],
      ['list_get_entities', 'read', true],
      ['list_change', 'write', false],
      ['cvr_get_changes', 'read', true],
      ['ownership_graph', 'read', true],
    ]);
    expect(Object.keys(MINIMAL_INPUT)).toEqual(lassoxGatewayTools.map(tool => tool.name));
  });

  it('has a deeply frozen catalog with the upstream requests and the broad mark', () => {
    expect(Object.isFrozen(lassoxToolCatalog)).toBe(true);
    for (const entry of lassoxToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      for (const op of entry.upstream) expect(Object.isFrozen(op)).toBe(true);
      expect(entry.broad).toBe(false);
      expect(entry.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(lassoxToolCatalog.map(entry => entry.name)).toEqual(lassoxGatewayTools.map(tool => tool.name));
    expect(lassoxToolCatalog.map(entry => [entry.name, entry.upstream.map(op => `${op.method} ${op.path}`)])).toEqual([
      ['search_capabilities', []],
      ['cvr_search', ['GET /data/cvr/search']],
      ['cvr_get_entity', ['GET /{lassoId}']],
      ['cvr_get_entity_history', ['GET /{lassoId}/history']],
      ['cvr_get_reports', ['GET /{lassoId}/reports']],
      ['financial_analysis', ['POST /modules/reportanalysis/{lassoId}']],
      ['cvr_segment_search', ['GET /data/cvr/search', 'GET /{lassoId}']],
      ['lists_index', ['GET /tags']],
      ['list_get_entities', ['GET /tags', 'GET /tags/{tagId}/entities']],
      ['list_change', ['GET /tags', 'POST /tags/change']],
      [
        'cvr_get_changes',
        [
          'GET /data/cvr/company/delta',
          'GET /data/cvr/company/delta/history',
          'GET /data/cvr/person/delta',
          'GET /data/cvr/person/delta/history',
          'GET /data/cvr/place/delta',
          'GET /data/cvr/place/delta/history',
          'GET /data/cvr/reports/delta',
        ],
      ],
      ['ownership_graph', ['POST /modules/relations/graph']],
    ]);
    expect(() => {
      (lassoxToolCatalog[0] as { broad: boolean }).broad = true;
    }).toThrow();
    expect(() => {
      (lassoxToolCatalog[1]!.upstream as unknown as GatewayJsonObject[]).push({ method: 'GET', path: '/x' });
    }).toThrow();
  });

  it('matches the registered handlers: every catalog entry is a registered MCP tool', () => {
    const registered = new Set<string>();
    registerCvrTools(
      { registerTool: (name: string) => void registered.add(name) } as never,
      new LassoClient({ apiKey: 'schema-only-key', credentialEnv: {}, timeoutMs: 1 }),
      { registerWriteTools: true },
    );
    const aliases: Record<string, string> = {
      search_capabilities: 'lassox_search_capabilities',
      financial_analysis: 'lassox_financial_analysis',
      lists_index: 'lassox_lists_index',
      list_get_entities: 'lassox_list_get_entities',
      list_change: 'lassox_list_change',
      ownership_graph: 'cvr_get_ownership_graph',
    };
    for (const entry of lassoxToolCatalog) expect(registered.has(aliases[entry.name] ?? entry.name), entry.name).toBe(true);
    // Creditsafe, Teledata, batch, network and related reads stay in the MCP server only.
    for (const name of ['creditsafe_get_rating', 'teledata_get_company_phones', 'teledata_lookup_phone', 'cvr_batch_get_entities']) {
      expect(registered.has(name)).toBe(true);
    }
    const listsIndex = lassoxToolCatalog.find(entry => entry.name === 'lists_index')!;
    expect(Object.keys((listsIndex.inputSchema.properties ?? {}) as object)).toEqual([]);
    const change = lassoxToolCatalog.find(entry => entry.name === 'list_change')!;
    expect(change.inputSchema).toMatchObject({ required: ['lassoIds'] });
  });
});

describe('Lasso X gateway credentials', () => {
  it('requires apiKey and never reads LASSO_API_KEY', () => {
    expect(() => createLassoxGateway({} as never)).toThrow(GatewayConfigError);
    expect(() => createLassoxGateway(undefined as never)).toThrow(/requires options\.apiKey/);
    expect(() => createLassoxGateway({ apiKey: '   ' })).toThrow(GatewayConfigError);
  });

  it('admits keys only of printable ASCII and at least 16 characters, before anything is sent', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createLassoxGateway({ apiKey: 'short7!', fetchImpl })).toThrow(/key was refused/);
    expect(() => createLassoxGateway({ apiKey: '123456789012345', fetchImpl })).toThrow(/key was refused/);
    expect(() => createLassoxGateway({ apiKey: 'Zq7pX2vK9mWb4TnRé', fetchImpl })).toThrow(/key was refused/);
    expect(() => createLassoxGateway({ apiKey: 'Zq7pX2 vK9mWb4TnR8y', fetchImpl })).toThrow(/key was refused/);
    expect(() => createLassoxGateway({ apiKey: 'Zq7pXlists_index2vK', fetchImpl })).toThrow(/key was refused/);
    expect(() => createLassoxGateway({ apiKey: '1234567890123456', fetchImpl })).not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses with a fixed text that holds no piece of the key, as a sealed error', () => {
    const key = 'Zq7pXlists_index2vK';
    let caught: Error | undefined;
    try {
      createLassoxGateway({ apiKey: key });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(GatewayConfigError);
    expect(caught!.stack).toBe(`${caught!.name}: ${caught!.message}`);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    for (let i = 0; i + 6 <= key.length; i += 1) expect(caught!.message).not.toContain(key.slice(i, i + 6));
  });

  it('sends its own key to the real Lasso X address, never the LASSO_* environment', async () => {
    const fetchImpl = apiFetch();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const gateway = createLassoxGateway({ apiKey: KEY, fetchImpl });

    const result = await gateway.callTool('cvr_get_entity', { lassoId: COMPANY });

    expect(result.isError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.lassox.com/${COMPANY}`);
    expect(init?.headers).toMatchObject({ 'lasso-api-key': KEY });
    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mockRestore();
  });

  it('accepts gateway names and MCP server names, in any case', async () => {
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch() });
    for (const name of ['lassox_lists_index', 'LISTS_INDEX', 'cvr_get_ownership_graph']) {
      const input: GatewayJsonObject = name === 'cvr_get_ownership_graph' ? { ids: [COMPANY] } : {};
      await expect(gateway.callTool(name, input)).resolves.not.toHaveProperty('isError');
    }
  });
});

describe('Lasso X gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool', async () => {
    const seen: string[] = [];
    const inner = apiFetch();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${decodeURIComponent(new URL(String(url)).pathname)}`);
      return inner(url, init);
    });
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: true } });

    for (const entry of lassoxToolCatalog) {
      seen.length = 0;
      const result = await gateway.callTool(entry.name, MINIMAL_INPUT[entry.name]);
      expect(result.isError, `${entry.name}: ${result.content[0]?.text}`).toBeUndefined();
      const declared = entry.upstream.map(op => `${op.method} ${op.path}`);
      if (declared.length === 0) expect(seen, entry.name).toEqual([]);
      else expect(seen.length, entry.name).toBeGreaterThan(0);
      for (const request of seen) {
        expect(declared.some(template => matchesTemplate(request, template)), `${entry.name}: ${request}`).toBe(true);
      }
    }

    const changes = lassoxToolCatalog.find(entry => entry.name === 'cvr_get_changes')!;
    for (const scope of ['company', 'person', 'place', 'reports']) {
      for (const history of scope === 'reports' ? [false] : [false, true]) {
        seen.length = 0;
        const result = await gateway.callTool('cvr_get_changes', { since: '2026-07-01', scope, history });
        expect(result.isError).toBeUndefined();
        expect(changes.upstream.map(op => `${op.method} ${op.path}`)).toContain(seen[0]);
      }
    }
  });

  it('lists only the tools the instance offers in search_capabilities', async () => {
    const gateway = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(),
      policy: { disabledTools: ['cvr_get_changes'] },
    });
    const result = await gateway.callTool('search_capabilities', { limit: 50 });
    const ids = (result.structuredContent as Array<{ id: string }>).map(entry => entry.id).sort();
    expect(ids).toEqual(
      [
        'lassox_search_capabilities',
        'cvr_search',
        'cvr_get_entity',
        'cvr_get_entity_history',
        'cvr_get_reports',
        'lassox_financial_analysis',
        'cvr_segment_search',
        'lassox_lists_index',
        'lassox_list_get_entities',
        'lassox_list_change',
        'cvr_get_ownership_graph',
      ].sort(),
    );
  });
});

describe('Lasso X gateway input', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = apiFetch();
    const { records, audit } = sink();
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { audit } });

    for (const [tool, input] of [
      ['cvr_search', {}],
      ['cvr_get_entity', {}],
      ['cvr_get_entity', { lassoId: 'not-a-lasso-id' }],
      ['cvr_get_entity', { lassoId: COMPANY, apiKey: 'smuggled' }],
      ['lists_index', { userId: 'u-alice' }],
      ['cvr_get_changes', { since: '2026-07-01', scope: 'everything' }],
    ] as const) {
      const result = await gateway.callTool(tool, input as never);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]?.text, tool).toMatch(/^Invalid input for /);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => [record.action, record.reason])).toEqual(
      Array.from({ length: 6 }, () => ['rejected', 'invalid input']),
    );
  });

  it('returns an error for unsupported tools, also for MCP server tools outside the gateway', async () => {
    const fetchImpl = apiFetch();
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    await expect(gateway.callTool('unknown_tool')).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Unsupported Lasso X gateway tool.' }],
    });
    for (const name of ['creditsafe_get_rating', 'teledata_lookup_phone', 'cvr_batch_get_entities', 'cvr_get_network']) {
      const result = await gateway.callTool(name, { cvr: '34580820' });
      expect(result.isError, name).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Lasso X gateway policy', () => {
  it('reads no policy, audit or list variables, with or without a host policy', async () => {
    const { records, audit } = sink();
    const withPolicy = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch(), policy: { audit } });
    const result = await withPolicy.callTool('cvr_search', { query: 'Testfirma' }, { caller: 'person-1', requestId: 'call-1' });
    expect(result.isError).toBeUndefined();
    // The caller only as a pseudonym, and the request id our own, the same for the call's records.
    expect(records.map(record => [record.tool, record.action, record.caller])).toEqual([
      ['cvr_search', 'start', callerPseudonym('person-1')],
      ['cvr_search', 'finish', callerPseudonym('person-1')],
    ]);
    expect(records[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(records[1]?.requestId).toBe(records[0]?.requestId);
    expect(JSON.stringify(records)).not.toMatch(/person-1|call-1/);

    const without = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch() });
    await without.callTool('cvr_search', { query: 'Testfirma' });
    // LASSO_ENABLE_WRITES=true is set and ignored: writes stay off without policy.enableWrites.
    const write = await without.callTool('list_change', MINIMAL_INPUT.list_change);
    expect(write.isError).toBe(true);
    expect(write.content[0]?.text).toContain('has not enabled writes');
    expect(existsSync(join(dir, 'env-audit.jsonl'))).toBe(false);
  });

  it('runs list_change only with policy.enableWrites and when it is not disabled', async () => {
    const fetchImpl = apiFetch();
    const off = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: false } });
    expect((await off.callTool('list_change', MINIMAL_INPUT.list_change)).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const disabled = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl,
      policy: { enableWrites: true, disabledTools: ['list_change'] },
    });
    expect(disabled.tools.map(tool => tool.name)).not.toContain('list_change');
    expect((await disabled.callTool('list_change', MINIMAL_INPUT.list_change)).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const on = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: true } });
    const result = await on.callTool('list_change', MINIMAL_INPUT.list_change);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, entities: 1, tagsToAdd: ['shared1'] });
    expect(fetchImpl.mock.calls.map(call => `${call[1]?.method} ${new URL(String(call[0])).pathname}`)).toEqual([
      'GET /tags',
      'POST /tags/change',
    ]);
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = apiFetch();
    const { records, audit } = sink();
    const gateway = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl,
      policy: { disabledTools: ['cvr_search', 'lassox_lists_index'], audit },
    });

    expect(gateway.tools.map(tool => tool.name)).not.toContain('cvr_search');
    expect(gateway.tools.map(tool => tool.name)).not.toContain('lists_index');
    expect(gateway.tools).toHaveLength(lassoxGatewayTools.length - 2);
    const result = await gateway.callTool('cvr_search', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disabled on this instance by the embedding host');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => record.action)).toEqual(['policy_denied']);

    for (const policy of [
      { disabledTools: ['creditsafe_get_rating'] },
      { enableWrites: 'yes' as never },
      { audit: 'file' as never },
    ]) {
      expect(() => createLassoxGateway({ apiKey: KEY, policy })).toThrow(GatewayConfigError);
    }
  });

  it('does not run a tool whose start record the sink refuses', async () => {
    const fetchImpl = apiFetch();
    const gateway = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl,
      policy: {
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const result = await gateway.callTool('cvr_search', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Lasso X gateway lists', () => {
  it('without a Lasso X user from the host sees and changes only shared lists, whatever LASSO_USER_MAP says', async () => {
    const fetchImpl = apiFetch();
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: true } });

    const lists = await gateway.callTool('lists_index', {}, { caller: 'person@example.test' });
    expect(lists.structuredContent).toEqual([{ id: 'shared1' }]);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([`${BASE}/tags`]);

    const denied = await gateway.callTool('list_get_entities', { tagId: 'alice1' }, { caller: 'person@example.test' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('not accessible');
    const change = await gateway.callTool('list_change', { lassoIds: [COMPANY], tagsToAdd: ['alice1'] });
    expect(change.isError).toBe(true);
    expect(fetchImpl.mock.calls.some(call => String(call[0]).includes('u-alice'))).toBe(false);
    expect(fetchImpl.mock.calls.some(call => String(call[0]).endsWith('/tags/change'))).toBe(false);
  });

  it('with lassoUserId in the call context also sees that user’s private lists, and only for that call', async () => {
    const fetchImpl = apiFetch();
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    const lists = await gateway.callTool('lists_index', {}, { lassoUserId: 'u-alice' });
    expect(lists.structuredContent).toEqual([{ id: 'shared1' }, { id: 'alice1' }]);
    await expect(
      gateway.callTool('list_get_entities', { tagId: 'alice1' }, { lassoUserId: 'u-alice' }),
    ).resolves.not.toHaveProperty('isError');
    expect((await gateway.callTool('list_get_entities', { tagId: 'alice1' })).isError).toBe(true);

    const invalid = await gateway.callTool('lists_index', {}, { lassoUserId: 'u alice&x=1' });
    expect(invalid).toMatchObject({ isError: true, content: [{ text: 'Invalid call context: lassoUserId must be a Lasso X user id.' }] });
  });
});

describe('Lasso X gateway results', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch() });
    const result = await gateway.callTool('cvr_search', { query: 'Testfirma' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ results: [{ lassoId: COMPANY, name: 'Testfirma ApS' }] });
    expect(result.content).toHaveLength(1);
    const [summary, data, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).toBe('CVR search results.');
    expect(rest).toEqual([]);
    expect(data).toBe(JSON.stringify(result.structuredContent));
  });

  it('starts every successful result with the tool’s own summary', async () => {
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch(), policy: { enableWrites: true } });
    const summaries: Record<string, string> = {};
    for (const tool of lassoxGatewayTools) {
      const result = await gateway.callTool(tool.name, MINIMAL_INPUT[tool.name]);
      summaries[tool.name] = result.content[0]!.text.split('\n\n')[0]!;
    }
    expect(summaries).toEqual({
      search_capabilities: 'Lasso X capabilities.',
      cvr_search: 'CVR search results.',
      cvr_get_entity: 'CVR entity.',
      cvr_get_entity_history: 'CVR entity history.',
      cvr_get_reports: 'CVR annual report key figures.',
      financial_analysis: 'Lasso X financial analysis.',
      cvr_segment_search: 'CVR segment search results.',
      lists_index: 'Lasso X lists.',
      list_get_entities: 'Lasso X list members.',
      list_change: 'Lasso X list membership changed.',
      cvr_get_changes: 'CVR changes.',
      ownership_graph: 'CVR ownership graph.',
    });
  });

  it('redacts the key from values, object keys and numbers, in text and data', async () => {
    const numeric = '8273645190827364';
    const echo = (key: string) =>
      vi.fn<typeof fetch>(async () =>
        jsonResponse({
          results: [
            { id: 'e1', note: `key ${key}`, [`k-${key}`]: 'value', header: `lasso-api-key: ${key}`, piece: key.slice(3, 12) },
            { id: 'e2', number: Number(key) },
          ],
        }),
      );
    for (const key of [KEY, numeric]) {
      const gateway = createLassoxGateway({ apiKey: key, baseUrl: BASE, fetchImpl: echo(key) });
      const result = await gateway.callTool('cvr_search', { query: 'x' });
      expect(result.isError, key).toBeUndefined();
      const everything = JSON.stringify(result);
      for (const secret of [key, key.slice(3, 12)]) expect(everything, key).not.toContain(secret);
      expect(everything).toContain('‹redacted›');
      const [, data] = result.content[0]!.text.split('\n\n');
      expect(JSON.parse(data!)).toEqual(result.structuredContent);
    }
  });
});

describe('Lasso X gateway errors', () => {
  it('starts with the HTTP status in our own text and never carries the Lasso X body', async () => {
    for (const [status, hint] of [
      [400, undefined],
      [401, 'The Lasso X API key was rejected'],
      [402, 'separate Lasso X subscription'],
      [403, 'no access'],
      [404, 'Lasso X found nothing'],
      [429, 'throttling'],
      [500, undefined],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { errorMessage: `Vendor diagnostic for ${KEY}`, friendlyError: 'Vendor diagnostic', errorCode: 77, helpLink: 'https://help.example.test' },
          status,
          { 'retry-after': '12', 'x-request-id': 'vendor-request-id' },
        ),
      );
      const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });
      const result = await gateway.callTool('cvr_search', { query: 'x' });
      expect(result.isError, String(status)).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = result.content[0]!.text;
      expect(text.startsWith(`Lasso X API request failed with HTTP ${status}`), text).toBe(true);
      if (hint) expect(text).toContain(hint);
      expect(text).toContain('retry-after=12s');
      expect(text).not.toMatch(/Vendor diagnostic|vendor-request-id|errorCode|help\.example|lassox\.example/);
      expect(text).not.toContain(KEY);
    }
  });

  it('refuses redirects, network failures and timeouts in our own words, without the address or the cause', async () => {
    const redirect = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }),
      ),
    });
    const redirected = await redirect.callTool('cvr_search', { query: 'x' });
    expect(redirected.content[0]!.text).toMatch(/^Lasso X API responded with a redirect \(HTTP 302\)/);
    expect(redirected.content[0]!.text).not.toMatch(/elsewhere|lassox\.example/);

    const network = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(`connect to ${BASE} failed`), { code: 'ECONNREFUSED' }),
        });
      }),
    });
    const failed = await network.callTool('cvr_search', { query: 'x' });
    expect(failed.content[0]!.text).toBe('Network error calling the Lasso X API (GET) (ECONNREFUSED).');

    const slow = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      timeoutMs: 1234,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new DOMException(`aborted on ${BASE}`, 'TimeoutError');
      }),
    });
    const timedOut = await slow.callTool('cvr_search', { query: 'x' });
    expect(timedOut.content[0]!.text).toBe('Lasso X API request timed out after 1234 ms (GET).');
  });

  it('does not quote a refused base URL', () => {
    let caught: Error | undefined;
    try {
      createLassoxGateway({ apiKey: KEY, baseUrl: 'http://lassox.example.test/secret-path' });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(GatewayConfigError);
    expect(caught!.message).not.toContain('secret-path');
  });
});

describe('Lasso X gateway redaction and call scopes', () => {
  it('redacts the key from every audit record field', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`key ${KEY} rejected`, { status: 401 }));
    const { records, audit } = sink();
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { audit } });

    const result = await gateway.callTool('cvr_search', { query: 'x' }, { caller: `person ${KEY}`, requestId: KEY });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(records[0]?.caller).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records.find(record => record.action === 'error')?.error).toBe('http_401');
  });

  it('redacts an unknown tool name before cutting it short, so no part of the key is left', async () => {
    const { records, audit } = sink();
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch(), policy: { audit } });

    const result = await gateway.callTool(`${'x'.repeat(90)}${KEY}`);

    const everything = JSON.stringify([result, records]);
    for (const piece of [KEY, KEY.slice(0, 10), KEY.slice(0, 8)]) expect(everything).not.toContain(piece);
    expect(records.map(record => [record.action, record.reason])).toEqual([['rejected', 'unsupported tool']]);
  });

  it('keeps no process-wide registry: an instance key is not redacted outside its calls', async () => {
    const gateway = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: apiFetch() });
    await gateway.callTool('cvr_search', { query: 'x' });
    expect(redactSecrets(`plain ${KEY}`)).toBe(`plain ${KEY}`);
  });

  it('keeps two tenants apart when they call at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const key = String((init?.headers as Record<string, string>)['lasso-api-key']);
      seen.push(key);
      await gate;
      // Lasso X echoing the key it received, in the data.
      return jsonResponse({ results: [{ received: key }] });
    });
    const a = sink();
    const b = sink();
    const gatewayA = createLassoxGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { audit: a.audit } });
    const gatewayB = createLassoxGateway({ apiKey: OTHER, baseUrl: BASE, fetchImpl, policy: { audit: b.audit } });

    const both = Promise.all([
      gatewayA.callTool('cvr_search', { query: 'x' }, { caller: 'a', lassoUserId: 'u-a' }),
      gatewayB.callTool('cvr_search', { query: 'x' }, { caller: 'b' }),
    ]);
    for (let i = 0; i < 50 && seen.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect(seen.sort()).toEqual([KEY, OTHER].sort());
    release();
    const [ra, rb] = await both;

    for (const [result, own] of [
      [ra, KEY],
      [rb, OTHER],
    ] as const) {
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(own);
    }
    expect(a.records.every(record => record.caller === callerPseudonym('a'))).toBe(true);
    expect(b.records.every(record => record.caller === callerPseudonym('b'))).toBe(true);
    expect(JSON.stringify(a.records)).not.toContain(KEY);
    expect(JSON.stringify(b.records)).not.toContain(OTHER);
  });

  it('runs a call made from inside another instance’s sink under its own scope, not the outer policy', async () => {
    const outer = sink();
    const innerFetch = apiFetch();
    const inner = createLassoxGateway({ apiKey: OTHER, baseUrl: BASE, fetchImpl: innerFetch });
    let innerResult: unknown;
    const gateway = createLassoxGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: apiFetch(),
      policy: {
        disabledTools: ['lists_index'],
        audit: async record => {
          outer.audit(record);
          if (record.action === 'start' && innerResult === undefined) {
            innerResult = 'pending';
            innerResult = await inner.callTool('lists_index', {}, { caller: 'inner' });
          }
        },
      },
    });

    await gateway.callTool('cvr_search', { query: 'x' }, { caller: 'outer', lassoUserId: 'u-alice' });

    // The inner instance has no policy: lists_index, disabled on the outer one, runs there, and without the outer
    // call's Lasso X user.
    expect(innerResult).toMatchObject({ structuredContent: [{ id: 'shared1' }] });
    expect(innerFetch.mock.calls.map(call => String(call[0]))).toEqual([`${BASE}/tags`]);
    expect(outer.records.map(record => record.caller)).toEqual([callerPseudonym('outer'), callerPseudonym('outer')]);
  });
});
