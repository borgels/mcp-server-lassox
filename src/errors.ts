/**
 * Errors and redaction.
 *
 * The rule: no text Lasso X controls ever reaches a host, a result or an
 * audit record through an error. An HTTP error carries the status, our own
 * hint and the parsed Retry-After; never a response body, an error message
 * or error code from Lasso X, or a redirect's Location. Lasso X's text can
 * quote the request or part of the key, and no redactor recognises every
 * fragment.
 *
 * Redaction is the second line: the key of the instance in scope (its exact
 * value, its encoded forms and any fragment of FRAGMENT_LENGTH characters or
 * more) is redacted from everything returned, on structured values before
 * they are serialised.
 *
 * Unlike some other servers built from the same template, successful answers
 * are not searched for nested failures: Lasso X reports failures by HTTP
 * status, and fields such as `status`, `description` or `metadata` in CVR
 * data are registry data, not failures.
 */
import { redactRegisteredSecrets } from './upstream-http.js';

export { describeUrl, FRAGMENT_LENGTH, MIN_SECRET_LENGTH, registerSecret } from './upstream-http.js';

/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;

export interface LassoHttpErrorInput {
  status: number;
  method?: string;
  url: string;
  retryAfter?: string;
}

const SECRET_PATTERNS = [
  // Bearer or Basic, in any case, before a value that holds the marker of an earlier redaction: the scheme word and the
  // whole value up to a space, quote, comma or brace, whatever its length (a short tail after the marker is still part
  // of the credential).
  /\b(bearer|basic)\s+[^\s"',}]*‹redacted›[^\s"',}]*/gi,
  /Authorization:\s*(Bearer|Basic)\s+[^,\s}]+/gi,
  // A credential-named assignment in text: `lasso-api-key: S`, `X-Api-Key: S`, `client_secret=S`, `?api_key=S`,
  // `"accessToken": "S"`.
  /(LASSO_API_KEY|(?:x[-_]?)?api[-_]?(?:key|token|secret)|client[-_]?secret|(?:access|refresh|auth|id|session|bearer)[-_]?token|accessToken|apiKey|token|password|passwd|secret)["']?\s*[:=]\s*["']?[^"',\s}&]+/gi,
  // A marker left by the secrets' redaction (‹redacted›) counts as part of a value, so the rest of it is masked too.
  /\b(Bearer|Basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›)+=*/g,
  // Any case ("bearer", "BASIC"), when what follows looks like a token: 8 or more base64 or base64url characters. A
  // short word after "basic" ("basic plan") is left alone; a longer one is masked, a false positive we accept.
  /\b(bearer|basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›){8,}=*/gi,
  // A JSON Web Token anywhere: three base64url segments, the first a JSON header ("eyJ").
  /\beyJ(?:[A-Za-z0-9_-]|‹redacted›)*\.(?:[A-Za-z0-9_-]|‹redacted›)+\.(?:[A-Za-z0-9_-]|‹redacted›)*/g,
];

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  401: 'The Lasso X API key was rejected (invalid or revoked).',
  402: 'The Lasso X account does not include this. It may need a separate Lasso X subscription.',
  403: 'The Lasso X API key has no access to this. It may need a separate Lasso X subscription. Retrying will not help.',
  404: 'Lasso X found nothing at this address. Check the ids.',
  429: 'Lasso X is throttling requests. Wait and retry later.',
};

/**
 * An HTTP error from Lasso X: the status, our own hint and the parsed
 * Retry-After. Nothing of the body is kept.
 */
export class LassoHttpError extends Error {
  readonly status: number;
  readonly method?: string;
  /** Origin and path, without query string. */
  readonly url: string;
  /** Retry-After as whole seconds or an HTTP date; undefined when absent or neither. */
  readonly retryAfter?: string;

  constructor(input: LassoHttpErrorInput) {
    const seconds = wholeNumber(input.retryAfter);
    super(
      [
        `Lasso X API request failed with HTTP ${input.status}`,
        Object.hasOwn(STATUS_HINTS, input.status) ? STATUS_HINTS[input.status] : undefined,
        seconds === undefined ? undefined : `retry-after=${seconds}s`,
      ]
        .filter(Boolean)
        .join(' | '),
    );
    this.name = 'LassoHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = stripQuery(input.url);
    this.retryAfter = seconds ?? httpDate(input.retryAfter);
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

/**
 * Credential-shaped text first, while it is whole: an instance secret replaced inside a Basic value or a token would
 * break the match and leave the rest of the value. Then the instance's secrets, then the patterns again (they also take
 * the marker as part of a value), until nothing changes.
 */
export function redactSecrets(value: string): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactRegisteredSecrets(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * Credential-shaped text replaced by a marker: an Authorization header, a
 * Bearer or Basic value, and `lasso-api-key:`/`token=`-style assignments.
 * Applied to every text a gateway returns, so a credential the upstream
 * echoes (one that is not the instance's own key) never leaves it. Uses no
 * state: the same input always gives the same output.
 */
export function redactCredentialPatterns(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        if (/^eyJ/.test(match)) {
          return '[REDACTED]';
        }

        if (/^(Bearer|Basic)\s/i.test(match)) {
          const scheme = match.split(/\s+/)[0] ?? 'Authorization';
          return `${scheme} [REDACTED]`;
        }

        if (/^Authorization:/i.test(match)) {
          return 'Authorization: [REDACTED]';
        }

        // The first separator ends the name: everything after it is the value, which may itself hold `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} [REDACTED]`;
      }),
    value,
  );
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets. Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactSecrets(text) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
}

/** Copy of parsed JSON with anything nested deeper than MAX_REDACT_DEPTH replaced, so it can be serialised safely. */
export function limitDepth(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => limitDepth(entry, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, limitDepth(entry, depth + 1)]));
}

/** A header value that is a whole number of at most 9 digits, as text; anything else is dropped. */
function wholeNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{1,9}$/.test(trimmed) ? String(Number(trimmed)) : undefined;
}

/** A Retry-After HTTP date, normalised to its UTC form; anything else is dropped. */
function httpDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toUTCString() : undefined;
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}
