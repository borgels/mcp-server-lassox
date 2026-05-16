export interface FinancialTrendInput {
  lassoId: string;
  years: number;
  rawReports: unknown;
}

export interface FinancialTrendYear {
  year: number;
  revenue: number | null;
  grossProfit: number | null;
  profitLossForPeriod: number | null;
}

export interface FinancialTrendData {
  company: {
    lassoId: string;
    name: string | null;
    cvr: string | null;
  };
  currency: string | null;
  yearsRequested: number;
  reports: FinancialTrendYear[];
  source: 'lassox-reports';
}

const FIELD_ALIASES = {
  revenue: ['revenue', 'netRevenue', 'turnover', 'nettoomsætning'],
  grossProfit: ['grossProfit', 'grossResult', 'bruttofortjeneste', 'bruttoresultat'],
  profitLossForPeriod: [
    'profitLossForPeriod',
    'profitForPeriod',
    'netResult',
    'netIncome',
    'aaretsResultat',
    'aretsResultat',
  ],
} as const;

const YEAR_KEYS = [
  'periodEnd',
  'periodEndDate',
  'reportingPeriodEnd',
  'fiscalYearEnd',
  'periodTo',
  'to',
  'endDate',
  'year',
  'reportingYear',
  'fiscalYear',
];

export function transformFinancialTrend(input: FinancialTrendInput): FinancialTrendData {
  const root = input.rawReports;
  const reportList = extractReportList(root);
  const yearly = reportList.map(toYearlyRow).filter((row): row is FinancialTrendYear => row !== null);

  yearly.sort((a, b) => a.year - b.year);

  const deduped = dedupeByYearKeepLast(yearly);
  const trimmed = deduped.slice(-input.years);

  return {
    company: extractCompany(root, input.lassoId),
    currency: extractCurrency(root, reportList),
    yearsRequested: input.years,
    reports: trimmed,
    source: 'lassox-reports',
  };
}

function extractReportList(root: unknown): Record<string, unknown>[] {
  if (Array.isArray(root)) {
    return root.filter(isObject);
  }

  if (!isObject(root)) {
    return [];
  }

  const candidates = [root.reports, root.annualReports, root.items, root.data];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isObject);
    }
  }

  return [];
}

function toYearlyRow(report: Record<string, unknown>): FinancialTrendYear | null {
  const year = extractYear(report);
  if (year === null) {
    return null;
  }

  return {
    year,
    revenue: pickNumberByAliases(report, FIELD_ALIASES.revenue),
    grossProfit: pickNumberByAliases(report, FIELD_ALIASES.grossProfit),
    profitLossForPeriod: pickNumberByAliases(report, FIELD_ALIASES.profitLossForPeriod),
  };
}

function extractYear(report: Record<string, unknown>): number | null {
  for (const key of YEAR_KEYS) {
    const value = report[key];
    const year = coerceYear(value);
    if (year !== null) {
      return year;
    }
  }

  const period = report.period;
  if (isObject(period)) {
    for (const key of ['end', 'endDate', 'to', 'year']) {
      const year = coerceYear(period[key]);
      if (year !== null) {
        return year;
      }
    }
  }

  return null;
}

function coerceYear(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const intValue = Math.trunc(value);
    return isPlausibleYear(intValue) ? intValue : null;
  }

  if (typeof value === 'string') {
    const match = value.match(/(\d{4})/);
    if (match) {
      const intValue = Number(match[1]);
      return isPlausibleYear(intValue) ? intValue : null;
    }
  }

  return null;
}

function isPlausibleYear(value: number): boolean {
  return value >= 1900 && value <= 2100;
}

function pickNumberByAliases(report: Record<string, unknown>, aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const value = report[alias];
    const number = coerceNumber(value);
    if (number !== null) {
      return number;
    }
  }

  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (isObject(value)) {
    const candidates = [value.value, value.amount, value.number];
    for (const candidate of candidates) {
      const number = coerceNumber(candidate);
      if (number !== null) {
        return number;
      }
    }
  }

  return null;
}

function dedupeByYearKeepLast(rows: FinancialTrendYear[]): FinancialTrendYear[] {
  const byYear = new Map<number, FinancialTrendYear>();
  for (const row of rows) {
    byYear.set(row.year, row);
  }
  return Array.from(byYear.values()).sort((a, b) => a.year - b.year);
}

function extractCompany(
  root: unknown,
  lassoId: string,
): FinancialTrendData['company'] {
  const cvr = extractCvrFromLassoId(lassoId);

  if (!isObject(root)) {
    return { lassoId, name: null, cvr };
  }

  const entity = isObject(root.entity) ? root.entity : isObject(root.company) ? root.company : null;
  const name = pickFirstString(root.name, entity?.name, entity?.displayName);

  return { lassoId, name, cvr };
}

function extractCvrFromLassoId(lassoId: string): string | null {
  const match = lassoId.match(/^CVR-1-(\d+)$/);
  return match && match[1] ? match[1] : null;
}

function extractCurrency(root: unknown, reports: Record<string, unknown>[]): string | null {
  if (isObject(root)) {
    const top = pickFirstString(root.currency, isObject(root.metadata) ? root.metadata.currency : null);
    if (top) return top;
  }

  for (const report of reports) {
    const fromReport = pickFirstString(
      report.currency,
      pickNested(report.revenue, 'unit'),
      pickNested(report.grossProfit, 'unit'),
    );
    if (fromReport) return fromReport;
  }

  return null;
}

function pickNested(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
