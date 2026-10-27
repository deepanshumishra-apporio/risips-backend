// Builds data/catalog.json: a curated list of sandbox-purchasable schemes with NAV history.
//   - scheme master + rules from FP  (GET /api/oms/fund_schemes, GET /v2/mf_scheme_plans/cybrillapoa/:isin)
//   - NAV history from AMFI via mfapi.in (FP has no NAV/returns API for the catalogue)
// Sandbox only carries ICICI Pru (amc 15) and Aditya Birla SL (amc 3), all REGULAR plans.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config/env.ts';
import { fp } from '../src/integrations/fp.client.ts';
import { stpRules, swpRules, switchInRule } from './stp-rules.ts';
import { historyFacts } from './fund-facts.ts';
import type { NavPoint } from './fund-facts.ts';
import type { Scheme } from '../src/types/catalog.ts';
import type { JsonObject } from '../src/types/domain.ts';

// The catalogue comes from the sandbox: production's OMS master is empty. Production rules: scripts/prod-rules.ts.
if (config.production) throw new Error('build-catalog runs on the sandbox only (unset FP_ENV)');

const PICKS: [amc: number, query: string, tags: string[]][] = [
  // [amc_id, name search, collection tags]
  [15, 'bluechip', ['large']], [15, 'large cap', ['large']], [15, 'midcap', ['mid', 'high']], [15, 'smallcap', ['small', 'high']],
  [15, 'flexicap', ['flexi']], [15, 'value discovery', ['high']], [15, 'value fund', ['high']], [15, 'elss', ['tax']], [15, 'tax saver', ['tax']],
  [15, 'balanced advantage', ['hybrid']], [15, 'equity & debt', ['hybrid']], [15, 'multi-asset', ['hybrid', 'commodity']],
  [15, 'technology', ['sector', 'high']], [15, 'pharma', ['sector']], [15, 'banking & financial', ['sector']], [15, 'infrastructure', ['sector', 'high']],
  [15, 'liquid', ['debt']], [15, 'money market', ['debt']], [15, 'corporate bond', ['debt']], [15, 'gilt', ['debt']],
  [15, 'nifty 50 index', ['index', 'large']], [15, 'nifty next 50', ['index']], [15, 'nifty50 value 20', ['index']],
  [15, 'gold', ['commodity']], [15, 'silver', ['commodity']], [15, 'child', []], [15, 'retirement', []],
  [3, 'frontline', ['large']], [3, 'flexi cap', ['flexi']], [3, 'midcap', ['mid']], [3, 'small cap', ['small', 'high']],
  [3, 'elss', ['tax']], [3, 'digital india', ['sector', 'high']], [3, 'psu equity', ['sector', 'high']], [3, 'liquid', ['debt']],
  [3, 'balanced advantage', ['hybrid']], [3, 'gold fund', ['commodity']], [3, 'nifty 50 index', ['index', 'large']],
  [3, 'corporate bond', ['debt']], [3, 'multi-cap', ['flexi']], [3, 'silver', ['commodity']],
];
const BAD = /idcw|dividend|segregated|unclaimed|fmp|fixed maturity|series|interval|etf$|bonus|institutional|direct|payout|quarterly|monthly|annual|weekly|daily/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mfapi(code: string): Promise<JsonObject | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.mfapi.in/mf/${code}`);
      if (r.ok) return await r.json() as JsonObject;
    } catch {}
    await sleep(1000);
  }
  return null;
}

const parseDate = (s: string) => { const [d, m, y] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };

function returnsFrom(series: NavPoint[]): Scheme['returns'] {
  // series: [{t, nav}] ascending
  const last = series.at(-1)!;
  const at = (days: number) => {
    const target = last.t - days * 864e5;
    let best: NavPoint | null = null;
    for (const p of series) { if (p.t <= target) best = p; else break; }
    return best && last.t - best.t < (days + 10) * 864e5 ? best : null;
  };
  const cagr = (p: NavPoint | null, yrs: number) => (p ? (Math.pow(last.nav / p.nav, 1 / yrs) - 1) * 100 : null);
  const abs = (p: NavPoint | null | undefined) => (p ? (last.nav / p.nav - 1) * 100 : null);
  const r = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
  return {
    '1D': r(abs(series.at(-2))), '1M': r(abs(at(30))), '6M': r(abs(at(182))), '1Y': r(abs(at(365))),
    '3Y': r(cagr(at(365 * 3), 3)), '5Y': r(cagr(at(365 * 5), 5)),
  };
}

function category(meta: JsonObject | undefined, v1: JsonObject) {
  const c = meta?.scheme_category || '';
  const m = c.match(/Scheme - (.*)$/);
  // fund-of-funds must not fall into Debt (ABSL Silver ETF FOF did)
  const fof = /Fund of Funds|FoF/i.test(c);
  const sub = fof ? 'FoF Domestic' : (m ? m[1] : c).replace(/ Fund$/, '').replace('Other Scheme - ', '');
  const broad = fof ? 'Index' : /Equity|ELSS/i.test(c) ? 'Equity' : /Debt/i.test(c) ? 'Debt' : /Hybrid/i.test(c) ? 'Hybrid'
    : /Index|ETF|FoF/i.test(c) ? 'Index' : /Solution/i.test(c) ? 'Solution' : (v1.fund_category || 'Other');
  return { broad: broad[0] + broad.slice(1).toLowerCase(), sub };
}

function riskFor(broad: string, sub: string) {
  if (/liquid|overnight|money market/i.test(sub)) return 'Low to Moderate Risk';
  if (broad === 'Debt') return 'Moderate Risk';
  if (broad === 'Hybrid') return 'High Risk';
  return 'Very High Risk';
}

const out: Scheme[] = [];
const seen = new Set<string>();
for (const [amc, q, tags] of PICKS) {
  let list: JsonObject;
  try {
    list = await fp.get(`/api/oms/fund_schemes?amc_id=${amc}&investment_option=GROWTH&name=${encodeURIComponent(q)}&size=100&page=0`, { quiet: true });
  } catch (e) { console.log('list failed', q, (e as Error).message); continue; }
  const cands: JsonObject[] = (list.fund_schemes || []).filter((s: JsonObject) => s.active && s.purchase_allowed && s.amfi_code && s.isin && !BAD.test(s.name) && !seen.has(s.isin));
  cands.sort((a, b) => a.name.length - b.name.length);
  let picked: { s: JsonObject; v2: JsonObject; hist: JsonObject } | null = null;
  for (const s of cands.slice(0, 4)) {
    const v2 = await fp.raw('GET', `/v2/mf_scheme_plans/cybrillapoa/${s.isin}?expand=mf_scheme,mf_fund`, undefined, { quiet: true });
    if (v2.status !== 200 || v2.json?.active === false) continue;
    const hist = await mfapi(s.amfi_code);
    if (!hist?.data?.length || hist.data.length < 250) continue;
    const lastDate = parseDate(hist.data[0].date);
    if (Date.now() - lastDate > 30 * 864e5) continue; // stale / closed scheme
    picked = { s, v2: v2.json, hist };
    break;
  }
  if (!picked) { console.log('-', amc, q, '(none)'); continue; }
  const { s, v2, hist } = picked;
  seen.add(s.isin);
  const series: NavPoint[] = hist.data.map((d: JsonObject) => ({ t: parseDate(d.date), nav: Number(d.nav) })).filter((p: NavPoint) => p.nav > 0).reverse();
  const last = series.at(-1)!;
  // keep ~weekly points for 5 years for the chart
  const since = last.t - 5 * 365 * 864e5;
  const chart: [number, number][] = [];
  let lastKept = 0;
  for (const p of series) if (p.t >= since && p.t - lastKept >= 6 * 864e5) { chart.push([p.t, p.nav]); lastKept = p.t; }
  if (chart.at(-1)?.[0] !== last.t) chart.push([last.t, last.nav]);
  const lump = (v2.thresholds || []).find((t: JsonObject) => t.type === 'lumpsum') || {};
  const swIn = (v2.thresholds || []).find((t: JsonObject) => t.type === 'switch_in');
  const sips: JsonObject[] = (v2.thresholds || []).filter((t: JsonObject) => t.type === 'sip' && ['monthly', 'weekly', 'quarterly'].includes(t.frequency));
  const cat = category(hist.meta, s);
  const oms = await fp.get(`/api/oms/fund_schemes/${s.isin}`, { quiet: true }).catch(() => ({}));
  out.push({
    isin: s.isin,
    name: hist.meta?.scheme_name?.replace(/\s+-\s+/g, ' - ') || s.name,
    amc: amc === 15 ? 'ICICI Prudential Mutual Fund' : 'Aditya Birla Sun Life Mutual Fund',
    amc_short: amc === 15 ? 'ICICI Pru' : 'Aditya Birla SL',
    amc_id: amc,
    amfi_code: s.amfi_code,
    plan: 'Regular', option: 'Growth',
    category: cat.broad, sub_category: cat.sub,
    risk: riskFor(cat.broad, cat.sub),
    tags,
    // FP gives lock_in_period in months (ELSS 36, retirement 60)
    lock_in: s.lock_in ? `${(s.lock_in_period ?? 36) / 12} Years` : 'N.A',
    nav: last.nav, nav_date: new Date(last.t).toISOString().slice(0, 10),
    returns: returnsFrom(series),
    lumpsum: { allowed: !!lump.type, min: lump.amount_min ?? s.min_initial_investment, additional_min: lump.additional_amount_min ?? s.min_additional_investment, multiples: lump.amount_multiples ?? 1, max: lump.amount_max ?? null },
    sip: sips.map((t) => ({ frequency: t.frequency, min: t.amount_min, multiples: t.amount_multiples, installments_min: t.installments_min, dates: t.dates })),
    redemption_allowed: s.redemption_allowed, switch_out_allowed: s.switch_out_allowed, switch_in_allowed: s.switch_in_allowed,
    switch_in: switchInRule(swIn),
    stp: stpRules(oms),
    swp: swpRules(oms),
    history: historyFacts(series),
    chart,
  });
  console.log('+', s.isin, out.at(-1)!.name, `3Y=${out.at(-1)!.returns['3Y']}`, 'min', out.at(-1)!.lumpsum.min);
}

const file = path.join(ROOT, 'data', 'catalog.json');
fs.writeFileSync(file, JSON.stringify({ built_at: new Date().toISOString(), schemes: out }));
console.log(`\n${out.length} schemes -> ${file}`);
