// The Portfolio screen: Risips holdings (FP holdings report by folio, returns, running plans per holding) plus funds
// imported from other platforms (external.service.ts).
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { fp } from '../integrations/fp.client.ts';
import { scheme, summary } from './catalog.service.ts';
import { inProgress, openView, outOf, pendingItem } from './orders.service.ts';
import { externalHoldings, summarise } from './externalHoldings.service.ts';
import { planView } from './sip.service.ts';
import type { FundSummary } from '../types/catalog.ts';
import type { FpObject, Order, User } from '../types/domain.ts';

/** One Risips holding on the Portfolio screen (portfolio()). */
export interface Holding {
  isin: string; folio: string; fund: FundSummary | { name: string; short_name: string };
  units: number; nav: number; nav_date: string | undefined; current: number; invested: number; redeemable: number;
  gain: number; gain_pct: number; avg_nav: number; xirr: number | null; day_change: number;
  /** A redemption / switch of all units is in progress: nothing more can leave until it's processed. */
  locked: boolean;
  /** Orders on their way out of / into this holding. */
  pending: ReturnType<typeof pendingItem>[];
  sip: { id: string; amount: number; count: number; next: string | null; frequency: string | undefined } | null;
  stp: { id: string; amount: number | null; next: string | undefined; to: string | null } | null;
  swp: { id: string; amount: number | null; next: string | undefined; remaining: number | null } | null;
} // circular with sip.ts: only used inside functions, so safe in ESM

/** Every folio the user's orders have landed in (FP reports are queried by folio on ONDC). */
export const foliosFor = (all: Order[]): string[] => [...new Set(all.flatMap((o) => [
  o.data.fp?.folio_number, o.data.fp?.switch_in_folio_number, ...(o.data.installments || []).map((i) => i.folio),
]).filter(Boolean))];

export async function portfolio(user: User) {
  const ids = user.data.fp;
  const all = ids?.mfia ? await ordersRepo.forUser(user.id) : [];
  const open = all.filter(inProgress);
  const empty = {
    summary: { current: 0, invested: 0, gain: 0, gain_pct: 0, day_change: 0, day_change_pct: 0, xirr: null as number | null }, holdings: [] as Holding[],
    in_progress: open.map(openView), incoming: incomingFunds(open, []),
  };
  if (!ids?.mfia) return empty;
  const folios = foliosFor(all);
  if (!folios.length) return empty;
  const rep = await fp.get(`/api/oms/reports/holdings?folios=${folios.join(',')}`, { label: 'holdings report' });
  const xirrByIsin: Record<string, FpObject> = {};
  let acctXirr: number | null = null;
  try {
    const sw = await fp.post('/v2/transactions/reports/scheme_wise_returns', { mf_investment_account: ids.mfia }, { label: 'scheme-wise returns' });
    const cols: string[] = sw.data?.columns || [];
    for (const row of sw.data?.rows || []) {
      const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      xirrByIsin[o.isin] = o;
    }
    const aw = await fp.post('/v2/transactions/reports/investment_account_wise_returns', { mf_investment_account: ids.mfia }, { label: 'account returns' });
    const c2: string[] = aw.data?.columns || [];
    const row = aw.data?.rows?.[0];
    // the sandbox returns xirr 0.00 for everything; a flat 0 is "not computed", not a real 0% return
    if (row) acctXirr = Number(Object.fromEntries(c2.map((c, i) => [c, row[i]])).xirr) || null;
  } catch {}
  // XIRR annualises: on money invested for weeks it reads as +640% or -60%. Like other MF apps, show it only once
  // the first investment is a year old (absolute return is on screen already).
  const YEAR = 365 * 864e5;
  const firstAt = (isin?: string) => Math.min(...all.filter((o) => !isin || o.isin === isin).map((o) => Date.parse(o.created_at + 'Z') || Infinity));
  const aged = (isin?: string) => Date.now() - firstAt(isin) >= YEAR;
  if (!aged()) acctXirr = null;
  const holdings: Holding[] = [];
  for (const f of rep.folios || []) {
    for (const sc of f.schemes || []) {
      const units = Number(sc.holdings?.units || 0);
      if (units <= 0) continue;
      const cur = Number(sc.market_value?.amount || 0);
      const inv = Number(sc.invested_value?.amount || 0);
      const cat = scheme(sc.isin);
      const d1 = cat?.returns?.['1D'] ?? 0;
      // every running SIP into this scheme (a fund can have more than one): total per month, earliest next debit
      // next = the skip-aware next debit (FP's next_installment_date ignores pauses and a modified SIP's start skip)
      const sips = all.filter((o) => o.kind === 'sip' && o.isin === sc.isin && ['active', 'confirmed'].includes(o.state) && !o.data.first_payment_failed
        && (!o.data.fp?.folio_number || o.data.fp.folio_number === f.folio_number))
        .map((o) => ({ o, next: planView(o).next_debit }))
        .sort((a, b) => String(a.next || '9').localeCompare(String(b.next || '9')));
      const sip = sips[0]?.o;
      const stp = all.find((o) => o.kind === 'stp' && o.isin === sc.isin && o.data.fp?.folio_number === f.folio_number && ['active', 'confirmed', 'submitted'].includes(o.state));
      const swp = all.find((o) => o.kind === 'swp' && o.isin === sc.isin && o.data.fp?.folio_number === f.folio_number && ['active', 'confirmed', 'submitted'].includes(o.state));
      // orders on their way out of / into this holding; a full redemption or switch out locks it
      const out = outOf(open, f.folio_number, sc.isin);
      const into = open.filter((o) => !out.includes(o) && (o.kind === 'purchase' ? o.isin : o.isin_to) === sc.isin
        && (o.kind === 'purchase' ? !o.data.fp?.folio_number || o.data.fp.folio_number === f.folio_number : (o.data.fp?.switch_in_folio_number || o.data.fp?.folio_number) === f.folio_number));
      const locked = out.some((o) => o.amount == null);
      const redeemable = Number(sc.market_value?.redeemable_amount ?? cur);
      holdings.push({
        isin: sc.isin, folio: f.folio_number, fund: summary(cat) || { name: sc.name, short_name: sc.name },
        units, nav: Number(sc.nav?.value || 0), nav_date: sc.nav?.as_on, current: cur, invested: inv,
        redeemable: locked ? 0 : redeemable, gain: cur - inv,
        locked, pending: [...out.map((o) => pendingItem(o, 'out')), ...into.map((o) => pendingItem(o, 'in'))],
        gain_pct: inv ? ((cur - inv) / inv) * 100 : 0, avg_nav: units ? inv / units : 0,
        xirr: aged(sc.isin) ? Number(xirrByIsin[sc.isin]?.xirr) || null : null, day_change: cur - cur / (1 + d1 / 100),
        sip: sip ? { id: sip.id, amount: sips.reduce((a, x) => a + Number(x.o.amount || 0), 0), count: sips.length, next: sips[0].next, frequency: sip.data.fp?.frequency } : null,
        stp: stp ? { id: stp.id, amount: stp.amount, next: stp.data.fp?.next_installment_date, to: summary(scheme(stp.isin_to))?.short_name || stp.isin_to } : null,
        swp: swp ? { id: swp.id, amount: swp.amount, next: swp.data.fp?.next_installment_date, remaining: swp.data.fp?.remaining_installments ?? null } : null,
      });
    }
  }
  const sum = (k: 'current' | 'invested' | 'day_change') => holdings.reduce((a, h) => a + h[k], 0);
  const current = sum('current');
  const invested = sum('invested');
  const day = sum('day_change');
  return {
    summary: {
      current, invested, gain: current - invested, gain_pct: invested ? ((current - invested) / invested) * 100 : 0,
      day_change: day, day_change_pct: current ? (day / (current - day)) * 100 : 0, xirr: acctXirr,
    },
    holdings,
    in_progress: open.map(openView),
    incoming: incomingFunds(open, holdings),
  };
}

/** Funds on their way in (a paid purchase, a switch's target) that aren't holdings yet: one placeholder row per fund. */
function incomingFunds(open: Order[], holdings: Holding[]) {
  const rows = new Map<string, { isin: string; fund: FundSummary | { name: string; short_name: string }; orders: ReturnType<typeof pendingItem>[] }>();
  for (const o of open) {
    const isin = o.kind === 'purchase' ? o.isin : o.kind === 'switch' ? o.isin_to : null;
    if (!isin || holdings.some((h) => h.isin === isin)) continue;
    const row = rows.get(isin) || { isin, fund: summary(scheme(isin)) || { name: isin, short_name: isin }, orders: [] };
    row.orders.push(pendingItem(o, 'in'));
    rows.set(isin, row);
  }
  return [...rows.values()];
}

/**
 * Risips holdings plus the funds imported from other platforms. `holdings` stays Risips-only: redeem, switch, STP and
 * SWP pick from it, and none of them can act on a fund held elsewhere. `external` carries the imported funds and
 * `combined` the summary over both (shown unless the investor hides external investments).
 */
export async function portfolioWithExternal(user: User) {
  const pf = await portfolio(user);
  const ext = await externalHoldings(user.id, pf.holdings);
  const imp = ext.import;
  const st = user.data.ext || {};
  const external = {
    status: st.status || (imp ? 'ready' : 'none'),
    hidden: !!st.hidden,
    source: imp?.source || null,
    as_of: imp?.as_of || null,
    imported_at: imp?.imported_at || null,
    error: st.status === 'failed' ? st.error || null : null,
    holdings: ext.holdings,
    summary: summarise(ext.holdings),
  };
  const all = summarise([...pf.holdings, ...ext.holdings]);
  return { ...pf, external, combined: { ...all, xirr: ext.holdings.length ? null : pf.summary.xirr } };
}

