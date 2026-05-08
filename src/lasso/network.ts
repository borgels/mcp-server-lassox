import type { LassoClient } from './client.js';
import { parseCvrEntityInput, type CvrEntityInput } from './cvr.js';

export type OwnershipRelationType = 'ownership' | 'votingrights' | 'unknownOwnership';
export type OwnershipEnrichment = 'companyinfo' | 'personinfo' | 'reports' | 'ultimateOwners';

export interface CvrNetworkInput extends CvrEntityInput {
  entityType?: 'person';
}

export interface OwnershipGraphInput {
  ids: string[];
  relationTypes?: OwnershipRelationType[];
  enrichments?: OwnershipEnrichment[];
  ingoingDepth?: number;
  outgoingDepth?: number;
  onDate?: string;
}

export function assertPersonLassoId(lassoId: string): void {
  if (!lassoId.startsWith('CVR-3-')) {
    throw new Error(
      'The Lassox network module is documented only for persons (CVR-3-{personId}).',
    );
  }
}

const LASSO_ID_PATTERN = /^CVR-[123]-\d+$/;

export async function getCvrNetwork(
  client: LassoClient,
  input: CvrNetworkInput,
): Promise<unknown> {
  const lassoId = parseCvrEntityInput(input);
  assertPersonLassoId(lassoId);
  return client.get(`/modules/network/${lassoId}`);
}

export async function getOwnershipGraph(
  client: LassoClient,
  input: OwnershipGraphInput,
): Promise<unknown> {
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    throw new Error('Provide at least one Lasso ID in ids.');
  }

  for (const id of input.ids) {
    if (!LASSO_ID_PATTERN.test(id)) {
      throw new Error(`Invalid Lasso ID in ids: ${id}. Expected CVR-1-, CVR-2-, or CVR-3- prefix.`);
    }
  }

  const body: Record<string, unknown> = {
    ids: input.ids,
    relationTypes: input.relationTypes ?? ['ownership'],
  };

  if (input.enrichments && input.enrichments.length > 0) {
    body.enrichments = input.enrichments;
  }
  if (input.ingoingDepth !== undefined) {
    body.ingoingDepth = input.ingoingDepth;
  }
  if (input.outgoingDepth !== undefined) {
    body.outgoingDepth = input.outgoingDepth;
  }
  if (input.onDate) {
    body.onDate = input.onDate;
  }

  return client.post('/modules/relations/graph', undefined, body);
}
