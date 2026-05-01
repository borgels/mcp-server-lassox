# mcp-server-lassox

TypeScript MCP server for the Lassox CVR API. It gives agents named tools for core CVR lookup and search, so they do not need to build Lassox API URLs directly.

> **Disclaimer:** This is an independent, unofficial project. It is not affiliated with, endorsed by, or supported by Lasso X. "Lassox" / "Lasso X" and the CVR API are referenced only to describe what this server talks to. You need your own Lassox API key, and use of the Lassox API is subject to Lassox's own terms.

## Scope

This first version covers the core CVR API only:

- Search companies and people.
- Fetch current company, production unit, or person data.
- Fetch historical company, production unit, or person data.
- Fetch documented related entities.

Reports, key figures, report PDFs, delta polling, monitoring, webhooks, and non-CVR Lassox APIs are intentionally out of scope.

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

## Cursor Or Claude Config

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

## Optional HTTP Server

The local stdio transport is the default for agent compatibility. A small Streamable HTTP entrypoint is also available:

```sh
PORT=3000 LASSO_API_KEY="your-api-key" npm run dev:http
```

The MCP endpoint is `POST http://localhost:3000/mcp`.

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
