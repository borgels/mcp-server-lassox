/**
 * Guard for caller-supplied values that end up inside a URL path segment.
 * Rejects values that could change which upstream resource is addressed
 * (traversal, extra segments, query/fragment injection, pre-encoded dots or
 * slashes) before the value is percent-encoded.
 */
const FORBIDDEN_CHARACTERS = /[/\\?#]/;
const ENCODED_DOT_OR_SLASH = /%(2e|2f|5c)/i;

export function assertSafePathSegment(value: string, name = 'path parameter'): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`);
  }

  if (value === '' || value === '.' || value === '..') {
    throw new Error(`${name} is not a valid identifier.`);
  }

  if (FORBIDDEN_CHARACTERS.test(value) || ENCODED_DOT_OR_SLASH.test(value)) {
    throw new Error(`${name} contains characters that are not allowed.`);
  }

  // Reject control characters as well; ids never contain them.
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20 || value.charCodeAt(index) === 0x7f) {
      throw new Error(`${name} contains characters that are not allowed.`);
    }
  }

  return value;
}

export function encodePathSegment(value: string, name?: string): string {
  return encodeURIComponent(assertSafePathSegment(value, name));
}
