// AMFI daily NAVs for every scheme in India (any fund house), keyed by ISIN. Used to value holdings imported from
// other platforms, which can be in any of ~14,000 schemes while catalog.json only covers the fund houses we sell.
//   latest:   https://portal.amfiindia.com/spages/NAVAll.txt  (one row per scheme, last NAV)
//   previous: https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=&todt=  (all NAVs in a date range)
// Both are ';' separated, with fund-house and "Open Ended Schemes(Category - Sub category)" header lines in between.
// Cached in data/amfi_navs.json and refreshed every few hours; a failed refresh keeps serving the last good copy.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/env.ts';
import { errMsg, log } from '../utils/logger.ts';

/** One scheme in AMFI's NAV list. */
export interface NavRec {
  code: number; name: string; plan: string | null; option: string | null; amc: string | null;
  category: string; sub_category: string; structure: string;
  nav: number | null; nav_date: string | null; prev_nav: number | null; prev_date: string | null;
  returns?: Record<string, number>;
}
interface NavCache { fetched_at: number; by_isin: Record<string, NavRec> }
type Category = { category: string; sub_category: string; structure: string };
interface WalkCtx { amc: string | null; cat: Category }

const FILE = path.join(paths.data, 'amfi_navs.json');
const MAX_AGE = 4 * 3600e3;
const MON: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const MON_NAMES = Object.keys(MON);

/** '12-Oct-2026' -> '2026-10-12' */
const isoDate = (s: string | undefined) => {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec((s || '').trim());
  return m && MON[m[2]] ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null;
};
const amfiDate = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${MON_NAMES[d.getMonth()]}-${d.getFullYear()}`;

/** "Open Ended Schemes(Equity Scheme - Mid Cap Fund)" -> { category: 'Equity', sub_category: 'Mid Cap Fund' } */
function parseCategory(line: string): Category {
  const m = /\(\s*(.*?)\s*\)\s*$/.exec(line);
  const inner = m ? m[1] : '';
  const [group, ...rest] = inner.split(' - ');
  const sub = rest.join(' - ').trim() || group.trim();
  const g = group.toLowerCase();
  const category = g.includes('equity') ? 'Equity' : g.includes('debt') || g.includes('income') || g.includes('money market') ? 'Debt'
    : g.includes('hybrid') ? 'Hybrid' : /solution|child|retire|life cycle/.test(g) ? 'Solution'
    : g.includes('index') || /index|etf/i.test(sub) ? 'Index' : 'Other';
  return { category, sub_category: sub, structure: /close/i.test(line) ? 'close_ended' : /interval/i.test(line) ? 'interval' : 'open_ended' };
}

/** Walks an AMFI text file; calls row(cols, ctx) for each scheme line with the fund house and category it sits under. */
function walk(text: string, row: (cols: string[], ctx: WalkCtx) => void) {
  const ctx: WalkCtx = { amc: null, cat: { category: 'Other', sub_category: '', structure: 'open_ended' } };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes(';')) {
      const cols = line.split(';').map((c) => c.trim());
      if (/^\d+$/.test(cols[0])) row(cols, ctx);
      continue;
    }
    if (/^(open|close)\s*ended|^interval/i.test(line)) ctx.cat = parseCategory(line);
    else if (/mutual fund$/i.test(line)) ctx.amc = line;
  }
}

const isIsin = (s: string | undefined) => /^IN[A-Z0-9]{10}$/.test(s || '');
const num = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? n : null; };

async function get(url: string, timeoutMs = 90e3) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (risips backend)' } });
  if (!res.ok) throw new Error(`AMFI ${res.status} for ${url}`);
  return res.text();
}

async function build(): Promise<NavCache> {
  // latest NAV + metadata. NAVAll columns: code; ISIN growth/payout; ISIN reinvest; name; plan; option; NAV; date
  const all = await get('https://portal.amfiindia.com/spages/NAVAll.txt');
  const byIsin: Record<string, NavRec> = {};
  walk(all, (c, ctx) => {
    const rec: NavRec = {
      code: Number(c[0]), name: c[3], plan: c[4] || null, option: c[5] || null, amc: ctx.amc, ...ctx.cat,
      nav: num(c[6]), nav_date: isoDate(c[7]), prev_nav: null, prev_date: null,
    };
    for (const isin of [c[1], c[2]]) if (isIsin(isin)) byIsin[isin] = rec;
  });
  if (Object.keys(byIsin).length < 5000) throw new Error('AMFI NAVAll looked truncated');
  // previous NAV for the 1-day change: history over the last 10 days (covers long weekends and holidays).
  // History columns: code; name; plan; option; ISIN growth/payout; ISIN reinvest; NAV; date
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 864e5);
    const hist = await get(`https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${amfiDate(from)}&todt=${amfiDate(to)}`, 120e3);
    const series: Record<string, [string, number][]> = {};
    walk(hist, (c) => {
      const d = isoDate(c[7]);
      const v = num(c[6]);
      if (!d || !v) return;
      for (const isin of [c[4], c[5]]) if (isIsin(isin)) (series[isin] ||= []).push([d, v]);
    });
    for (const [isin, pts] of Object.entries(series)) {
      const rec = byIsin[isin];
      if (!rec?.nav_date) continue;
      const before = pts.filter(([d]) => d < rec.nav_date!).sort((a, b) => a[0].localeCompare(b[0])).pop();
      if (before) { rec.prev_nav = before[1]; rec.prev_date = before[0]; }
    }
  } catch (e) {
    log.warn('AMFI history fetch failed, 1D change unavailable', { err: errMsg(e) });
  }
  // 1Y / 3Y / 5Y returns (same method as scripts/build-catalog.ts: 1Y absolute, 3Y and 5Y CAGR) from the NAV on the
  // last trading day on or before the date that many years back. One history window per period.
  const now = Date.now();
  for (const [label, yrs] of [['1Y', 1], ['3Y', 3], ['5Y', 5]] as const) {
    try {
      const target = new Date(now - Math.round(yrs * 365) * 864e5);
      const targetIso = target.toISOString().slice(0, 10);
      const hist = await get(`https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${amfiDate(new Date(target.getTime() - 9 * 864e5))}&todt=${amfiDate(target)}`, 120e3);
      const past: Record<string, [string, number]> = {};
      walk(hist, (c) => {
        const d = isoDate(c[7]);
        const v = num(c[6]);
        if (!d || !v || d > targetIso) return;
        for (const isin of [c[4], c[5]]) if (isIsin(isin) && (!past[isin] || past[isin][0] < d)) past[isin] = [d, v];
      });
      for (const [isin, [, then]] of Object.entries(past)) {
        const rec = byIsin[isin];
        if (!rec?.nav) continue;
        const r = yrs === 1 ? (rec.nav / then - 1) * 100 : (Math.pow(rec.nav / then, 1 / yrs) - 1) * 100;
        if (isFinite(r)) (rec.returns ||= {})[label] = Math.round(r * 100) / 100;
      }
    } catch (e) {
      log.warn(`AMFI ${label} history fetch failed`, { err: errMsg(e) });
    }
  }
  return { fetched_at: Date.now(), by_isin: byIsin };
}

let cache: NavCache | null = null;
let inflight: Promise<NavCache> | null = null;
let lastFail = 0;

function load() {
  if (!cache && fs.existsSync(FILE)) {
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = null; }
  }
  return cache;
}

/** Refreshes the NAV index when it is older than a few hours. Never throws while an older copy exists. */
export async function navIndex({ force = false } = {}): Promise<Record<string, NavRec>> {
  const c = load();
  if (c && !force && Date.now() - c.fetched_at < MAX_AGE) return c.by_isin;
  if (c && !force && Date.now() - lastFail < 15 * 60e3) return c.by_isin; // AMFI was down a moment ago: don't hammer it
  const run = inflight ||= build()
    .then((fresh) => {
      cache = fresh;
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(fresh));
      return fresh;
    })
    .catch((e) => { lastFail = Date.now(); throw e; })
    .finally(() => { inflight = null; });
  // stale copy: serve it now and refresh in the background (a refresh takes ~12 s; a portfolio load shouldn't wait)
  if (c && !force) { run.catch((e) => log.warn('AMFI background refresh failed', { err: errMsg(e) })); return c.by_isin; }
  try {
    return (await run).by_isin;
  } catch (e) {
    if (c) { log.warn('AMFI refresh failed, serving cached NAVs', { err: errMsg(e) }); return c.by_isin; }
    throw e;
  }
}

/** One scheme by ISIN (null when AMFI doesn't list it, e.g. a wound-up scheme). */
export async function navFor(isin: string) {
  return (await navIndex())[isin] || null;
}

/** "HDFC Mutual Fund" -> "HDFC" (for the AMC tile). */
export const amcShort = (amc: string | null | undefined) => (amc || '').replace(/\s*Mutual Fund$/i, '').replace(/Aditya Birla Sun Life/i, 'ABSL').trim();

const ACRONYMS = new Set(['SBI', 'HDFC', 'ICICI', 'UTI', 'DSP', 'IDCW', 'ELSS', 'ETF', 'FOF', 'PSU', 'US', 'LIC', 'HSBC', 'ITI', 'JM', 'PGIM', 'NJ', 'ABSL', 'IDFC', 'BNP', 'TATA', 'AMC', 'NFO', 'CPSE', 'BSE', 'NSE', 'PPFAS', 'MNC', 'ESG', 'BFSI', 'IT']);
/** "SBI SMALL CAP FUND" -> "SBI Small Cap Fund" (some fund houses file their names in capitals with AMFI). */
const unshout = (s: string) => (s && s === s.toUpperCase() && /[A-Z]{4}/.test(s)
  ? s.toLowerCase().replace(/[a-z][a-z0-9']*/g, (w) => (ACRONYMS.has(w.toUpperCase()) && w !== 'it' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  : s);

/** Scheme name without the plan/option tail, as a list label ("HDFC Mid Cap Fund"). */
export const schemeShort = (name: string | null | undefined) => unshout(name || '')
  .replace(/\s*[-–]\s*(Direct|Regular)\b.*$/i, '')
  .replace(/\s*[-–]\s*(Growth|IDCW|Dividend)\b.*$/i, '')
  .replace(/\s*\((formerly|erstwhile)[^)]*\)/i, '')
  .trim();
