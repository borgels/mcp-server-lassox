export interface LassoErrorPayload {
  errorMessage?: string;
  httpStatusCode?: number;
  errorCode?: number;
  friendlyError?: string;
  helpMessage?: string;
  helpLink?: string;
}

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
    this.url = input.url;
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
    payload?.errorCode === undefined ? undefined : `errorCode=${payload.errorCode}`,
    payload?.errorMessage,
    payload?.friendlyError,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    payload?.helpLink,
    input.fallbackMessage,
  ].filter(Boolean);

  return parts.join(' | ');
}

function isLassoErrorPayload(value: unknown): value is LassoErrorPayload {
  return typeof value === 'object' && value !== null;
}
