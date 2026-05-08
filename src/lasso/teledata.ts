import type { LassoClient } from './client.js';
import { parseCvrEntityInput, type CvrEntityInput } from './cvr.js';
import { assertCompanyLassoId } from './financials.js';

export interface PhoneLookupInput {
  phoneNumber: string;
  includeCompany?: boolean;
}

const PHONE_PATTERN = /^\+?\d{6,15}$/;

export function normalizePhoneNumber(value: string): string {
  const stripped = value.replace(/[\s\-()]/g, '');
  if (!PHONE_PATTERN.test(stripped)) {
    throw new Error(
      'phoneNumber must be 6-15 digits, optionally prefixed with +. Example: +4570201020 or 70201020.',
    );
  }
  return stripped;
}

export async function getCompanyPhoneNumbers(
  client: LassoClient,
  input: CvrEntityInput,
): Promise<unknown> {
  const lassoId = parseCvrEntityInput(input);
  assertCompanyLassoId(lassoId);
  return client.get(`/data/teledata/${lassoId}/phonenumbers`);
}

export async function lookupPhoneNumber(
  client: LassoClient,
  input: PhoneLookupInput,
): Promise<unknown> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  return client.get(`/data/teledata/${phoneNumber}`, {
    includeCompany: input.includeCompany,
  });
}
