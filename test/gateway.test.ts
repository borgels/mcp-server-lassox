import { describe, expect, it } from 'vitest';
import { createLassoxGateway, lassoxGatewayTools } from '../src/gateway.js';

describe('Lasso X gateway export', () => {
  it('exposes a curated read-only company intelligence surface', () => {
    expect(lassoxGatewayTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'cvr_search',
      'cvr_get_entity',
      'ownership_graph',
    ]));
    expect(lassoxGatewayTools.every(tool => tool.riskLevel === 'read')).toBe(true);
  });

  it('supports local capability search without upstream calls', async () => {
    const gateway = createLassoxGateway({ apiKey: 'test' });
    const result = await gateway.callTool('search_capabilities', { query: 'ownership' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeTruthy();
  });
});
