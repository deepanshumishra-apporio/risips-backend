// The fund catalogue: data/catalog.json (built on the sandbox by scripts/build-catalog.ts) with, on production, the live
// tenant's trading rules laid over it (data/catalog-rules.production.json).
import fs from 'node:fs';
import { config, paths } from '../config/env.ts';
import type { FundSummary, Scheme, SchemeRules } from '../types/catalog.ts';

const FILE = paths.catalog;
const PROD_RULES = paths.catalogProdRules;
let cache: Scheme[] | null = null;

// A scheme the production tenant doesn't list can't be traded at all.
const CLOSED: SchemeRules = { lumpsum: { allowed: false, min: null, additional_min: null, multiples: 1, max: null }, sip: [], switch_in: null,
  switch_in_allowed: false, switch_out_allowed: false, redemption_allowed: false, stp: null, swp: null };

export function catalog(): Scheme[] {
  if (!cache) {
    if (!fs.existsSync(FILE)) throw new Error('data/catalog.json missing - run `npm run catalog`');
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8')).schemes;
    // The catalogue is built on the sandbox; production trades by the live tenant's rules (scripts/prod-rules.ts).
    if (config.production) {
      if (!fs.existsSync(PROD_RULES)) throw new Error('data/catalog-rules.production.json missing - run `FP_ENV=production node scripts/prod-rules.ts`');
      const rules: Record<string, SchemeRules> = JSON.parse(fs.readFileSync(PROD_RULES, 'utf8')).schemes;
      cache = cache!.map((s) => ({ ...s, ...(rules[s.isin] || CLOSED) }));
    }
  }
  return cache!;
}

export const scheme = (isin: string | null | undefined): Scheme | null => catalog().find((s) => s.isin === isin) || null;

/** Capital-gains tax bucket (Finance Act 2024): equity-oriented, debt (always slab), or other (hybrid, FoF, gold/silver, solution). */
export function taxClass(isin: string | null | undefined): 'equity' | 'debt' | 'other' {
  const s = scheme(isin);
  if (!s) return 'other';
  if (s.category === 'Equity' || (s.category === 'Index' && s.sub_category === 'Index Funds')) return 'equity';
  if (s.category === 'Debt') return 'debt';
  return 'other';
}

/** Return used for ranking: 3Y CAGR, else 1Y for younger funds. */
export const rankReturn = (s: Scheme): number | null => s.returns['3Y'] ?? s.returns['1Y'] ?? null;

let topCache: Set<string> | null = null;
/**
 * "Top Performer" badge: the top quarter (at least one fund) of each broad category (Equity, Debt, Hybrid, Index,
 * Solution) in this catalogue, ranked by 3Y return (1Y for funds younger than 3 years).
 */
export function isTopPerformer(isin: string): boolean {
  if (!topCache) {
    topCache = new Set();
    const by: Record<string, Scheme[]> = {};
    for (const s of catalog()) (by[s.category] ||= []).push(s);
    for (const list of Object.values(by)) {
      const ranked = list.filter((s) => rankReturn(s) != null).sort((a, b) => rankReturn(b)! - rankReturn(a)!);
      ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 4))).forEach((s) => topCache!.add(s.isin));
    }
  }
  return topCache.has(isin);
}

// A fund in, a summary out; null in, null out.
export const summary = <S extends Scheme | null>(s: S): S extends Scheme ? FundSummary : FundSummary | null => s && ({
  isin: s.isin, name: s.name, short_name: shortName(s.name), amc: s.amc, amc_short: s.amc_short, amc_id: s.amc_id,
  category: s.category, sub_category: s.sub_category, risk: s.risk, tags: s.tags,
  nav: s.nav, nav_date: s.nav_date, returns: s.returns, lumpsum: s.lumpsum,
  sip_min: s.sip.find((x) => x.frequency === 'monthly')?.min ?? null,
  stp: s.stp || null,
  swp: s.swp || null,
  switch_in_min: s.switch_in?.min ?? null,
  top_performer: isTopPerformer(s.isin),
 
} as any);

export function shortName(n: string): string {
  return n
    .replace(/\s*\(erstwhile[^)]*\)/i, '')
    .replace(/\s*-\s*-?\s*Regular Plan.*$/i, '')
    .replace(/\s*-\s*Cash Option/i, '')
    .replace(/Prudential/i, 'Pru')
    .replace(/Aditya Birla Sun Life/i, 'ABSL')
    .trim();
}
