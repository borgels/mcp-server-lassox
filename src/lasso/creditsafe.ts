import type { LassoClient } from './client.js';

export interface CreditsafeRatingInput {
  cvr?: string | number;
  lassoId?: string;
  skipCache?: boolean;
}

const CVR_PATTERN = /^\d{8}$/;

export function resolveCvr(input: CreditsafeRatingInput): string {
  if (input.cvr !== undefined && input.cvr !== null && String(input.cvr).trim() !== '') {
    const cvr = String(input.cvr).trim();
    if (!CVR_PATTERN.test(cvr)) {
      throw new Error(`CVR must be exactly 8 digits, got: ${cvr}`);
    }
    return cvr;
  }

  if (input.lassoId) {
    const match = /^CVR-1-(\d+)$/.exec(input.lassoId.trim());
    if (!match) {
      throw new Error('Creditsafe ratings are only documented for companies (CVR-1-{cvr}).');
    }
    const cvr = match[1] ?? '';
    if (!CVR_PATTERN.test(cvr)) {
      throw new Error(`Lasso ID does not contain a valid 8-digit CVR: ${input.lassoId}`);
    }
    return cvr;
  }

  throw new Error('Provide either cvr or lassoId.');
}

export async function getCreditsafeRating(
  client: LassoClient,
  input: CreditsafeRatingInput,
): Promise<unknown> {
  const cvr = resolveCvr(input);
  return client.get(`/data/creditsafe/rating/${cvr}`, {
    skipCache: input.skipCache,
  });
}
