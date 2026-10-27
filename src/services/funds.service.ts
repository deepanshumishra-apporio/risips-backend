// Fund catalogue screens: search and filters, collections, fund detail with NAV chart, compare, watchlist.
import { catalog, isTopPerformer, rankReturn, scheme, summary, taxClass } from './catalog.service.ts';
import { watchlistRepo } from '../db/repositories/misc.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { folioForAmc } from './orders.service.ts';
import type { Scheme } from '../types/catalog.ts';
import type { User } from '../types/domain.ts';

const PICKS = ['INF109KC1Q80', 'INF109K01AN2', 'INF209K01EN2', 'INF109K01BH2', 'INF109K01761', 'INF209K01AJ8'];
const COLLECTIONS: Record<string, { title: string; filter: (s: Scheme) => boolean }> = {
  high: { title: 'High Return', filter: (s) => (s.returns['3Y'] ?? -99) >= 13 && s.category !== 'Debt' },
  commodity: { title: 'Commodity', filter: (s) => s.tags.includes('commodity') },
  mid: { title: 'Mid Cap', filter: (s) => s.tags.includes('mid') },
  large: { title: 'Large Cap', filter: (s) => s.tags.includes('large') },
  small: { title: 'Small Cap', filter: (s) => s.tags.includes('small') },
  tax: { title: 'Tax Saver (ELSS)', filter: (s) => s.tags.includes('tax') },
  debt: { title: 'Debt & Liquid', filter: (s) => s.category === 'Debt' || s.tags.includes('debt') },
  index: { title: 'Index Funds', filter: (s) => s.tags.includes('index') },
  foryou: { title: 'For YOU!', filter: (s) => PICKS.includes(s.isin) || (s.returns['3Y'] ?? 0) > 12 },
};


export interface FundQuery {
  q?: string; collection?: string; category?: string; risk?: string; top?: string; sort?: string; picks?: string;
  amc_id?: number; switch_in?: string; stp_in?: string;
}

export async function listFunds(user: User, { q = '', collection, category, risk, top, sort = '3Y', picks, amc_id, switch_in, stp_in }: FundQuery) {
  let list = catalog();
  if (picks && !collection) list = PICKS.map(scheme).filter(Boolean) as Scheme[];
  if (collection) {
    const c = COLLECTIONS[collection];
    if (!c) throw new ApiError(404, 'Unknown collection');
    list = list.filter(c.filter);
    // "Our Picks" inside a collection (Figma 8:9150): its best performers by 3Y return (1Y for younger funds)
    if (picks) list = [...list].sort((a, b) => (rankReturn(b) ?? -999) - (rankReturn(a) ?? -999)).slice(0, 6);
  }
  // Filters screen: comma-separated lists, e.g. category=Equity,Hybrid&risk=Very High Risk&top=1
  const many = (v: string) => String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (category) { const c = many(category); list = list.filter((s) => c.includes(s.category.toLowerCase())); }
  if (risk) { const k = many(risk); list = list.filter((s) => k.includes(s.risk.toLowerCase())); }
  if (top) list = list.filter((s) => isTopPerformer(s.isin));
  if (amc_id) list = list.filter((s) => s.amc_id === amc_id);
  if (switch_in) list = list.filter((s) => s.switch_in_allowed !== false);
  if (stp_in) list = list.filter((s) => s.stp?.in);
  if (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((s) => words.every((w) => `${s.name} ${s.amc} ${s.sub_category} ${s.category}`.toLowerCase().includes(w)));
  }
  if (!picks && ['1Y', '3Y', '5Y', '6M', '1M'].includes(sort)) list = [...list].sort((a, b) => (b.returns[sort as '1Y'] ?? -999) - (a.returns[sort as '1Y'] ?? -999));
  const wl = new Set(await watchlistRepo.list(user.id));
  return {
    title: collection ? COLLECTIONS[collection].title : null,
    funds: list.map((s) => ({ ...summary(s), watchlisted: wl.has(s.isin) })),
  };
}

export const collections = () => ({ collections: Object.entries(COLLECTIONS).filter(([k]) => k !== 'foryou').map(([key, c]) => ({ key, title: c.title })) });

// Typical exit loads by category (FP's scheme master has no exit-load data).
const exitLoad = (s: Scheme) => (s.category === 'Debt' || s.sub_category === 'ELSS' ? 'Nil' : '1% (<1Yr)');

const PERIOD_DAYS: Record<string, number> = { '1M': 31, '6M': 183, '1Y': 366, '3Y': 3 * 366, '5Y': 5 * 366 };

function periodReturn(chart: [number, number][], since: number, period: string) {
  if (chart.length < 2 || chart[0][0] - since > 10 * 864e5) return null; // history starts after the period does
  const abs = chart.at(-1)![1] / chart[0][1];
  const years = (chart.at(-1)![0] - chart[0][0]) / (365.25 * 864e5);
  const r = ['3Y', '5Y'].includes(period) ? abs ** (1 / years) - 1 : abs - 1;
  return Math.round(r * 10000) / 100;
}

// ---------- Expense ratio, managers, holdings (scripts/fund-data.ts) ----------
// TER from AMFI's daily disclosure, managers/objective from Kuvera's public data, holdings from the fund house's monthly
// portfolio file. A field the refresh couldn't fill is null and the app says so rather than guessing.
function fundData(s: Scheme, { top = 10 } = {}) {
  const p = s.portfolio;
  return {
    expense_ratio: s.ter ? { regular: s.ter.regular, direct: s.ter.direct, date: s.ter.date, source: s.ter.source } : null,
    managers: s.people?.managers || [],
    objective: s.people?.objective || null,
    portfolio: p ? {
      as_of: p.as_of, source: p.source, aum_cr: p.aum_cr, count: p.count, mix: p.mix,
      holdings: p.holdings.slice(0, top), sectors: p.sectors.slice(0, top), ratings: p.ratings.slice(0, top),
    } : null,
  };
}
const missing = (d: ReturnType<typeof fundData>) => [!d.expense_ratio && 'expense_ratio', !d.portfolio && 'holdings', !d.managers.length && 'managers'].filter(Boolean);

// ---------- Compare (Figma "Compare - Empty" / "Compare - 2 Funds") ----------
// Facts come from FP scheme rules, AMFI NAV history and fundData() above.

// What SEBI's scheme categorisation (circular of 6 Oct 2017) requires of each category.
const MANDATE: [RegExp, string][] = [
  [/^Large Cap/i, 'Invests at least 80% in large-cap companies (the 100 largest by market value).'],
  [/Mid ?Cap/i, 'Invests at least 65% in mid-cap companies (the 101st to 250th largest).'],
  [/Small Cap/i, 'Invests at least 65% in small-cap companies (251st largest and below).'],
  [/Flexi Cap/i, 'Invests at least 65% in equity, moving freely between large, mid and small caps.'],
  [/Multi Cap/i, 'Invests at least 75% in equity, with at least 25% each in large, mid and small caps.'],
  [/^Value/i, 'Follows a value investing strategy, with at least 65% in equity.'],
  [/ELSS/i, 'Invests at least 80% in equity; units are locked in for 3 years and qualify for Section 80C (old tax regime).'],
  [/Sectoral|Thematic/i, 'Invests at least 80% in one sector or theme.'],
  [/Balanced Advantage|Dynamic Asset/i, 'Moves between equity and debt as markets change (anywhere from 0% to 100% in each).'],
  [/Multi Asset/i, 'Invests in at least three asset classes, with at least 10% in each.'],
  [/^Index Funds/i, 'Tracks a market index, holding at least 95% in that index\u2019s stocks.'],
  [/FoF/i, 'A fund of funds: invests in units of other mutual funds or ETFs.'],
  [/^Liquid/i, 'Invests in debt and money-market securities maturing within 91 days.'],
  [/Money Market/i, 'Invests in money-market instruments maturing within 1 year.'],
  [/Corporate Bond/i, 'Invests at least 80% in corporate bonds rated AA+ or higher.'],
  [/Gilt/i, 'Invests at least 80% in government securities.'],
  [/Children/i, 'A solution-oriented fund with a lock-in of 5 years or until the child turns 18, whichever is earlier.'],
  [/Retirement/i, 'A solution-oriented fund with a lock-in of 5 years or until retirement age, whichever is earlier.'],
];
const mandate = (s: Scheme) => MANDATE.find(([re]) => re.test(s.sub_category))?.[1] || null;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f1 = (n: number) => `${n.toFixed(1)}%`;

/** Pros and cons worked out from the fund's own numbers against the other funds in its category here. */
function prosCons(s: Scheme) {
  const pros: string[] = [];
  const cons: string[] = [];
  const peers = catalog().filter((p) => p.category === s.category && p.isin !== s.isin);
  const r3 = s.returns['3Y'];
  const peer3 = avg(peers.map((p) => p.returns['3Y']).filter((x) => x != null) as number[]);
  if (r3 != null && peer3 != null) {
    if (r3 >= peer3) pros.push(`3Y return of ${f1(r3)} a year beats the ${s.category.toLowerCase()} average here (${f1(peer3)}).`);
    else cons.push(`3Y return of ${f1(r3)} a year trails the ${s.category.toLowerCase()} average here (${f1(peer3)}).`);
  }
  const ter = s.ter?.regular;
  const peerTer = avg(peers.map((p) => p.ter?.regular).filter((x) => x != null) as number[]);
  if (ter != null && peerTer != null && Math.abs(ter - peerTer) >= 0.1) {
    if (ter < peerTer) pros.push(`Expense ratio of ${ter.toFixed(2)}% is below the ${s.category.toLowerCase()} average here (${peerTer.toFixed(2)}%).`);
    else cons.push(`Expense ratio of ${ter.toFixed(2)}% is above the ${s.category.toLowerCase()} average here (${peerTer.toFixed(2)}%).`);
  }
  const rs = (['1Y', '3Y', '5Y'] as const).map((k) => s.returns[k]).filter((x) => x != null) as number[];
  if (rs.length === 3 && rs.every((x) => x > 0)) pros.push('Positive returns over 1, 3 and 5 years.');
  if (s.returns['1Y'] != null && s.returns['1Y'] < 0) cons.push(`Down ${f1(-s.returns['1Y'])} over the last year.`);
  const sip = s.sip.find((x) => x.frequency === 'monthly')?.min;
  if (sip != null && sip <= 500) pros.push(`Low entry: SIPs from \u20b9${sip.toLocaleString('en-IN')} a month.`);
  if (s.lock_in && s.lock_in !== 'N.A') cons.push(`Money is locked in for ${s.lock_in.toLowerCase()}.`);
  else pros.push('No lock-in: redeem any time (exit load may apply).');
  if (/Very High/i.test(s.risk)) cons.push('Very high risk: values can swing sharply; suits 5+ year goals.');
  if (/Low/i.test(s.risk)) pros.push('Lower risk: steadier value, suited to short-term money.');
  if (s.history && s.history.years < 3) cons.push(`Short track record: NAV history only since ${s.history.since.slice(0, 4)}.`);
  return { pros, cons };
}

function compareView(s: Scheme) {
  const sum = summary(s);
  return {
    ...sum,
    exit_load: exitLoad(s),
    lock_in: s.lock_in,
    min_sip: s.sip.find((x) => x.frequency === 'monthly')?.min ?? null,
    history: s.history || null,
    fund_house: s.amc,
    mandate: mandate(s),
    ...fundData(s, { top: 5 }),
    ...prosCons(s),
  };
}

// Figma "Popular Comparison": same category, different fund houses.
const POPULAR = [['INF109K01BL4', 'INF209K01BR9'], ['INF109KC1Q80', 'INF209K01AJ8'], ['INF109K01VQ1', 'INF209K01RU9'], ['INF109K01AN2', 'INF209K01363']];

export const popularComparisons = () => ({ pairs: POPULAR.map((p) => p.map(scheme)).filter((p) => p.every(Boolean)).map((p) => p.map(summary)) });

export function compare(isins: string[]) {
  const list = isins.map(scheme) as Scheme[];
  if (!list.length || list.some((x) => !x)) throw new ApiError(404, 'Fund not found');
  const funds = list.map(compareView);
  return { funds, unavailable: [...new Set(funds.flatMap(missing))] };
}

export async function fundDetail(user: User, isin: string, requestedPeriod: string | undefined) {
  const s = scheme(isin);
  if (!s) throw new ApiError(404, 'Fund not found');
  const period = requestedPeriod && PERIOD_DAYS[requestedPeriod] ? requestedPeriod : '1Y';
  const since = s.chart.at(-1)![0] - PERIOD_DAYS[period] * 864e5;
  // the chart is ~weekly: start it from the last point on or before the period start so the line spans the whole period
  const first = s.chart.findIndex(([t]) => t >= since);
  const chart: [number, number][] = first < 0 ? [] : s.chart.slice(first > 0 && since - s.chart[first - 1][0] < 7 * 864e5 ? first - 1 : first);
  // FP sub-categories differ by fund house ("Equity Schemes - Mid Cap" vs "Mid Cap"), so compare them without the prefix
  const sub = (x: Scheme) => x.sub_category.replace(/^.*? - /, '').toLowerCase();
  const peers = catalog().filter((p) => sub(p) === sub(s) && p.isin !== s.isin).slice(0, 3);
  const sum = summary(s);
  // Buy More: the fund house's additional-purchase minimum applies once the investor has a folio there.
  const folio = await folioForAmc(user.id, s.amc_id);
  return {
    fund: {
      ...sum,
      lumpsum: { ...sum.lumpsum, min: folio ? sum.lumpsum.additional_min || sum.lumpsum.min : sum.lumpsum.min },
      lock_in: s.lock_in, sip: s.sip, redemption_allowed: s.redemption_allowed,
      switch_in_allowed: s.switch_in_allowed, switch_out_allowed: s.switch_out_allowed, stp: s.stp || null, swp: s.swp || null,
      watchlisted: (await watchlistRepo.list(user.id)).includes(s.isin),
      exit_load: exitLoad(s),
      // same buckets as the capital-gains report: equity LT after 12 m, debt always slab, others LT after 24 m
      tax: { equity: { stcg: '20%', ltcg: '12.5%*' }, debt: { stcg: 'As per slab', ltcg: 'As per slab' }, other: { stcg: 'As per slab', ltcg: '12.5% (>24 m)' } }[taxClass(s.isin)],
      ...fundData(s, { top: 200 }), // all holdings: "View all N holdings"
      peers: [s, ...peers].map((p) => ({ name: summary(p).short_name, r1: p.returns['1Y'], r3: p.returns['3Y'], r5: p.returns['5Y'] })),
      source: { scheme_rules: 'FintechPrimitives /v2/mf_scheme_plans (cybrillapoa)', nav: 'AMFI (via mfapi.in)', nav_date: s.nav_date },
    },
    period,
    // 3Y/5Y are annualised (CAGR, like the returns table); a fund younger than the period has no figure
    // same daily-NAV figure as the returns table and the fund lists (the weekly chart points drift from it); the chart
    // itself is only the fallback for a period the catalogue has no figure for
    period_return: s.returns[period as '1Y'] !== undefined ? s.returns[period as '1Y'] : periodReturn(chart, since, period),
    chart,
  };
}

export async function toggleWatchlist(user: User, isin: string) {
  if (!scheme(isin)) throw new ApiError(404, 'Fund not found');
  return { watchlisted: await watchlistRepo.toggle(user.id, isin) };
}

export const watchlist = async (user: User) => ({
  funds: ((await watchlistRepo.list(user.id)).map(scheme).filter(Boolean) as Scheme[]).map((s) => ({ ...summary(s), watchlisted: true })),
});
