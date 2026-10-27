// The fund catalogue (data/catalog.json) and its trading rules.

/** Purchase limits (lumpsum) as FP's scheme plans state them. */
export interface LumpsumRule { allowed: boolean; min: number | null; additional_min: number | null; multiples: number; max: number | null }
/** One systematic-plan frequency (SIP, STP, SWP). */
export interface PlanRule { frequency: string; min: number; multiples: number; installments_min: number; dates: number[] }
export interface StpRule extends PlanRule { in: boolean; out: boolean }

/** A fund's holdings from its fund house's monthly portfolio file (scripts/fund-data.ts). */
export interface FundPortfolio {
  as_of: string | null; source: string; aum_cr: number | null; count: number; mix: Record<string, number>;
  holdings: { name: string; industry: string; kind: string; pct: number }[];
  sectors: { name: string; pct: number }[];
  ratings: { name: string; pct: number }[];
}

/** One fund in data/catalog.json (built by scripts/build-catalog.ts, enriched by scripts/fund-data.ts). */
export interface Scheme {
  isin: string;
  name: string;
  amc: string;
  amc_short: string;
  amc_id: number;
  amfi_code: string;
  plan: string;
  option: string;
  category: string;
  sub_category: string;
  risk: string;
  tags: string[];
  lock_in: string;
  nav: number;
  nav_date: string;
  returns: Record<'1D' | '1M' | '6M' | '1Y' | '3Y' | '5Y', number | null>;
  lumpsum: LumpsumRule;
  sip: PlanRule[];
  redemption_allowed: boolean;
  switch_out_allowed: boolean;
  switch_in_allowed: boolean;
  switch_in: { min: number; multiples: number } | null;
  stp: StpRule | null;
  swp: PlanRule | null;
  history?: { since: string; years: number; cagr: number; annualised: boolean } | null;
  /** ~weekly [epoch ms, NAV] points over 5 years (always written by build-catalog) */
  chart: [number, number][];
  // scripts/fund-data.ts: null when a source had nothing for the fund
  ter?: { regular: number; direct: number; date: string; source: string } | null;
  people?: { managers: string[]; objective: string | null; as_of: string; source: string } | null;
  portfolio?: FundPortfolio | null;
}

/** The per-ISIN trading rules a production rules file lays over a scheme. */
export type SchemeRules = Pick<Scheme, 'lumpsum' | 'sip' | 'switch_in' | 'switch_in_allowed' | 'switch_out_allowed' | 'redemption_allowed' | 'stp' | 'swp'>;

/** Card-sized summary of a fund (no chart). */
export interface FundSummary {
  isin: string; name: string; short_name: string; amc: string; amc_short: string; amc_id: number; category: string;
  sub_category: string; risk: string; tags: string[]; nav: number; nav_date: string; returns: Scheme['returns'];
  lumpsum: LumpsumRule; sip_min: number | null; stp: StpRule | null; swp: PlanRule | null; switch_in_min: number | null;
  top_performer: boolean;
}

/** Card-sized summary (no chart). */
