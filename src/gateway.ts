import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { formatUnknownError, MAX_REDACT_DEPTH, redactCredentialPatterns } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import { writeAuditEvent } from './lasso/audit.js';
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, LassoClient, type LassoClientOptions } from './lasso/client.js';
import {
  canonicalToolName,
  currentListScope,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './lasso/scope.js';
import { registerCvrTools } from './tools/cvr.js';
import { REDACTION_MARKER, SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Handlers, input schemas, policy checks and
 * audit are shared with the MCP server in src/tools/cvr.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API key passed to createLassoxGateway
 * and redacts results, errors and audit records with its own key only.
 *
 * A gateway instance reads no LASSO_* variable: not LASSO_API_KEY,
 * LASSO_BASE_URL or LASSO_TIMEOUT_MS (options and defaults instead), not
 * LASSO_ENABLE_WRITES or LASSO_AUDIT_LOG (the host's `policy` instead; without
 * one, writes are off and nothing is audited), and not LASSO_USER_MAP,
 * LASSO_DEFAULT_USER_ID or LASSO_TRUST_FORWARDED_USER (lists are the shared
 * lists, plus a Lasso X user's private lists only when the host names that
 * user in the call context).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor, caller or list user.
 */

export type { AuditSink, InstancePolicy } from './lasso/scope.js';
export { GatewayConfigError } from './lasso/scope.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

/**
 * Who and which request a call belongs to (written to the audit records of the call, the caller only as a
 * pseudonym), and the Lasso X user whose private lists the call may see and change (`lassoUserId`, optional).
 */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/**
 * One Lasso X API request a tool may make: the method and the path template on the configured base URL
 * (`{lassoId}` is a CVR Lasso ID such as CVR-1-34580820, `{tagId}` a list id).
 */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Lasso X request the tool may make. Empty for a tool that does not call Lasso X. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. No gateway tool is
   * broad: every tool reads one fixed kind of Lasso X data. `cvr_get_changes`
   * reads many entities at once, but only the CVR change feed its name says,
   * and `cvr_segment_search` only CVR company records.
   */
  readonly broad: boolean;
}

export interface LassoxGatewayOptions
  extends Omit<LassoClientOptions, 'apiKey' | 'baseUrl' | 'credentialEnv' | 'redactor'> {
  /** The customer's Lasso X API key (sent as the lasso-api-key header). Required; never read from the environment. */
  apiKey: string;
  /** Lasso X API base URL. Default https://api.lassox.com; never read from the environment. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 30000; never read from the environment. */
  timeoutMs?: number;
  /**
   * Instance policy from the host (see InstancePolicy). Without it the
   * instance has writes off, no disabled tools and no audit.
   */
  policy?: InstancePolicy;
}

const get = (path: string): GatewayUpstreamOperation => ({ method: 'GET', path });
const post = (path: string): GatewayUpstreamOperation => ({ method: 'POST', path });

/** The gateway's tools: a curated subset of the MCP server's tools, with their own names and titles. */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  /** The MCP server's name of the tool. */
  registered: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstreamOperation[];
  broad?: boolean;
}> = [
  {
    name: 'search_capabilities',
    registered: 'lassox_search_capabilities',
    title: 'Search Lasso X capabilities',
    description: 'Find the Lasso X tools this connection offers for CVR data, company intelligence, ownership and lists.',
    riskLevel: 'read',
    summary: 'Lasso X capabilities.',
    upstream: [],
  },
  {
    name: 'cvr_search',
    registered: 'cvr_search',
    title: 'Search CVR',
    description: 'Search Danish companies and people through Lasso X CVR data.',
    riskLevel: 'read',
    summary: 'CVR search results.',
    upstream: [get('/data/cvr/search')],
  },
  {
    name: 'cvr_get_entity',
    registered: 'cvr_get_entity',
    title: 'Get CVR entity',
    description: 'Fetch current CVR basic information for a company, production unit, or person.',
    riskLevel: 'read',
    summary: 'CVR entity.',
    upstream: [get('/{lassoId}')],
  },
  {
    name: 'cvr_get_entity_history',
    registered: 'cvr_get_entity_history',
    title: 'Get CVR entity history',
    description: 'Fetch historical CVR basic information from Lasso X.',
    riskLevel: 'read',
    summary: 'CVR entity history.',
    upstream: [get('/{lassoId}/history')],
  },
  {
    name: 'cvr_get_reports',
    registered: 'cvr_get_reports',
    title: 'Get CVR reports',
    description: 'Fetch annual report key figures for a Danish company.',
    riskLevel: 'read',
    summary: 'CVR annual report key figures.',
    upstream: [get('/{lassoId}/reports')],
  },
  {
    name: 'financial_analysis',
    registered: 'lassox_financial_analysis',
    title: 'Get Lasso X financial analysis',
    description: 'Run the Lasso X financial analysis module for a Danish company.',
    riskLevel: 'read',
    summary: 'Lasso X financial analysis.',
    upstream: [post('/modules/reportanalysis/{lassoId}')],
  },
  {
    name: 'cvr_segment_search',
    registered: 'cvr_segment_search',
    title: 'Segment search (firmographic discovery)',
    description:
      'Discover companies by industry code prefix, employee count, company form, and founding date within a postal-code geography. Bounded scan; resume with continuationToken.',
    riskLevel: 'read',
    summary: 'CVR segment search results.',
    upstream: [get('/data/cvr/search'), get('/{lassoId}')],
  },
  {
    name: 'lists_index',
    registered: 'lassox_lists_index',
    title: 'List Lasso X lists (tags)',
    description:
      'Fetch the Lasso X lists (tags) visible to the caller: lists shared across the account, plus the private lists of the Lasso X user the connection names for the caller, if any.',
    riskLevel: 'read',
    summary: 'Lasso X lists.',
    upstream: [get('/tags')],
  },
  {
    name: 'list_get_entities',
    registered: 'lassox_list_get_entities',
    title: 'Get Lasso X list members',
    description: 'Fetch the entities in a Lasso X list (tag) visible to the caller, with skip/take pagination.',
    riskLevel: 'read',
    summary: 'Lasso X list members.',
    upstream: [get('/tags'), get('/tags/{tagId}/entities')],
  },
  {
    name: 'list_change',
    registered: 'lassox_list_change',
    title: 'Change Lasso X list membership',
    description:
      'Add or remove entities (Lasso IDs) to/from Lasso X lists (tags) visible to the caller. Write operation: changes list membership only, never CVR data.',
    riskLevel: 'write',
    summary: 'Lasso X list membership changed.',
    upstream: [get('/tags'), post('/tags/change')],
  },
  {
    name: 'cvr_get_changes',
    registered: 'cvr_get_changes',
    title: 'Get CVR changes (delta)',
    description:
      'Fetch entities changed since a timestamp (companies, persons, places, or reports) for downstream sync.',
    riskLevel: 'read',
    summary: 'CVR changes.',
    upstream: [
      get('/data/cvr/company/delta'),
      get('/data/cvr/company/delta/history'),
      get('/data/cvr/person/delta'),
      get('/data/cvr/person/delta/history'),
      get('/data/cvr/place/delta'),
      get('/data/cvr/place/delta/history'),
      get('/data/cvr/reports/delta'),
    ],
  },
  {
    name: 'ownership_graph',
    registered: 'cvr_get_ownership_graph',
    title: 'Get ownership graph',
    description: 'Build an ownership and voting-rights graph for one or more CVR entities.',
    riskLevel: 'read',
    summary: 'CVR ownership graph.',
    upstream: [post('/modules/relations/graph')],
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/** A tool's zod input schema, strict: an unknown field is refused, not dropped. */
function strictSchema(inputSchema: unknown): z.ZodType {
  if (inputSchema instanceof z.ZodObject) {
    // Keeps the schema's refinements (for example "lassoId or entityType and id").
    return inputSchema.strict();
  }
  if (inputSchema instanceof z.ZodType) {
    return inputSchema;
  }
  return z.strictObject((inputSchema ?? {}) as z.ZodRawShape);
}

/**
 * The MCP server's tools as registered: the strict zod input schema and the
 * handler bound to `client`. The write tool is always registered here; the
 * policy check refuses it unless the host enabled writes. Lists are scoped by
 * the call scope (the host's Lasso X user, or shared lists only).
 */
function registeredTools(client: LassoClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: unknown }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: strictSchema(config.inputSchema), handler });
    },
  };
  registerCvrTools(server as never, client, {
    getListScope: () => currentListScope() ?? {},
    registerWriteTools: true,
  });
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new LassoClient({ apiKey: 'schema-only', credentialEnv: {}, redactor: new SecretRedactor(), timeoutMs: 1 }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(tool.registered);
  if (!registered) {
    throw new Error(`Lasso X gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions. */
export const lassoxGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `lassoxGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const lassoxToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

/** The MCP server names of the gateway tools. */
const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => tool.registered);
const SUMMARIES: ReadonlyMap<string, string> = new Map(GATEWAY_TOOLS.map(tool => [tool.registered, tool.summary]));
const GATEWAY_NAMES: ReadonlyMap<string, string> = new Map(GATEWAY_TOOLS.map(tool => [tool.registered, tool.name]));

function requiredKey(options: LassoxGatewayOptions | undefined): string {
  const value: unknown = options?.apiKey;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(
      'createLassoxGateway requires options.apiKey. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new GatewayConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/** A caller or request id from the host: redacted before it is cut short, so no part of a key survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/** What a Lasso X user id from the host may look like: it is sent to Lasso X as a query value, never shown. */
const LASSO_USER_ID = /^[A-Za-z0-9._@:-]{1,128}$/;

/**
 * Create one gateway instance. `apiKey` is required and is the only
 * credential the instance uses; a missing or refused key fails here, before
 * anything is built or sent.
 */
export function createLassoxGateway(options: LassoxGatewayOptions) {
  let apiKey: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const given: unknown = (options as Partial<LassoxGatewayOptions> | undefined)?.apiKey;
  const secrets = typeof given === 'string' ? [given, given.trim()] : [];
  try {
    // Admission first, before a redactor is built from the key.
    apiKey = requiredKey(options);
    guard = new SecretRedactor().addSecret(apiKey);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(keyRefusedText(apiKey));
    }
    const gateway = buildLassoxGateway(options, apiKey, guard);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(keyRefusedText(apiKey));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && apiKey !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the key becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = keyRefusedText(apiKey);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the key. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && apiKey !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(keyRefusedText(apiKey)), ...secrets);
    }
    throw final;
  }
}

function buildLassoxGateway(options: LassoxGatewayOptions, apiKey: string, redactor: SecretRedactor) {
  const {
    policy: hostPolicy,
    apiKey: _key,
    baseUrl,
    timeoutMs,
    // Not gateway options: dropped even when a host passes them.
    credentialEnv: _credentialEnv,
    redactor: _redactor,
    ...clientOptions
  } = options as LassoxGatewayOptions & Pick<LassoClientOptions, 'credentialEnv' | 'redactor'>;
  // Always a resolved policy, so a gateway call never falls back to the environment.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  const client = new LassoClient({
    ...clientOptions,
    apiKey,
    baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    credentialEnv: {},
    redactor,
  });
  const handlers = registeredTools(client);
  const offeredTools: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: lassoxGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      const lassoUserId: unknown = context?.lassoUserId;
      const userIdValid =
        lassoUserId === undefined || (typeof lassoUserId === 'string' && LASSO_USER_ID.test(lassoUserId.trim()));
      // Every call in a scope of its own.
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          ...(typeof lassoUserId === 'string' && userIdValid ? { lassoUserId: lassoUserId.trim() } : {}),
          offeredTools,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data: it is not redacted again as text, which could break the JSON. An error result is our own text, and
        // is redacted as a whole.
        () =>
          (userIdValid
            ? runCall(toolName, input)
            : Promise.resolve(errorResult('Invalid call context: lassoUserId must be a Lasso X user id.'))
          ).then(result => {
            const final = result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result;
            // The sink check, as the very last step: a result that holds a piece of the key anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Lasso X gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = GATEWAY_NAMES.get(name) ?? name;
        return errorResult(formatUnknownError(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`));
      }

      const result = await tool.handler(parsed.data as Record<string, unknown>);
      return normalizeResult(result, redactor, SUMMARIES.get(name) ?? 'Lasso X gateway result.');
    } catch (error) {
      return errorResult(formatUnknownError(error));
    }
  }
}

/**
 * Field names whose value is a credential whatever it looks like: the value of
 * such a field is replaced whole, not only when it matches a pattern.
 */
const CREDENTIAL_NAME =
  /^x?(authorization|proxyauthorization|cookie|setcookie|lassoapikey|(access|refresh|id|session|bearer|auth|api|private|secret|subscription)(token|key)|token|apisecret|clientsecret|secret|password|passwd|credentials?)$/;

/**
 * Whether a field name names a credential, however it is written: case, `-`,
 * `_`, spaces and a leading `x-` do not matter (`accessToken`, `access_token`,
 * `X-Api-Key`, `lasso-api-key`, `api-key`).
 */
function isCredentialField(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase().replace(/[-_\s.]/g, ''));
}

/**
 * One text as a gateway may return it: credential-shaped text masked, then the instance's own secrets, then the
 * patterns again (they take the marker as part of a value), until nothing changes.
 */
function redactText(value: string, redactor: SecretRedactor): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactor.redact(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the credential patterns and the redactor, the value of every
 * credential-named field (isCredentialField) replaced whole, whatever its
 * type, and every number or boolean whose string form would be redacted
 * replaced by the string "‹redacted›". Anything nested deeper than
 * MAX_REDACT_DEPTH is replaced, never passed on.
 */
function redactDeep(value: unknown, redactor: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactText(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactText(text, redactor) !== text) return REDACTION_MARKER;
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactText(key, redactor),
      // The whole value of a credential-named field, whatever its type: a list or an object under it is a credential too.
      isCredentialField(key) && entry !== null && entry !== undefined ? REDACTION_MARKER : redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createLassoxGateway. */
export type LassoxGateway = ReturnType<typeof createLassoxGateway>;

/**
 * The handler's result as the gateway returns it. The handler's text is
 * never kept: its data is parsed, redacted twice (values, keys and numbers by
 * their string form), and only then serialised again after the summary, so a
 * key cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor, summary: string): GatewayToolResult {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { content?: unknown }).content)) {
    // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
    return jsonResult(summary, redactDeep(redactDeep(result, redactor), redactor));
  }

  const content = (result as { content: Array<{ type?: unknown; text?: unknown }> }).content;
  const text = content[0]?.text;
  if (typeof text === 'string') {
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = undefined;
    }
    if (data !== undefined) {
      // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
      return jsonResult(summary, redactDeep(redactDeep(data, redactor), redactor));
    }
  }
  // Not JSON: each text redacted on its own.
  return {
    content: content
      .filter((entry): entry is { type: 'text'; text: string } => typeof entry.text === 'string')
      .map(entry => ({ type: 'text' as const, text: redactText(entry.text, redactor) })),
  };
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
