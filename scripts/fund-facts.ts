// Adds `history` (AMFI NAV history start + since-then CAGR) to data/catalog.json without rebuilding it.
// build-catalog.ts sets it too. Used by Compare Funds ("NAV history since", "Since launch" return).
// AMFI (via mfapi.in) data for Regular plans usually starts at the plan's launch, or 2006 for older schemes,
// so the app labels it as NAV history rather than an official inception date.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config/env.ts';
import type { Scheme } from '../src/types/catalog.ts';
import type { JsonObject } from '../src/types/domain.ts';

/** One daily NAV. */
export interface NavPoint { t: number; nav: number }

/** series: [{t, nav}] ascending -> { since: yyyy-mm-dd, years, cagr } */
export function historyFacts(series: NavPoint[]): Scheme['history'] {
  // A face-value change (liquid funds moved from ₹10 to ₹1,000 units) shows up as a one-day NAV jump; real funds
  // never move ±40% in a day, so only the history after the last such jump is comparable.
  let start = 0;
  for (let i = 1; i < series.length; i++) {
    const x = series[i].nav / series[i - 1].nav;
    if (x > 1.4 || x < 0.6) start = i;
  }
  series = series.slice(start);
  const first = series[0];
  const last = series.at(-1);
  if (!first || !last || last.t <= first.t) return null;
  const years = (last.t - first.t) / (365.25 * 864e5);
  const growth = last.nav / first.nav;
  const pct = years >= 1 ? (growth ** (1 / years) - 1) * 100 : (growth - 1) * 100;
  return { since: new Date(first.t).toISOString().slice(0, 10), years: Math.round(years * 10) / 10, cagr: Math.round(pct * 100) / 100, annualised: years >= 1 };
}

const parseDate = (s: string) => { const [d, m, y] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };

if (process.argv[1]?.endsWith('fund-facts.ts')) {
  const file = path.join(ROOT, 'data', 'catalog.json');
  const cat: { schemes: Scheme[] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of cat.schemes) {
    const r = await fetch(`https://api.mfapi.in/mf/${s.amfi_code}`).catch(() => null);
    const j = r?.ok ? await r.json() as JsonObject : null;
    if (!j?.data?.length) { console.log('-', s.isin, 'no history'); continue; }
    const series = j.data.map((d: JsonObject) => ({ t: parseDate(d.date), nav: Number(d.nav) })).filter((p: NavPoint) => p.nav > 0).reverse();
    s.history = historyFacts(series);
    console.log('+', s.isin, s.history?.since, `${s.history?.cagr}%`, s.name.slice(0, 50));
  }
  fs.writeFileSync(file, JSON.stringify(cat));
  console.log('\nupdated', file);
}
