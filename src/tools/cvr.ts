import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { LassoClient } from '../lasso/client.js';
import {
  getCvrEntity,
  getCvrEntityHistory,
  getRelatedEntities,
  searchCvr,
} from '../lasso/cvr.js';

const entityInputShape = {
  lassoId: z
    .string()
    .trim()
    .regex(/^CVR-[123]-\d+$/, 'Use a CVR Lasso ID like CVR-1-34580820.')
    .optional(),
  entityType: z.enum(['company', 'productionUnit', 'person']).optional(),
  id: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
};

const entityInputSchema = z
  .object(entityInputShape)
  .refine(input => Boolean(input.lassoId) || (Boolean(input.entityType) && input.id !== undefined), {
    message: 'Provide either lassoId or both entityType and id.',
  });

const searchFiltersSchema = z
  .object({
    company: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
    postalCode: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    street: z.string().trim().min(1).optional(),
    streetNo: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    floor: z.string().trim().min(1).optional(),
    side: z.string().trim().min(1).optional(),
    protected: z.boolean().optional(),
    email: z.string().trim().min(1).optional(),
    telephone: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    cvr: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  })
  .optional();

export function registerCvrTools(server: McpServer, client: LassoClient): void {
  server.registerTool(
    'cvr_search',
    {
      title: 'Search CVR',
      description:
        'Search Lassox CVR companies and people. Use this to find Lasso IDs before fetching full records. Returns Lassox pagination fields and scores unchanged.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Free-text search, CVR number, Lasso ID, or phone number.'),
        type: z.enum(['company', 'person', 'all']).default('all'),
        status: z.enum(['active', 'inactive', 'all']).default('active'),
        pageSize: z.number().int().min(1).max(100).optional(),
        continuationToken: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Continuation token from a previous search response, sent as cToken.'),
        filters: searchFiltersSchema.describe('Structured filters appended to the Lassox query as filter:value terms.'),
      },
    },
    async input => jsonToolResult(await searchCvr(client, input)),
  );

  server.registerTool(
    'cvr_get_entity',
    {
      title: 'Get CVR Entity',
      description:
        'Fetch current Lassox CVR basic information for a company, production unit, or person. Provide either a Lasso ID or entityType plus id.',
      inputSchema: entityInputSchema,
    },
    async input => jsonToolResult(await getCvrEntity(client, input)),
  );

  server.registerTool(
    'cvr_get_entity_history',
    {
      title: 'Get CVR Entity History',
      description:
        'Fetch historical Lassox CVR basic information. Historical fields include value/from/to/current wrappers where Lassox provides them.',
      inputSchema: entityInputSchema,
    },
    async input => jsonToolResult(await getCvrEntityHistory(client, input)),
  );

  server.registerTool(
    'cvr_get_related',
    {
      title: 'Get Related CVR Entities',
      description:
        'Fetch related CVR entities using documented relations: company to person/place, or productionUnit to company. Set history=true for relation history.',
      inputSchema: entityInputSchema.extend({
        relatedType: z.enum(['person', 'place', 'company']),
        history: z.boolean().default(false),
      }),
    },
    async input => jsonToolResult(await getRelatedEntities(client, input)),
  );
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
