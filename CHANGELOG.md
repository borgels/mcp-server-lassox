# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-05-01

Hardening release for the Lassox CVR MCP server. This release keeps the v0.1.0
tool surface backward-compatible while making the server easier for MCP clients
and operators to reason about.

### Added

- `lassox_search_capabilities` discovery tool with descriptions, examples,
  identifier formats, and safety notes for the CVR tools.
- MCP tool annotations on every registered tool:
  `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
- Optional `LASSO_TIMEOUT_MS` environment variable for request timeout tuning.
- Optional `LASSO_AUDIT_LOG` JSONL audit events for tool starts, finishes, and
  failures, using hashed targets and redacted errors.
- Internal read-only policy allowlist so future expansion has an explicit safety
  boundary.

### Security

- Redacts `lasso-api-key`, `LASSO_API_KEY`, and `apiKey`-style secret material
  from formatted errors.
- Keeps API-key handling env-only; no tool accepts API keys as input.

### Changed

- README now includes a "Start here" discovery guide, hardening environment
  variables, and audit/security notes.

## [0.1.0] - 2026-04-27

Initial release of the Lassox CVR MCP server. Exposes core CVR lookup and
search to MCP-compatible agents over stdio, with an optional Streamable HTTP
transport for non-stdio clients.

### Added

- `cvr_search` tool — search companies and people, with optional `status`,
  `continuationToken`, and structured `filters` (`city`, `postalCode`,
  `street`, `email`, `telephone`, `cvr`).
- `cvr_get_entity` tool — fetch current basic information for a company,
  production unit, or person by structured `entityType`+`id` or by `lassoId`.
- `cvr_get_entity_history` tool — fetch historical basic information,
  returned unchanged from Lassox (`value`, `from`, `to`, `current`).
- `cvr_get_related` tool — fetch documented related entities
  (company→person, company→place, productionUnit→company), with optional
  `history` flag.
- stdio transport (`dist/stdio.js`) as the default for local agent clients.
- Streamable HTTP transport (`dist/http.js`) on `POST /mcp`, configurable
  via `PORT`.
- Lassox API client with `lasso-api-key` header authentication, 30s request
  timeout, and `429` handling that surfaces `retry-after` to the caller.
- Vitest unit tests for the client and CVR tool wiring.
- Optional live smoke test (`npm run smoke:live`) gated on `LASSO_API_KEY`.

### Security

- API key is read from the `LASSO_API_KEY` environment variable only and is
  never accepted as a tool argument.
- No request or response bodies are logged by the server.

[Unreleased]: https://github.com/Borgels/mcp-server-lassox/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Borgels/mcp-server-lassox/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Borgels/mcp-server-lassox/releases/tag/v0.1.0
