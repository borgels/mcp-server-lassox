# mcp-server-lassox

TypeScript MCP server for the Lassox CVR API. It is intentionally boring good:
typed, documented, read-first, policy-aware, credential-sane, and
audit-friendly.

This is an independent, unofficial project. It is not developed, endorsed or supported by Lasso X.

> "Lassox" / "Lasso X" and the CVR API are referenced only to describe what this
> server talks to. You need your own Lassox API key, and use of the Lassox API is
> subject to Lassox's own terms.

## Scope

Supported Lassox APIs:

- Search companies and people.
- Fetch current company, production unit, or person data.
- Fetch historical company, production unit, or person data.
- Fetch documented related entities.
- Fetch annual report key figures (nøgletal) for companies.
- Run the Lassox Financial Analysis (Regnskabsanalyse) module on companies.
- Fetch a person's professional network (Lassox Network module).
- Build ownership / voting-rights graphs with optional UBO and report enrichment (Lassox Ownership Structure module).
- Fetch Creditsafe credit ratings for companies (Lassox Creditsafe data API).
- Look up registered phone numbers for a company, or reverse-lookup a phone number (Lassox Teledata data API).
- Discover companies by firmographic criteria — industry, employees, form, founding date — within a postal-code geography (`cvr_segment_search`).
- Read lists (tags) curated in the Lasso portal and change list membership (Lassox Lists API).
- Fetch entities changed since a timestamp for downstream sync (Lassox delta endpoints).

Report PDFs, monitoring, webhooks, and other non-CVR Lassox APIs are intentionally out of scope.

## Setup

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Set your Lassox API key in the MCP server environment. The server sends it as the documented `lasso-api-key` header and never accepts API keys as tool arguments.

```sh
export LASSO_API_KEY="your-api-key"
```

Optional hardening settings:

```sh
export LASSO_TIMEOUT_MS=30000
export LASSO_AUDIT_LOG="/absolute/path/to/lassox-audit.jsonl"
```

List access and writes (see [Lists and caller identity](#lists-and-caller-identity)):

```sh
export LASSO_ENABLE_WRITES=false            # set to true to enable lassox_list_change
export LASSO_DEFAULT_USER_ID=""             # single-user deployments: whose private lists are visible
export LASSO_TRUST_FORWARDED_USER=false     # HTTP behind a trusted gateway only
export LASSO_USER_MAP="alice@example.com=lassox-user-id"
```

## Claude Or Cursor Config

Use the stdio server for local agent clients:

```json
{
  "mcpServers": {
    "lassox": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-lassox/dist/stdio.js"],
      "env": {
        "LASSO_API_KEY": "your-api-key",
        "LASSO_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

During development, you can point the command at `npm`:

```json
{
  "mcpServers": {
    "lassox": {
      "command": "npm",
      "args": ["run", "dev", "--prefix", "/absolute/path/to/mcp-server-lassox"],
      "env": {
        "LASSO_API_KEY": "your-api-key",
        "LASSO_AUDIT_LOG": "/absolute/path/to/lassox-audit.jsonl"
      }
    }
  }
}
```

## Start Here

Use `lassox_search_capabilities` first when an MCP client needs to decide which CVR tool to call. It returns tool descriptions, examples, identifier formats, and safety notes without calling Lassox.

```json
{
  "query": "company history",
  "limit": 5
}
```

## Tools

All tools are read-only — except `lassox_list_change`, which changes Lassox list membership (never CVR data). Every tool is registered with MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`) so clients can reason about safety.

### `lassox_search_capabilities`

Search the server's CVR capabilities.

Example:

```json
{
  "query": "related person"
}
```

### `cvr_search`

Find companies or people before fetching full records.

Example:

```json
{
  "query": "Lasso X",
  "type": "company",
  "pageSize": 5
}
```

Optional inputs include `status`, `continuationToken`, and structured `filters` such as `city`, `postalCode`, `street`, `email`, `telephone`, and `cvr`. Filters are converted to Lassox's documented `filter:value` query syntax.

### `cvr_get_entity`

Fetch current CVR basic information.

```json
{
  "entityType": "company",
  "id": "34580820"
}
```

You can also pass a full Lasso ID:

```json
{
  "lassoId": "CVR-1-34580820"
}
```

Structured IDs map as follows:

- `company` -> `CVR-1-{cvr}`
- `productionUnit` -> `CVR-2-{pNumber}`
- `person` -> `CVR-3-{personId}`

Pass `fields` to project the response down to just the dot-paths you need (a
full record is ~14 KB). Paths descend nested objects and map over arrays:

```json
{
  "lassoId": "CVR-1-34580820",
  "fields": ["name", "cvr", "status", "address.streetName", "address.postalCode", "industry.text"]
}
```

### `cvr_batch_get_entities`

Fetch current CVR basic information for many entities in one call. Lassox has no
native batch endpoint, so this fans out single-entity lookups with bounded
concurrency, retries rate-limit (HTTP 429) responses while honouring
`retry-after`, and isolates per-item failures so one bad lookup never sinks the
rest of the batch.

```json
{
  "items": [
    { "entityType": "company", "id": "34580820" },
    { "lassoId": "CVR-1-24256790" },
    { "entityType": "person", "id": "4004094652" }
  ],
  "concurrency": 8,
  "fields": ["name", "cvr", "status", "address.postalCode", "industry.text"]
}
```

- `items`: 1–100 entries, each either `{ lassoId }` or `{ entityType, id }`.
- `concurrency`: optional, 1–20 (default 8). Lassox allows 500 requests/minute per API key.
- `fields`: optional dot-path projection applied to every entity. Paths descend
  nested objects and map over arrays (e.g. `management.members.name`). Strongly
  recommended for large batches — projecting a 100-item batch down to a handful
  of fields shrinks the response from well over 1 MB to tens of kilobytes.

The response summarises the run and preserves input order:

```json
{
  "total": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "index": 0, "label": "CVR-1-34580820", "ok": true, "data": { } },
    { "index": 1, "label": "CVR-1-24256790", "ok": true, "data": { } },
    { "index": 2, "label": "CVR-3-4004094652", "ok": false, "error": "Lasso X API request failed with HTTP 404 | Lasso X found nothing at this address. Check the ids." }
  ]
}
```

When the MCP client includes a `progressToken` in the request, the server emits
`notifications/progress` as each item settles (`progress` = items completed,
`total` = batch size, `message` = e.g. `2/3 — CVR-1-24256790 ok`), so the client
can show live progress for large batches.

### `cvr_get_entity_history`

Fetch historical CVR basic information:

```json
{
  "lassoId": "CVR-1-34580820"
}
```

Historical responses are returned unchanged from Lassox, including `value`, `from`, `to`, and `current` wrappers.

### `cvr_get_reports`

Fetch annual report key figures (nøgletal) for a Danish company. Returns Lassox JSON converted from XBRL with metadata, balance-sheet items, EBITDA, employees, auditors, and optional group reports.

```json
{
  "entityType": "company",
  "id": "34580820"
}
```

Optional ISO 4217 `currency` code triggers Lassox currency conversion:

```json
{
  "lassoId": "CVR-1-34580820",
  "currency": "EUR"
}
```

Only company Lasso IDs (`CVR-1-*`) are accepted; production units and persons are rejected before the request reaches Lassox.

### `lassox_financial_analysis`

Run the Lassox Financial Analysis (Regnskabsanalyse) module on a Danish company. Returns a textual analysis (HTML-formatted, e.g. `<br/>`, `<ul>`) covering gross profit, EBITDA, balance sheet, working capital, and credit policy, plus the latest and previous reports.

```json
{
  "entityType": "company",
  "id": "34580820"
}
```

This tool calls the Lassox **Module API** at `POST /modules/reportanalysis/{lassoId}` and may require a separate subscription on your Lassox account. Only company Lasso IDs are accepted.

### `cvr_get_network`

Fetch a person's professional network — every company they have been connected to, current roles, and time-overlapping relations with other people.

```json
{
  "entityType": "person",
  "id": "4004094652"
}
```

Only person Lasso IDs (`CVR-3-*`) are accepted. This calls the Lassox **Module API** at `GET /modules/network/{lassoId}` and may require a separate subscription.

### `cvr_get_ownership_graph`

Build an ownership and voting-rights graph for one or more entities, with optional enrichment.

```json
{
  "ids": ["CVR-1-34580820"],
  "relationTypes": ["ownership"],
  "enrichments": ["companyinfo", "ultimateOwners"],
  "outgoingDepth": 2
}
```

Inputs:

- `ids` — 1–25 Lasso IDs (`CVR-1-*`, `CVR-2-*`, or `CVR-3-*`) to seed the graph.
- `relationTypes` — any of `ownership`, `votingrights`, `unknownOwnership` (default `["ownership"]`).
- `enrichments` — any of `companyinfo`, `personinfo`, `reports`, `ultimateOwners`.
- `ingoingDepth`, `outgoingDepth` — 0–10. Higher values traverse more edges and can produce large responses; start small.
- `onDate` — optional `YYYY-MM-DD` for a historical snapshot.

This calls the Lassox **Module API** at `POST /modules/relations/graph` and may require a separate subscription.

### `creditsafe_get_rating`

Fetch the Creditsafe credit rating for a Danish company. Returns current and previous international + local scores, descriptions, credit max, currency, and a PDF link.

```json
{
  "cvr": "34580820"
}
```

Or use a Lasso ID and force a fresh upstream call:

```json
{
  "lassoId": "CVR-1-34580820",
  "skipCache": true
}
```

Lassox caches Creditsafe responses for 24 hours; `skipCache=true` may incur extra cost.

### `teledata_get_company_phones`

Fetch phone numbers registered to a Danish company.

```json
{
  "lassoId": "CVR-1-34580820"
}
```

Only company Lasso IDs are accepted.

### `teledata_lookup_phone`

Reverse-lookup a Danish phone number — subscriber name, address, supplier, protection codes.

```json
{
  "phoneNumber": "+4570201020",
  "includeCompany": true
}
```

Spaces, dashes and parentheses are stripped from `phoneNumber`. With `includeCompany=true` the response includes CVR data when the number belongs to a company.

### `cvr_get_related`

Fetch documented related entities:

```json
{
  "entityType": "company",
  "id": "34580820",
  "relatedType": "person"
}
```

Supported combinations:

- Company to `person` or `place`.
- Production unit to `company`.

Set `history` to `true` to call the relation history endpoint.

### `cvr_segment_search`

Discover companies matching firmographic criteria within a postal-code geography.

```json
{
  "industryCodes": ["21"],
  "employeesMin": 1000,
  "region": "hovedstaden",
  "maxRequests": 300
}
```

The Lassox search API only supports free text plus address/contact filters
server-side — industry, employees, company form, and founding date are **not**
queryable upstream. This tool therefore scans companies per postal code
(filter-only `postalcode:` searches), fetches candidates with the same bounded,
429-retrying batch machinery as `cvr_batch_get_entities`, and applies the
firmographic criteria locally:

- `industryCodes` — DB07 codes, exact or prefix (`"21"` matches all 21xxxx).
  Checked against `industry` and `altIndustry1-3` (disable the alt industries
  with `includeAltIndustries=false`).
- `employeesMin` / `employeesMax` — uses the registered `employees.count`; when
  only an `ANTAL_*` interval is registered, a company matches if the interval
  overlaps the requested range.
- `companyForms` — form short names such as `A/S`, `ApS` (case-insensitive).
- `foundedAfter` / `foundedBefore` — compared against `lifeTime.from`.
- Geography (required): `postalCodes`, `postalCodeRanges` (`{from,to}`), or
  `region` (`hovedstaden`, `sjaelland`, `syddanmark`, `midtjylland`,
  `nordjylland` — approximated by postal ranges; pass explicit codes where
  boundary precision matters).

Every call is bounded by `maxRequests` (search pages + entity fetches; default
150, max 500). The response reports `matched`, `scanned`, `requestsUsed`,
postal-code `coverage`, and `exhausted`; when `exhausted=false`, pass the
returned `continuationToken` (bound to the criteria) to keep scanning. Progress
notifications are emitted when the client sends a `progressToken`.

Broad segments cost many requests by nature (a whole region can hold hundreds
of thousands of companies), so for nationwide discovery build the segment with
the Lasso portal's target-group search and consume it via the Lists tools below.

### `lassox_lists_index`

Fetch the Lassox lists (tags) visible to the caller — lists shared across the
account plus the caller's own private lists — with id, name, entity count, and
permissions. The tool takes no user id; visibility is derived server-side (see
[Lists and caller identity](#lists-and-caller-identity)).

```json
{}
```

Lists are created and curated in the Lasso portal; the Lists API cannot create
new lists.

### `lassox_list_get_entities`

Fetch the members of a list with `skip`/`take` pagination and optional `fields`
projection. The `tagId` must be one of the lists returned by
`lassox_lists_index` for the same caller:

```json
{
  "tagId": "cHfb90",
  "take": 100,
  "fields": ["lassoId", "name"]
}
```

### `lassox_list_change`

Add or remove entities to/from lists in bulk. **This is the only write tool in
the server** — it changes Lassox list membership, never CVR data — and it is
annotated `readOnlyHint: false` and separately allowlisted in the policy module.
It is **disabled by default**: it is only registered (and allowed by the policy
module) when the server sets `LASSO_ENABLE_WRITES=true`. Every list in
`tagsToAdd`/`tagsToRemove` must be visible to the caller.

```json
{
  "lassoIds": ["CVR-1-34580820"],
  "tagsToAdd": ["cHfb90"],
  "tagsToRemove": []
}
```

1–1000 Lasso IDs per call; at least one of `tagsToAdd`/`tagsToRemove` is
required, and a list cannot appear in both.

### `cvr_get_changes`

Fetch entities changed since a timestamp via the Lassox delta endpoints — for
keeping a CRM or database in sync:

```json
{
  "scope": "company",
  "since": "2026-07-01",
  "pageSize": 50,
  "fields": ["lassoId", "name", "status", "lastUpdated"]
}
```

- `scope` — `company` (default), `person`, `place`, or `reports`.
- `useLastLoad` — defaults to `true` (recommended by Lassox: filters on
  publication time so late-published changes are not missed; upstream flips its
  own default on 2026-08-01). Tune the companion `maxDaysSinceUpdate` if needed.
- `history=true` returns historical value wrappers (not for `reports`);
  `metadataOnly=true` returns report metadata without the figures (`reports` only).
- `lassoIds` filters the returned page client-side to just those entities;
  `fields` projects each result.
- Paginate with `continuationToken` (sent upstream as `cToken`).

For real-time needs, prefer Lassox monitoring/webhooks over tight polling loops.

## Optional HTTP Server

The local stdio transport is the default for agent compatibility. A small Streamable HTTP entrypoint is also available:

```sh
PORT=3000 LASSO_API_KEY="your-api-key" npm run dev:http
```

By default the HTTP server binds to `127.0.0.1`, limits request bodies to 10 MiB
and allows browser CORS only from loopback origins. It refuses to start on any
other bind address, or with `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN`
is set.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port. |
| `MCP_HTTP_TOKEN` | – | Bearer token required on `/mcp`. At least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. Required for any non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve a non-loopback bind without a token (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow every origin (requires `MCP_HTTP_TOKEN`). |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Without it, a loopback bind only accepts localhost names and no check is done on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get 429; `0` disables. Valid tokens are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

`GET /healthz` answers `{"status":"ok"}` without authentication. 401 responses carry
`WWW-Authenticate: Bearer`; invalid JSON gets 400. The server shuts down gracefully on SIGTERM/SIGINT.

The MCP endpoint is `POST http://127.0.0.1:3000/mcp`.

`MCP_HTTP_TOKEN` is compared in constant time. When `LASSO_TRUST_FORWARDED_USER=true`
the server refuses to start unless `MCP_HTTP_TOKEN` is set, and every request
must carry a non-empty `X-MCP-User` header (otherwise `401`).

## Lists and caller identity

Lassox lists are either shared across the account or private to a Lassox user.
The API key can read any user's private lists, so this server never accepts a
user id from the caller. Instead:

- **Behind a trusted gateway (HTTP)**: set `LASSO_TRUST_FORWARDED_USER=true`
  and `MCP_HTTP_TOKEN`. The gateway-verified `X-MCP-User` email is mapped to a
  Lassox user id via `LASSO_USER_MAP` (`email=userId` pairs separated by commas,
  or a JSON object). Mapped callers see shared lists plus their own private
  lists; unmapped callers see shared lists only; requests without the header
  are rejected.
- **Single-user deployments (stdio or HTTP without forwarded identity)**:
  shared lists only, plus the private lists of `LASSO_DEFAULT_USER_ID` if set.
- **Gateway export** (`mcp-server-lassox/gateway`): no mapping from the
  environment (`LASSO_USER_MAP`, `LASSO_DEFAULT_USER_ID` and
  `LASSO_TRUST_FORWARDED_USER` are not read). Without a Lasso X user id from
  the host only shared lists are visible and changeable; the host may name one
  per call with `callTool(name, input, { lassoUserId })` (see
  [Embedding](#embedding-gateway)).

`lassox_list_get_entities` and `lassox_list_change` check every list id against
the caller's visible lists before calling Lassox and fail closed otherwise.

## Verification

Run the default checks without Lassox credentials:

```sh
npm run typecheck
npm test
npm run build
```

Run the optional live smoke test only when you have a valid Lassox API key:

```sh
LASSO_API_KEY="your-api-key" npm run smoke:live
```

## Rate Limits

Lassox documents a limit of 500 requests per minute per API key. If Lassox returns `429`, this server includes the `retry-after` value (whole seconds) in the tool error message.

## Embedding (`./gateway`)

`mcp-server-lassox/gateway` lets a host application run the tools in-process
instead of over MCP, in the same shape as `mcp-server-template`. One process
can run several gateway instances, for example one per tenant.

```ts
import { createLassoxGateway, lassoxToolCatalog } from 'mcp-server-lassox/gateway';

const gateway = createLassoxGateway({ apiKey: tenant.lassoApiKey, policy: { audit: record => log(record) } });
const result = await gateway.callTool('cvr_get_entity', { lassoId: 'CVR-1-34580820' }, { caller: 'user-1', requestId: 'r-1' });
```

The module exports:

- `createLassoxGateway({ apiKey, baseUrl?, fetchImpl?, timeoutMs?, policy? })`.
  `apiKey` is the customer's Lasso X API key, sent as the `lasso-api-key`
  header. It is required and never read from `LASSO_API_KEY`. `baseUrl`
  defaults to `https://api.lassox.com` and is never read from
  `LASSO_BASE_URL`; `timeoutMs` defaults to 30000 and is never read from
  `LASSO_TIMEOUT_MS`. A gateway instance reads no `LASSO_*` variable at all.
- `gateway.tools` (the tools enabled on the instance) and
  `gateway.callTool(name, input, { caller, requestId, lassoUserId })`. Names
  are accepted as the gateway name (`lists_index`) or the MCP server name
  (`lassox_lists_index`), in any case. Input is validated with the tool's zod
  schema before anything is sent, and unknown fields are refused. The audit
  records of the call hold `caller` only as an HMAC pseudonym (a per-process
  key) and a request id of the server's own, the same for every record of the
  call; the host's `requestId` is not written. An error is recorded as a fixed
  code (`http_<status>`, `timeout` or `error`), never as its message.
- `lassoxGatewayTools`: the definitions (`name`, `title`, `description`,
  `riskLevel`, `enabledByDefault`, `inputSchema` as JSON Schema derived from
  the zod schema the call is validated with).
- `lassoxToolCatalog`: the same tools, deeply frozen, with `upstream` (method
  and path template of every Lasso X request the tool may make) and `broad`
  (true when the input chooses what kind of thing is read). Hosts can build
  their own permission model from it without creating an instance.
- `GatewayConfigError` and the types (`LassoxGatewayOptions`, `LassoxGateway`,
  `InstancePolicy`, `AuditSink`, `GatewayToolDefinition`,
  `GatewayToolCatalogEntry`, `GatewayUpstreamOperation`, `GatewayToolResult`,
  `GatewayCallContext` and the JSON types).

| Tool | Risk | Default | Broad | Lasso X requests |
|---|---|---|---|---|
| `search_capabilities` | read | on | no | none |
| `cvr_search` | read | on | no | `GET /data/cvr/search` |
| `cvr_get_entity` | read | on | no | `GET /{lassoId}` |
| `cvr_get_entity_history` | read | on | no | `GET /{lassoId}/history` |
| `cvr_get_reports` | read | on | no | `GET /{lassoId}/reports` |
| `financial_analysis` | read | on | no | `POST /modules/reportanalysis/{lassoId}` |
| `cvr_segment_search` | read | on | no | `GET /data/cvr/search`, `GET /{lassoId}` |
| `lists_index` | read | on | no | `GET /tags` |
| `list_get_entities` | read | on | no | `GET /tags`, `GET /tags/{tagId}/entities` |
| `list_change` | write | off | no | `GET /tags`, `POST /tags/change` |
| `cvr_get_changes` | read | on | no | `GET /data/cvr/{company,person,place}/delta[/history]`, `GET /data/cvr/reports/delta` |
| `ownership_graph` | read | on | no | `POST /modules/relations/graph` |

No tool is broad: each reads one fixed kind of Lasso X data, whatever the
input. `cvr_get_changes` returns many entities at once, but only the CVR
change feed its name says; `cvr_segment_search` reads only CVR company
records. Creditsafe, Teledata, the batch read, the person network and the
related-entities read stay in the MCP server only.

**Lists.** The gateway has no user mapping from the environment. Without
`lassoUserId` in the call context, `lists_index`, `list_get_entities` and
`list_change` see and change only lists shared across the account. With
`lassoUserId` (a Lasso X user id the host has decided this caller may act as)
they also see and change that user's private lists, for that call only. The
id is never taken from tool input.

**Instance policy.** With `policy: { enableWrites, disabledTools, audit }`
the host decides the instance's policy: `list_change` runs only with
`enableWrites: true`, the disabled tools are left out of `tools` (and out of
`search_capabilities`) and refused when called, and the audit records go to
`audit` (none without it). `disabledTools` must name gateway tools. A sink
that throws on a start record refuses the call. Without `policy` the instance
has writes off, no disabled tools and no audit; `LASSO_ENABLE_WRITES` and
`LASSO_AUDIT_LOG` are never read. Every call runs in a call scope of its own
(AsyncLocalStorage), so a call made from inside another instance's call never
inherits its policy, sink, redactor, caller or list user. There is no
process-wide registry of keys.

**Results.** A successful result has `structuredContent` and one text block:
a short summary, a blank line, and the same data as compact JSON. The data
is redacted twice against the instance's key (exact value, URL- and
JSON-encoded forms and any piece of 6 characters or more, in strings, object
keys and the string form of numbers and booleans) and for credential-shaped
text before it is serialised.

**Errors.** An error result carries our own English text, never Lasso X's
response body, message, error code or help link, nor a redirect's `Location`
or the configured address. An HTTP failure reads
`Lasso X API request failed with HTTP <status>`, followed by
` | <our hint>` for 401, 402, 403, 404 and 429 and ` | retry-after=<seconds>s`
where Lasso X sends whole seconds, so a host can map it by status. Other
errors start with `Invalid input for <tool>:`,
`Unsupported Lasso X gateway tool.`, `Lasso X API responded with a redirect (HTTP <status>)`,
`Network error calling the Lasso X API`, `Lasso X API request timed out after`,
`Invalid call context:`, or the policy refusal.

**Key admission and the sink check.** A gateway accepts only a key of
printable ASCII (0x21-0x7E) of at least 16 characters that shares no piece
of 6 characters with a string literal in `src/`
(`src/fixed-corpus.generated.ts`, kept up to date by a test), with the fixed
fallbacks (`src/fallbacks.ts`) or with the tool list. A refused key throws
`GatewayConfigError` when the gateway is created, before anything is built
or sent; the refusal is a fixed text that holds no piece of the key, and
every error a gateway throws has no `cause` and a `stack` of only
`name: message`. As the very last step, every output (the tool list, each
result as a whole, each audit record) is checked in its final form, and one
that still holds a piece of the key is replaced by a fixed fallback.
Residual risk: Lasso X echoing the key back otherwise transformed (split into
pieces shorter than 6 characters, reversed, hashed) is not recognised; such
data reaches only the tenant whose key it is.

## Security model

- The server calls Lassox with one shared API key. Every caller acts with that key's access; forwarded identity (`LASSO_TRUST_FORWARDED_USER`) is only used to choose which private lists are visible.
- Per-user authorization belongs in an identity-aware proxy or gateway in front of this server. `MCP_HTTP_TOKEN` only authenticates that caller; the proxy must strip `X-MCP-User` from client traffic and set it itself.
- Tool access is not data access: disabling a tool limits what an agent can call, not what the API key can read.
- The HTTP server does not terminate TLS. Run it on a private network or behind a TLS-terminating proxy.
- Upstream redirects are never followed, so `lasso-api-key` is only sent to `LASSO_BASE_URL`.

## Security And Audit

- The MCP server reads `LASSO_API_KEY` only from its environment; an embedded
  gateway takes the key only from its options (see [Embedding](#embedding-gateway)).
- API keys are never accepted as tool arguments.
- Errors are our own texts with the HTTP status (`Lasso X API request failed with HTTP <status>`); Lasso X's response bodies (`errorMessage`, `friendlyError`, `errorCode`, `helpLink`) are never read into an error. Error formatting also redacts the configured key by value as well as `lasso-api-key`, `LASSO_API_KEY`, and bearer/`apiKey`-style secret material. A successful answer that is not JSON is refused.
- CVR data is strictly read-only. The single write tool, `lassox_list_change`, only changes Lassox list membership, is off unless `LASSO_ENABLE_WRITES=true`, is separately allowlisted in the policy module and annotated `readOnlyHint: false`.
- List reads and changes are restricted to the lists visible to the caller (shared lists plus the caller's own); caller-supplied user ids are not accepted.
- Caller-supplied identifiers used in URL paths are rejected if they are empty, `.`/`..`, or contain `/`, `\`, `?`, `#` or encoded dots/slashes.
- If `LASSO_AUDIT_LOG` is set, each tool call writes JSONL audit events with timestamp, request id, tool name, action, target hash, status, and an error code (`http_<status>`, `timeout` or `error`), never the error's text. Raw search/entity inputs and API keys are not written to the audit log.
- Report suspected vulnerabilities privately to <security@borgels.com>. Do not
  include API keys, personal data, or other secrets in public GitHub issues.

## API Sources

- Lassox docs: <https://docs.lassox.com/>
- Lassox API: <https://api.lassox.com/>

## License

Apache-2.0. See [LICENSE](LICENSE).
