// Funds held outside Risips, imported from a consolidated account statement (MF Central).
import type { FundSummary } from './catalog.ts';

/** One line of an imported statement, normalised; every source maps into this. cost_value: purchase cost of the
 *  units still held (as the statement reports it); broker: ARN code or 'DIRECT'. */
export interface StatementLine {
  isin: string; folio: string | null; scheme_name?: string | null; amc_name?: string | null; registrar?: string | null;
  units: number | string; cost_value?: number | string | null; nav?: number | string | null; nav_date?: string | null;
  value?: number | null; broker?: string | null; plan?: string | null; demat?: boolean;
}
/** A fund held outside Risips, valued (externalHoldings()). */
export interface ExternalHolding {
  key: string; isin: string; folio: string | null; external: true;
  fund: FundSummary | {
    isin: string; name: string | null | undefined; short_name: string; amc: string; amc_short: string; category: string;
    sub_category: string; plan: string | null; option: string | null; returns: Record<string, number | null>;
  };
  in_catalog: boolean; registrar: string | null; broker: string | null; direct: boolean; units: number; nav: number;
  nav_date: string | null; current: number; invested: number; cost_known: boolean; gain: number; gain_pct: number;
  avg_nav: number; day_change: number; priced: boolean;
}

/** users' ext_imports.data */
export interface ExtImport {
  source?: string; as_of?: string | null; imported_at?: string; investor?: Record<string, unknown>;
  holdings?: StatementLine[]; transactions?: Record<string, unknown>[]; sample?: boolean; updated_at?: string;
  [k: string]: unknown;
}
