# mcp-server-lassox

TypeScript MCP server for the Lassox CVR API. It is intentionally boring good:
typed, documented, read-first, policy-aware, credential-sane, and
audit-friendly.

> **Disclaimer:** This is an independent, unofficial project by Borgels. Borgels
> is not affiliated with, endorsed by, or supported by Lasso X. "Lassox" /
> "Lasso X" and the CVR API are referenced only to describe what this server
> talks to. You need your own Lassox API key, and use of the Lassox API is
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

Report PDFs, delta polling, monitoring, webhooks, and other non-CVR Lassox APIs are intentionally out of scope.

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

All tools are read-only and registered with MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`) so clients can reason about safety.

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

## Optional MCP Apps Add-On

The core CVR server is unchanged by default. Setting `LASSO_APPS=1` opts in to an
add-on that registers extra MCP Apps tools and inline UI widgets alongside the
read-only CVR tools, following the official
[MCP Apps extension](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
(SEP-1865, stable 2026-01-26).

```sh
LASSO_API_KEY="your-api-key" LASSO_APPS=1 npm run dev
```

Without the flag the server behaves exactly as before — no extra tools, no UI
resources, no behavioural change for clients that do not support MCP Apps.

The first add-on app is **Lassox Financial Trend Chart**:

- Tool `lassox_financial_chart({ lassoId | entityType+id, years?=4, currency? })`
  returns a narrow time-series of revenue (omsætning), gross profit
  (bruttofortjeneste), and net result (årets resultat) for a Danish company's
  last N annual reports. Internally it calls the same Lassox `/reports`
  endpoint as `cvr_get_reports` and trims the response.
- The tool advertises a UI resource via `_meta`:
  `{ "io.modelcontextprotocol/ui": { "resourceUri": "ui://lassox/financial-trend" } }`.
- The resource is registered with MIME type
  `text/html;profile=mcp-app` and serves a self-contained HTML+SVG widget that
  reads `structuredContent` from the host via JSON-RPC over `postMessage`. No
  external dependencies, no `window.openai` legacy bridge.
- The tool also returns a Markdown text fallback in `content`, so classic
  (non-Apps) MCP clients still get a useful response.

Inspect the widget with MCP Inspector by reading the resource directly, or
trigger the tool with a CVR-1 Lasso ID and let the host render the chart
inline.

## Optional HTTP Server

The local stdio transport is the default for agent compatibility. A small Streamable HTTP entrypoint is also available:

```sh
PORT=3000 LASSO_API_KEY="your-api-key" npm run dev:http
```

By default the HTTP server binds to `127.0.0.1`, limits request bodies to 10 MiB,
allows browser CORS only from loopback origins, and does not require an HTTP
Bearer token. You can override this with `MCP_HTTP_HOST`, `MCP_MAX_BODY_BYTES`,
`MCP_ALLOWED_ORIGINS`, `MCP_ALLOW_ANY_ORIGIN=true`, and `MCP_HTTP_TOKEN`.

The MCP endpoint is `POST http://127.0.0.1:3000/mcp`.

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

Lassox documents a limit of 500 requests per minute per API key. If Lassox returns `429`, this server includes the `retry-after` value in the tool error message.

## Security And Audit

- `LASSO_API_KEY` is read only from the MCP server environment.
- API keys are never accepted as tool arguments.
- Error formatting redacts `lasso-api-key`, `LASSO_API_KEY`, and `apiKey`-style secret material.
- The server exposes only read-only CVR tools. A small policy module keeps that invariant explicit for future expansion.
- If `LASSO_AUDIT_LOG` is set, each tool call writes JSONL audit events with timestamp, request id, tool name, action, target hash, status, and redacted error text. Raw search/entity inputs and API keys are not written to the audit log.
- Report suspected vulnerabilities privately to <security@borgels.com>. Do not
  include API keys, personal data, or other secrets in public GitHub issues.

## API Sources

- Lassox docs: <https://docs.lassox.com/>
- Lassox API: <https://api.lassox.com/>

## License

Apache-2.0. See [LICENSE](LICENSE).
