// Holdings an investor has outside Risips (other apps, banks, distributors, direct with the fund house), imported
// from a consolidated account statement (see external.service.ts for the import). Stored as the statement's snapshot;
// valued at read time with AMFI's latest NAV so the numbers move daily like the investor's own holdings.
import { extImportsRepo } from '../db/repositories/misc.repository.ts';
import { amcShort, navIndex, schemeShort } from '../integrations/amfi.ts';
import type { NavRec } from '../integrations/amfi.ts';
import { errMsg, log } from '../utils/logger.ts';
import { scheme, summary } from './catalog.service.ts';
import type { ExtImport, ExternalHolding } from '../types/external.ts';

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const key = (folio: string | null | undefined, isin: string) => `${String(folio || '').replace(/\s+/g, '').toUpperCase()}|${isin}`;

/**
 * Values the imported snapshot. `own` = the user's Risips holdings (folio + isin + units + invested): a statement lists
 * every unit in a folio, including the ones bought through Risips, so those are taken out to avoid counting them twice.
 */
export async function externalHoldings(userId: number, own: { folio: string; isin: string; units: number }[] = []) {
  const imp = await extImportsRepo.get<ExtImport>(userId);
  if (!imp?.holdings?.length) return { import: imp, holdings: [] };
  let navs: Record<string, NavRec> = {};
  try { navs = await navIndex(); } catch (e) { log.warn('AMFI NAVs unavailable', { err: errMsg(e) }); }
  const ownBy: Record<string, { folio: string; isin: string; units: number }> = {};
  for (const h of own) ownBy[key(h.folio, h.isin)] = h;
  const out: ExternalHolding[] = [];
  for (const s of imp.holdings) {
    let units = Number(s.units) || 0;
    let cost = Number(s.cost_value) || 0;
    const mine = ownBy[key(s.folio, s.isin)];
    if (mine) {
      // the part of this folio bought outside Risips; cost scaled to the units left
      const left = Math.max(0, units - Number(mine.units || 0));
      cost = units > 0 ? cost * (left / units) : 0;
      units = left;
    }
    if (units <= 0.0005) continue;
    const a = navs[s.isin];
    const cat = scheme(s.isin); // a fund we also sell: richer card (returns, category) and "Invest more"
    // AMFI's NAV when it is at least as new as the statement's, else the statement's own
    const useAmfi = a?.nav && (!s.nav_date || !a.nav_date || a.nav_date >= s.nav_date);
    const nav = useAmfi ? a.nav! : Number(s.nav) || 0;
    const navDate = useAmfi ? a.nav_date : s.nav_date || null;
    const current = units * nav;
    const day = useAmfi && a.prev_nav ? units * (a.nav! - a.prev_nav) : 0;
    // no cost in the statement (a detailed CAS without purchase history): count it at value, so it adds no fake gain
    const costKnown = cost > 0;
    if (!costKnown) cost = current;
    const name = cat ? summary(cat).short_name : schemeShort(a?.name || s.scheme_name);
    const amcName = a?.amc || s.amc_name || cat?.amc || '';
    out.push({
      key: `${s.isin}-${String(s.folio || '').replace(/[^A-Za-z0-9]/g, '')}`, // URL-safe (CAMS folios look like 12345678/90)
      isin: s.isin,
      folio: s.folio,
      external: true,
      fund: cat ? { ...summary(cat) } : {
        isin: s.isin, name: a?.name || s.scheme_name, short_name: name, amc: amcName, amc_short: amcShort(amcName) || name,
        category: a?.category || '', sub_category: a?.sub_category || '', plan: a?.plan || s.plan || null, option: a?.option || null,
        returns: a?.returns || {},
      },
      in_catalog: !!cat,
      registrar: s.registrar || null,
      broker: s.broker || null,
      direct: s.broker ? /^direct$/i.test(s.broker) : /direct/i.test(a?.plan || s.plan || ''),
      units: round(units, 4),
      nav,
      nav_date: navDate,
      current: round(current),
      invested: round(cost),
      cost_known: costKnown,
      gain: round(current - cost),
      gain_pct: cost > 0 ? round(((current - cost) / cost) * 100) : 0,
      avg_nav: costKnown && units ? round(cost / units, 4) : 0,
      day_change: round(day),
      priced: !!nav,
    });
  }
  out.sort((x, y) => y.current - x.current);
  return { import: imp, holdings: out };
}

export function summarise(holdings: { current: number; invested: number; day_change: number }[]) {
  const sum = (k: 'current' | 'invested' | 'day_change') => holdings.reduce((a, h) => a + (Number(h[k]) || 0), 0);
  const current = sum('current');
  const invested = sum('invested');
  const day = sum('day_change');
  return {
    current: round(current), invested: round(invested), gain: round(current - invested),
    gain_pct: invested ? round(((current - invested) / invested) * 100) : 0,
    day_change: round(day), day_change_pct: current - day ? round((day / (current - day)) * 100) : 0,
  };
}
