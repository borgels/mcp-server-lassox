export interface LassoErrorPayload {
  errorMessage?: string;
  httpStatusCode?: number;
  errorCode?: number;
  friendlyError?: string;
  helpMessage?: string;
  helpLink?: string;
}

/** Maximum length of any single piece of text taken from a response body. */
export const MAX_ERROR_TEXT = 500;
/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
const MIN_SECRET_LENGTH = 8;

const registeredSecrets = new Set<string>();

/** Redact this exact value (and its URL-encoded form) wherever it appears in error text. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  registeredSecrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registeredSecrets.add(encoded);
  }
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** Truncate after redaction, so a secret cut in half is never left behind. */
export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated, ${value.length} chars]` : value;
}

function textPart(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redactSecrets(value.trim()));
}

const SECRET_PATTERNS = [
  /lasso-api-key:\s*[^,\s}]+/gi,
  /(apiKey|LASSO_API_KEY)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class LassoHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: LassoErrorPayload | unknown;
  readonly retryAfter?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: LassoErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatLassoHttpError(input));
    this.name = 'LassoHttpError';
    this.status = input.status;
    this.url = redactSecrets(describeUrl(input.url));
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    result,
  );
}

function formatLassoHttpError(input: {
  status: number;
  url: string;
  payload?: LassoErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isLassoErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Lassox API request failed with HTTP ${input.status}`,
    payload?.errorCode === undefined ? undefined : `errorCode=${truncate(String(payload.errorCode), 64)}`,
    textPart(payload?.errorMessage),
    textPart(payload?.friendlyError),
    input.retryAfter ? `retry-after=${truncate(input.retryAfter, 64)}s` : undefined,
    textPart(payload?.helpLink),
    textPart(input.fallbackMessage),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isLassoErrorPayload(value: unknown): value is LassoErrorPayload {
  return typeof value === 'object' && value !== null;
}
