import type { LassoClient } from './client.js';
import { selectFields } from './fields.js';
import type { ListAccessScope } from './identity.js';
import { encodePathSegment } from './path.js';

/**
 * Lassox Lists (tags) API — the bridge between segments curated in the Lasso
 * portal and MCP consumers. Lists are read with getLists/getListEntities;
 * changeListMembers is the only write operation in this server and only
 * touches list membership, never CVR data.
 *
 * Every list read/change is checked against the lists visible to the caller's
 * ListAccessScope (shared lists plus the mapped user's own lists), so a tag id
 * alone is never enough to read or change a list.
 */

const LASSO_ID_PATTERN = /^CVR-[123]-\d+$/;
export const MAX_LIST_CHANGE_IDS = 1000;

/**
 * Fetches the lists visible to the given scope: lists shared across the
 * account plus, when the scope carries a server-derived Lassox user id, that
 * user's private lists. Callers never choose the user id themselves.
 */
export async function getLists(client: LassoClient, scope: ListAccessScope = {}): Promise<unknown> {
  const shared = await client.get<unknown>('/tags');
  if (!scope.userId) {
    return shared;
  }

  const own = await client.get<unknown>('/tags', { userId: scope.userId });
  return mergeListResponses(shared, own);
}

/** Returns the ids of every list visible to the scope. */
export async function getAccessibleListIds(client: LassoClient, scope: ListAccessScope = {}): Promise<Set<string>> {
  return new Set(extractLists(await getLists(client, scope)).map(list => list.id));
}

/**
 * Fails closed unless every tag id is in the caller's visible lists. Unknown
 * and inaccessible ids get the same message so list ids cannot be probed.
 */
export async function assertListsAccessible(
  client: LassoClient,
  scope: ListAccessScope,
  tagIds: string[],
): Promise<void> {
  if (tagIds.length === 0) {
    return;
  }

  const accessible = await getAccessibleListIds(client, scope);
  const denied = tagIds.filter(tagId => !accessible.has(tagId));
  if (denied.length > 0) {
    throw new Error(
      `List not found or not accessible: ${denied.slice(0, 5).join(', ')}. Find list ids with lassox_lists_index.`,
    );
  }
}

interface ListEntry {
  id: string;
  raw: unknown;
}

const LIST_ARRAY_KEYS = ['results', 'tags', 'items', 'data', 'lists'] as const;

function listArray(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === 'object') {
    for (const key of LIST_ARRAY_KEYS) {
      const value = (response as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return [];
}

function extractLists(response: unknown): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const item of listArray(response)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = record.id ?? record.tagId ?? record.Id;
    if ((typeof id === 'string' && id.trim()) || typeof id === 'number') {
      entries.push({ id: String(id).trim(), raw: item });
    }
  }
  return entries;
}

function mergeListResponses(shared: unknown, own: unknown): unknown {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of [...extractLists(shared), ...extractLists(own)]) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push(entry.raw);
    }
  }

  if (Array.isArray(shared)) {
    return merged;
  }
  if (shared && typeof shared === 'object') {
    const key = LIST_ARRAY_KEYS.find(candidate => Array.isArray((shared as Record<string, unknown>)[candidate]));
    if (key) {
      return { ...(shared as Record<string, unknown>), [key]: merged };
    }
  }
  return merged;
}

export interface ListEntitiesInput {
  tagId: string;
  skip?: number;
  take?: number;
  /** Dot-path projection applied to each entity in results. */
  fields?: string[];
}

interface ListEntitiesEnvelope {
  results?: unknown[];
  [key: string]: unknown;
}

export async function getListEntities(
  client: LassoClient,
  input: ListEntitiesInput,
  scope: ListAccessScope = {},
): Promise<unknown> {
  const tagId = (input.tagId ?? '').trim();
  if (!tagId) {
    throw new Error('tagId is required. Find list ids with lassox_lists_index.');
  }
  const encodedTagId = encodePathSegment(tagId, 'tagId');
  await assertListsAccessible(client, scope, [tagId]);

  const envelope = await client.get<ListEntitiesEnvelope>(
    `/tags/${encodedTagId}/entities`,
    { skip: input.skip ?? 0, take: input.take ?? 100 },
  );

  if (input.fields && Array.isArray(envelope?.results)) {
    return { ...envelope, results: envelope.results.map(entity => selectFields(entity, input.fields!)) };
  }

  return envelope;
}

export interface ListChangeInput {
  lassoIds: string[];
  tagsToAdd?: string[];
  tagsToRemove?: string[];
}

export async function changeListMembers(
  client: LassoClient,
  input: ListChangeInput,
  scope: ListAccessScope = {},
): Promise<unknown> {
  const lassoIds = (input.lassoIds ?? []).map(id => id.trim());
  if (lassoIds.length === 0 || lassoIds.length > MAX_LIST_CHANGE_IDS) {
    throw new Error(`Provide 1-${MAX_LIST_CHANGE_IDS} lassoIds.`);
  }

  const invalid = lassoIds.filter(id => !LASSO_ID_PATTERN.test(id));
  if (invalid.length > 0) {
    throw new Error(`Invalid Lasso IDs: ${invalid.slice(0, 5).join(', ')}. Use the CVR-{1|2|3}-{id} format.`);
  }

  const tagsToAdd = (input.tagsToAdd ?? []).map(tag => tag.trim()).filter(Boolean);
  const tagsToRemove = (input.tagsToRemove ?? []).map(tag => tag.trim()).filter(Boolean);
  if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
    throw new Error('Provide at least one list id in tagsToAdd or tagsToRemove.');
  }

  const overlap = tagsToAdd.filter(tag => tagsToRemove.includes(tag));
  if (overlap.length > 0) {
    throw new Error(`Lists cannot appear in both tagsToAdd and tagsToRemove: ${overlap.join(', ')}.`);
  }

  for (const tag of [...tagsToAdd, ...tagsToRemove]) {
    encodePathSegment(tag, 'list id');
  }
  await assertListsAccessible(client, scope, [...new Set([...tagsToAdd, ...tagsToRemove])]);

  const response = await client.post('/tags/change', undefined, {
    lassoIds,
    tagsToAdd,
    tagsToRemove,
  });

  // Lassox returns an empty body on success; echo a summary so the MCP client
  // gets a concrete confirmation of what was requested.
  return {
    ok: true,
    entities: lassoIds.length,
    tagsToAdd,
    tagsToRemove,
    response: response ?? null,
  };
}
