import {
  callWithRateLimitRetry,
  runBatch,
  type BatchItemResult,
} from './batch.js';
import type { LassoClient, QueryValue } from './client.js';
import { selectFields } from './fields.js';

export type CvrEntityType = 'company' | 'productionUnit' | 'person';
export type CvrSearchType = 'company' | 'person' | 'all';
export type CvrSearchStatus = 'active' | 'inactive' | 'all';
export type CvrRelatedType = 'person' | 'place' | 'company';

export interface CvrEntityInput {
  lassoId?: string;
  entityType?: CvrEntityType;
  id?: string | number;
}

export interface CvrSearchFilters {
  company?: string;
  city?: string;
  postalCode?: string | number;
  street?: string;
  streetNo?: string | number;
  floor?: string;
  side?: string;
  protected?: boolean;
  email?: string;
  telephone?: string | number;
  cvr?: string | number;
}

export interface CvrSearchInput {
  query: string;
  type?: CvrSearchType;
  status?: CvrSearchStatus;
  pageSize?: number;
  continuationToken?: string;
  filters?: CvrSearchFilters;
}

const ENTITY_TYPE_CODES: Record<CvrEntityType, '1' | '2' | '3'> = {
  company: '1',
  productionUnit: '2',
  person: '3',
};

const SEARCH_FILTER_NAMES: Record<keyof CvrSearchFilters, string> = {
  company: 'company',
  city: 'city',
  postalCode: 'postalcode',
  street: 'street',
  streetNo: 'streetno',
  floor: 'floor',
  side: 'side',
  protected: 'protected',
  email: 'email',
  telephone: 'telephone',
  cvr: 'cvr',
};

export function buildCvrLassoId(entityType: CvrEntityType, id: string | number): string {
  const normalizedId = String(id).trim();
  if (!/^\d+$/.test(normalizedId)) {
    throw new Error(`CVR ${entityType} id must contain digits only.`);
  }

  return `CVR-${ENTITY_TYPE_CODES[entityType]}-${normalizedId}`;
}

export function parseCvrEntityInput(input: CvrEntityInput): string {
  if (input.lassoId) {
    const lassoId = input.lassoId.trim();
    if (!/^CVR-[123]-\d+$/.test(lassoId)) {
      throw new Error('lassoId must match the CVR Lasso ID format, for example CVR-1-34580820.');
    }

    return lassoId;
  }

  if (!input.entityType || input.id === undefined || input.id === null) {
    throw new Error('Provide either lassoId or both entityType and id.');
  }

  return buildCvrLassoId(input.entityType, input.id);
}

export function buildCvrSearchQuery(query: string, filters: CvrSearchFilters = {}): string {
  const parts = [query.trim()];

  for (const [key, value] of Object.entries(filters) as [keyof CvrSearchFilters, QueryValue][]) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    parts.push(`${SEARCH_FILTER_NAMES[key]}:${value}`);
  }

  return parts.filter(Boolean).join(' ');
}

export async function searchCvr(client: LassoClient, input: CvrSearchInput): Promise<unknown> {
  return client.get('/data/cvr/search', {
    query: buildCvrSearchQuery(input.query, input.filters),
    type: input.type ?? 'all',
    status: input.status ?? 'active',
    pageSize: input.pageSize,
    cToken: input.continuationToken,
  });
}

export async function getCvrEntity(
  client: LassoClient,
  input: CvrEntityInput & { fields?: string[] },
): Promise<unknown> {
  const entity = await client.get(`/${parseCvrEntityInput(input)}`);
  return input.fields ? selectFields(entity, input.fields) : entity;
}

export interface CvrBatchInput {
  items: CvrEntityInput[];
  concurrency?: number;
  /** Dot-path field projection applied to each entity to shrink the response. */
  fields?: string[];
}

export interface CvrBatchEntry {
  index: number;
  /** The resolved Lasso ID, or the raw input when it could not be parsed. */
  label: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface CvrBatchResult {
  total: number;
  succeeded: number;
  failed: number;
  results: CvrBatchEntry[];
}

export interface CvrBatchProgress {
  completed: number;
  total: number;
  label: string;
  ok: boolean;
  error?: string;
}

export interface CvrBatchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CvrBatchProgress) => void | Promise<void>;
}

/** Resolves a human-readable label for an item without throwing on bad input. */
function entityLabel(input: CvrEntityInput): string {
  try {
    return parseCvrEntityInput(input);
  } catch {
    if (input.lassoId) {
      return input.lassoId;
    }
    if (input.entityType && input.id !== undefined && input.id !== null) {
      return `${input.entityType}:${input.id}`;
    }
    return '(invalid item)';
  }
}

/**
 * Fetches current basic information for many CVR entities in one tool call.
 * Lassox has no native batch endpoint, so this fans out single-entity GETs with
 * bounded concurrency, retries HTTP 429 (respecting retry-after), and isolates
 * per-item failures so one bad lookup never sinks the rest of the batch.
 */
export async function getCvrEntitiesBatch(
  client: LassoClient,
  input: CvrBatchInput,
  options: CvrBatchOptions = {},
): Promise<CvrBatchResult> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Provide at least one entity in items.');
  }

  const labels = input.items.map(entityLabel);

  const settled = await runBatch(
    input.items,
    item =>
      callWithRateLimitRetry(() => getCvrEntity(client, { ...item, fields: input.fields }), {
        signal: options.signal,
      }),
    {
      concurrency: input.concurrency,
      signal: options.signal,
      onProgress: options.onProgress
        ? async (completed, total, last) => {
            await options.onProgress?.({
              completed,
              total,
              label: labels[last.index] ?? '(unknown)',
              ok: last.ok,
              error: last.ok ? undefined : last.error,
            });
          }
        : undefined,
    },
  );

  return summarizeBatch(settled, labels);
}

function summarizeBatch(settled: BatchItemResult<unknown>[], labels: string[]): CvrBatchResult {
  const results: CvrBatchEntry[] = settled.map(item =>
    item.ok
      ? { index: item.index, label: labels[item.index] ?? '(unknown)', ok: true, data: item.value }
      : { index: item.index, label: labels[item.index] ?? '(unknown)', ok: false, error: item.error },
  );

  const succeeded = results.filter(entry => entry.ok).length;

  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export async function getCvrEntityHistory(client: LassoClient, input: CvrEntityInput): Promise<unknown> {
  return client.get(`/${parseCvrEntityInput(input)}/history`);
}

export async function getRelatedEntities(
  client: LassoClient,
  input: CvrEntityInput & { relatedType: CvrRelatedType; history?: boolean },
): Promise<unknown> {
  const lassoId = parseCvrEntityInput(input);
  assertSupportedRelation(lassoId, input.relatedType);

  const historySuffix = input.history ? '/history' : '';
  return client.get(`/${lassoId}/related/${input.relatedType}${historySuffix}`);
}

function assertSupportedRelation(lassoId: string, relatedType: CvrRelatedType): void {
  const entityCode = lassoId.split('-')[1];

  if (entityCode === '1' && (relatedType === 'person' || relatedType === 'place')) {
    return;
  }

  if (entityCode === '2' && relatedType === 'company') {
    return;
  }

  throw new Error(
    'Unsupported related entity combination. Lassox documents company -> person/place and productionUnit -> company.',
  );
}
