import type { LassoClient } from './client.js';
import { parseCvrEntityInput, type CvrEntityInput } from './cvr.js';

export interface CvrReportsInput extends CvrEntityInput {
  currency?: string;
}

export type FinancialAnalysisInput = CvrEntityInput;

export function assertCompanyLassoId(lassoId: string): void {
  if (!lassoId.startsWith('CVR-1-')) {
    throw new Error(
      'Reports and financial analysis are only documented for companies (CVR-1-{cvr}).',
    );
  }
}

function resolveCompanyLassoId(input: CvrEntityInput): string {
  const lassoId = parseCvrEntityInput(input);
  assertCompanyLassoId(lassoId);
  return lassoId;
}

export async function getCvrReports(
  client: LassoClient,
  input: CvrReportsInput,
): Promise<unknown> {
  const lassoId = resolveCompanyLassoId(input);
  return client.get(`/${lassoId}/reports`, {
    currency: input.currency,
  });
}

export async function getFinancialAnalysis(
  client: LassoClient,
  input: FinancialAnalysisInput,
): Promise<unknown> {
  const lassoId = resolveCompanyLassoId(input);
  return client.post(`/modules/reportanalysis/${lassoId}`);
}
