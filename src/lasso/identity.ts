/**
 * Caller identity for Lassox lists.
 *
 * Lassox lists (tags) are either shared across the account or private to a
 * Lassox user. The API key alone can read any user's private lists when given
 * a userId, so this server never accepts a free-form userId from the caller.
 * Instead the Lassox user id is derived server-side:
 *
 * - With LASSO_TRUST_FORWARDED_USER=true (HTTP behind a trusted gateway) the
 *   gateway-verified X-MCP-User email is mapped to a Lassox user id via
 *   LASSO_USER_MAP. A missing identity fails closed; an unmapped identity only
 *   sees lists shared across the account.
 * - Otherwise (single-user stdio/HTTP deployments) LASSO_DEFAULT_USER_ID, if
 *   set, selects whose private lists are visible; without it only shared lists
 *   are visible.
 */

export interface ListAccessScope {
  /** Lassox user id whose private lists are visible, or undefined for shared lists only. */
  userId?: string;
  /** Identity the scope was derived from, for error messages. */
  callerEmail?: string;
}

export function isTrustForwardedUser(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LASSO_TRUST_FORWARDED_USER === 'true';
}

/**
 * Parses LASSO_USER_MAP. Accepts either a JSON object ({"a@x.dk":"uid"}) or a
 * comma/newline separated list of email=userId pairs. Emails are matched
 * case-insensitively.
 */
export function parseUserMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const text = (raw ?? '').trim();
  if (!text) {
    return map;
  }

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('LASSO_USER_MAP is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LASSO_USER_MAP JSON must be an object of email -> Lassox user id.');
    }
    for (const [email, userId] of Object.entries(parsed as Record<string, unknown>)) {
      addEntry(map, email, userId);
    }
    return map;
  }

  for (const pair of text.split(/[,\n]/)) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      throw new Error('LASSO_USER_MAP entries must look like email=lassoUserId.');
    }
    addEntry(map, trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }

  return map;
}

function addEntry(map: Map<string, string>, email: string, userId: unknown): void {
  const key = normalizeEmail(email);
  const value = typeof userId === 'string' ? userId.trim() : '';
  if (!key || !value) {
    throw new Error('LASSO_USER_MAP entries need a non-empty email and Lassox user id.');
  }
  map.set(key, value);
}

export function normalizeEmail(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export interface ResolveListScopeInput {
  callerEmail?: string;
  env?: NodeJS.ProcessEnv;
  /** Force forwarded-identity semantics regardless of env (used by the gateway export). */
  trustForwardedUser?: boolean;
}

export function resolveListScope(input: ResolveListScopeInput = {}): ListAccessScope {
  const env = input.env ?? process.env;
  const trust = input.trustForwardedUser ?? isTrustForwardedUser(env);

  if (trust) {
    const email = normalizeEmail(input.callerEmail);
    if (!email) {
      throw new Error(
        'No verified caller identity. Lassox lists require a gateway-verified user when LASSO_TRUST_FORWARDED_USER=true.',
      );
    }
    const userId = parseUserMap(env.LASSO_USER_MAP).get(email);
    return userId ? { userId, callerEmail: email } : { callerEmail: email };
  }

  const defaultUserId = env.LASSO_DEFAULT_USER_ID?.trim();
  return defaultUserId ? { userId: defaultUserId } : {};
}
