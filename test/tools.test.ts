import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCapabilities } from '../src/lasso/capabilities.js';
import { LassoClient } from '../src/lasso/client.js';
import { checkToolPolicy } from '../src/lasso/policy.js';
import { registerCvrTools, type RegisterCvrToolsOptions } from '../src/tools/cvr.js';

const originalAuditLog = process.env.LASSO_AUDIT_LOG;
let tempDir: string | undefined;

describe('Lassox tool hardening', () => {
  afterEach(async () => {
    delete process.env.LASSO_ENABLE_WRITES;
    if (originalAuditLog === undefined) {
      delete process.env.LASSO_AUDIT_LOG;
    } else {
      process.env.LASSO_AUDIT_LOG = originalAuditLog;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers discovery and correct annotations for every tool', () => {
    const registered = captureRegisteredTools();

    expect(Object.keys(registered)).toEqual([
      'lassox_search_capabilities',
      'cvr_search',
      'cvr_segment_search',
      'cvr_get_entity',
      'cvr_batch_get_entities',
      'cvr_get_entity_history',
      'cvr_get_reports',
      'lassox_financial_analysis',
      'cvr_get_network',
      'cvr_get_ownership_graph',
      'creditsafe_get_rating',
      'teledata_get_company_phones',
      'teledata_lookup_phone',
      'lassox_lists_index',
      'lassox_list_get_entities',
      'cvr_get_changes',
      'cvr_get_related',
    ]);

    // The write tool is only registered when explicitly enabled.
    process.env.LASSO_ENABLE_WRITES = 'true';
    expect(Object.keys(captureRegisteredTools())).toContain('lassox_list_change');
    const withWrites = captureRegisteredTools();
    Object.assign(registered, withWrites);

    const writeTools = new Set(['lassox_list_change']);

    for (const [name, tool] of Object.entries(registered)) {
      expect(tool.config.annotations).toEqual({
        readOnlyHint: !writeTools.has(name),
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('searches capability metadata for MCP clients', () => {
    const results = searchCapabilities('history');

    expect(results.map(result => result.id)).toContain('cvr_get_entity_history');
    expect(results[0]?.examples.length).toBeGreaterThan(0);
  });

  it('keeps the policy allowlist explicit about reads and the single write', () => {
    expect(checkToolPolicy('cvr_search')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('cvr_segment_search')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('cvr_batch_get_entities')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('cvr_get_reports')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('cvr_get_changes')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('lassox_financial_analysis')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('lassox_lists_index')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('lassox_list_get_entities')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('cvr_get_network')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('cvr_get_ownership_graph')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('creditsafe_get_rating')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('teledata_get_company_phones')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('teledata_lookup_phone')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('lassox_list_change', {})).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('LASSO_ENABLE_WRITES'),
    });
    expect(checkToolPolicy('lassox_list_change', { LASSO_ENABLE_WRITES: 'false' })).toMatchObject({ allowed: false });
    expect(checkToolPolicy('lassox_list_change', { LASSO_ENABLE_WRITES: 'true' })).toMatchObject({
      allowed: true,
      reason: 'allowlisted Lassox write tool (list membership only)',
    });
    expect(checkToolPolicy('cvr_delete_entity')).toMatchObject({ allowed: false });
  });

  it('audits tool calls without writing raw targets or secrets', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lassox-audit-'));
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.LASSO_AUDIT_LOG = auditPath;
    const registered = captureRegisteredTools();

    const discoveryTool = registered.lassox_search_capabilities;
    if (!discoveryTool) {
      throw new Error('lassox_search_capabilities was not registered');
    }

    await discoveryTool.handler({ query: 'company', limit: 5 });

    const auditText = await readFile(auditPath, 'utf8');
    const records = auditText
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tool: 'lassox_search_capabilities',
      action: 'start',
    });
    expect(records[1]).toMatchObject({
      tool: 'lassox_search_capabilities',
      action: 'finish',
      status: 'ok',
    });
    expect(auditText).not.toContain('company');
    expect(auditText).not.toContain('lasso-api-key');
  });
});

describe('Lassox list tools identity scoping', () => {
  afterEach(() => {
    delete process.env.LASSO_ENABLE_WRITES;
  });

  it('does not accept a caller-supplied userId on lassox_lists_index', () => {
    const registered = captureRegisteredTools();
    const schema = registered.lassox_lists_index?.config.inputSchema as Record<string, unknown>;
    expect(Object.keys(schema ?? {})).toEqual([]);
  });

  it('uses the server-derived scope and fails closed when it cannot be resolved', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      const userId = url.searchParams.get('userId');
      return new Response(JSON.stringify(userId === 'u-alice' ? [{ id: 'alice1' }] : [{ id: 'shared1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const scoped = captureRegisteredTools({ getListScope: () => ({ userId: 'u-alice' }) }, fetchMock);
    await scoped.lassox_lists_index!.handler({ userId: 'u-bob' });
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls).toContain('https://example.test/tags?userId=u-alice');
    expect(urls.some(url => url.includes('u-bob'))).toBe(false);

    const denied = captureRegisteredTools(
      {
        getListScope: () => {
          throw new Error('No verified caller identity.');
        },
      },
      fetchMock,
    );
    await expect(denied.lassox_lists_index!.handler({})).rejects.toThrow('No verified caller identity');
    await expect(denied.lassox_list_get_entities!.handler({ tagId: 'shared1' })).rejects.toThrow(
      'No verified caller identity',
    );
  });

  it('denies lassox_list_change at call time when writes are disabled', async () => {
    process.env.LASSO_ENABLE_WRITES = 'true';
    const registered = captureRegisteredTools();
    delete process.env.LASSO_ENABLE_WRITES;

    await expect(
      registered.lassox_list_change!.handler({ lassoIds: ['CVR-1-1'], tagsToAdd: ['shared1'] }),
    ).rejects.toThrow('LASSO_ENABLE_WRITES');
  });
});

function captureRegisteredTools(
  options?: RegisterCvrToolsOptions,
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>> = vi.fn<typeof fetch>(),
): Record<
  string,
  {
    config: { annotations?: unknown; inputSchema?: unknown };
    handler: (input: Record<string, unknown>) => Promise<unknown>;
  }
> {
  const registered: Record<
    string,
    {
      config: { annotations?: unknown };
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }
  > = {};
  const server = {
    registerTool: vi.fn((name: string, config: { annotations?: unknown }, handler) => {
      registered[name] = { config, handler };
    }),
  };
  const client = new LassoClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });

  registerCvrTools(server as never, client, options);

  return registered;
}
