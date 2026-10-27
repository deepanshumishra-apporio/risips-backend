// Figma "Reports & Statements". Every report returns one shape that the app renders as cards and
// /reports/:key/html renders as a printable statement (the app turns it into a PDF with expo-print).
//
// Sources (verified on the ONDC sandbox 2026-09-23):
//   capital gains  POST /v2/transactions/reports/capital_gains   (FIFO lots; no STCG/LTCG flag, we classify)
//   holdings       GET  /api/oms/reports/holdings?folios=         (via portfolio())
//   dividends/ELSS GET  /transactions?folios=&types=&from=&to=    (note: no /v2 prefix; range capped at 1 year)
//   order history, contract notes, balance, GST: our own orders table (FP has no endpoint for these)
import { config } from '../config/env.ts';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { fp } from '../integrations/fp.client.ts';
import { ApiError } from '../utils/errors.ts';
import { scheme, summary, taxClass } from './catalog.service.ts';
import { PATHS, view } from './orders.service.ts';
import { foliosFor, portfolio } from './portfolio.service.ts';
import { publicUser } from './user.service.ts';
import type { FpObject, User } from '../types/domain.ts';

/** The report's query: the financial year (start year) and, for one contract note, the order id. */
export interface ReportQuery { fy?: number; id?: string }

type Tone = 'up' | 'down' | undefined;
/** One line of a report: a card in the app, a table row in the printable statement. */
interface ReportRow { title: string | null; sub: string; value: string; value_sub?: string; tone?: Tone; link?: { key: string; id: string }; cells: unknown[] }
interface ReportSection { title: string; columns: string[]; rows: ReportRow[] }
/** The one shape every report returns. */
interface Report {
  title: string; period: string; fy?: ReturnType<typeof fyOf>['picker'];
  summary: { label: string; value: string; tone?: Tone }[];
  details?: { label: string; value: unknown }[];
  sections: ReportSection[]; empty: string | null; notes: string[];
}
type Fy = ReturnType<typeof fyOf>;
/** A row of the order history. */
interface OrderLine { date: string; ref: string; kind: string; fund: string | null; amount: unknown; units: unknown; state: string }
/** A completed order with a contract note. */
interface NoteLine { id: string; date: string; ref: string; kind: string; fund: string | null; amount: unknown }


// ---------- formatting ----------

const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs = (n: number | null | undefined) => (n == null || !isFinite(n) ? '-' : `${n < 0 ? '-' : ''}₹${inr2.format(Math.abs(n))}`);
const u3 = (n: unknown) => (n == null ? '-' : Number(n).toFixed(3));
const nav4 = (n: unknown) => (n == null ? '-' : `₹${Number(n).toFixed(4)}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' as-is (FP dates are IST); stored 'YYYY-MM-DD HH:MM:SS' timestamps are UTC, so shift them to IST. */
const istDate = (s: unknown): string | null => {
  if (!s) return null;
  const t = String(s);
  if (t.length <= 10 || /[zZ+]/.test(t.slice(10))) return t.slice(0, 10);
  return new Date(Date.parse(t.replace(' ', 'T') + 'Z') + 5.5 * 3600e3).toISOString().slice(0, 10);
};
const day = (s: string | null | undefined): string => {
  if (!s) return '-';
  const [y, m, d] = istDate(s)!.split('-').map(Number);
  return y ? `${d} ${MONTHS[m - 1]} ${y}` : s;
};
const tone = (n: number): Tone => (n > 0 ? 'up' : n < 0 ? 'down' : undefined);
const fundName = (isin: string | null, fallback?: string | null) => summary(scheme(isin))?.short_name || fallback || isin;
const table = (d: FpObject | undefined): FpObject[] => (d?.rows || []).map((row: unknown[]) => Object.fromEntries((d!.columns || []).map((c: string, i: number) => [c, row[i]])));

// ---------- financial year ----------

function currentFy() {
  const now = new Date(Date.now() + 5.5 * 3600e3); // IST
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // FY starts 1 April
}
function fyOf(q: ReportQuery) {
  const cur = currentFy();
  const fy = q.fy || cur;
  const label = (y: number) => `FY ${y}-${String(y + 1).slice(2)}`;
  return {
    fy, from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: label(fy),
    picker: { value: fy, options: [cur, cur - 1, cur - 2].map((y) => ({ value: y, label: label(y) })) },
  };
}
// /transactions rejects a `to` after today ("To date cannot be after current date"); FP runs on IST
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const txnRange = (p: Fy) => `from=${p.from}&to=${p.to < todayIst() ? p.to : todayIst()}`;
const inFy = (date: string | null | undefined, p: Fy) => !!date && istDate(date)! >= p.from && istDate(date)! <= p.to;

// ---------- capital gains classification ----------
// FP returns days held per lot but no short/long-term flag. Indicative rules (Finance Act 2024):
// equity-oriented funds are long-term after 12 months; debt funds bought after 1 Apr 2023 are always
// short-term (slab rate); other funds (hybrid, FoF, gold/silver) are long-term after 24 months.
function term(isin: string, days: number, boughtOn: unknown) {
  const c = taxClass(isin);
  // debt units bought on or after 1 Apr 2023 are short term however long they are held (Sec 50AA)
  if (c === 'debt' && (!boughtOn || String(boughtOn).slice(0, 10) >= '2023-04-01')) return 'short';
  return days > (c === 'equity' ? 365 : 730) ? 'long' : 'short';
}

// ---------- report builders ----------

const BUILDERS: Record<string, (user: User, q: ReportQuery) => Promise<Report>> = {
  async 'capital-gains'(user, q) {
    const p = fyOf(q);
    const rep = { title: 'Capital gains statement', period: p.label, fy: p.picker };
    const mfia = user.data.fp?.mfia;
    const lots = mfia ? table((await fp.post('/v2/transactions/reports/capital_gains', {
      mf_investment_account: mfia, traded_on_from: p.from, traded_on_to: p.to,
    }, { label: 'capital gains report' })).data) : [];
    let st = 0, lt = 0, sale = 0;
    const rows = lots.map((l) => {
      const units = Number(l.units || 0);
      // FP's `amount` is the real sale value; units x traded_at is off because traded_at is rounded to 2 dp
      const value = l.amount != null ? Number(l.amount) : units * Number(l.traded_at || 0);
      const gain = Number(l.source_actual_gain ?? value - units * Number(l.source_purchased_at || 0));
      const cost = value - gain;
      const t = term(l.isin, Number(l.source_days_held || 0), l.source_purchased_on);
      if (t === 'long') lt += gain; else st += gain;
      sale += value;
      const kind = l.type === 'switch_out' ? 'Switch out' : 'Redemption';
      return {
        title: fundName(l.isin, l.scheme_name),
        sub: `${kind} · ${day(l.traded_on)} · ${u3(units)} u · held ${l.source_days_held} d`,
        value: rs(gain), value_sub: t === 'long' ? 'Long term' : 'Short term', tone: tone(gain),
        cells: [day(l.traded_on), fundName(l.isin, l.scheme_name), kind, u3(units), day(l.source_purchased_on),
          nav4(l.source_purchased_at), nav4(l.traded_at), rs(cost), rs(value), rs(gain), t === 'long' ? 'LT' : 'ST'],
      };
    });
    return {
      ...rep,
      summary: [
        { label: 'Short-term gains', value: rs(st), tone: tone(st) },
        { label: 'Long-term gains', value: rs(lt), tone: tone(lt) },
        { label: 'Total gains', value: rs(st + lt), tone: tone(st + lt) },
        { label: 'Sale value', value: rs(sale) },
      ],
      sections: [{
        title: 'Realised gains (FIFO lots)',
        columns: ['Sold on', 'Fund', 'Type', 'Units', 'Bought on', 'Buy NAV', 'Sell NAV', 'Cost', 'Sale value', 'Gain', 'Term'],
        rows,
      }],
      empty: rows.length ? null : `No redemptions or switches in ${p.label}, so there are no capital gains to report.`,
      notes: [
        'Gains are matched first-in, first-out against your purchases, as calculated by FintechPrimitives.',
        'Short/long-term is indicative: equity funds are long term after 12 months, debt funds bought after 1 Apr 2023 are always short term, and hybrid, fund-of-funds and other funds are long term after 24 months. Hybrid funds are treated as non-equity here; the actual treatment depends on the fund\'s equity allocation.',
        'This statement is not tax advice. Please consult your tax adviser before filing.',
      ],
    };
  },

  async holdings(user) {
    const pf = await portfolio(user);
    const s = pf.summary;
    const asOn = pf.holdings.map((h) => h.nav_date).filter(Boolean).sort().pop();
    return {
      title: 'Holdings statement',
      period: asOn ? `As on ${day(asOn)}` : `As on ${day(todayIst())}`,
      summary: [
        { label: 'Invested', value: rs(s.invested) },
        { label: 'Current value', value: rs(s.current) },
        { label: 'Total gain', value: s.gain_pct != null && isFinite(s.gain_pct) ? `${rs(s.gain)} (${Number(s.gain_pct).toFixed(2)}%)` : rs(s.gain), tone: tone(s.gain) },
        { label: 'XIRR', value: s.xirr != null ? `${Number(s.xirr).toFixed(2)}%` : '-' },
      ],
      sections: [{
        title: 'Holdings by folio',
        columns: ['Fund', 'Folio', 'Units', 'Avg NAV', 'NAV', 'Invested', 'Current value', 'Gain'],
        rows: pf.holdings.map((h) => ({
          title: h.fund.short_name,
          sub: `Folio ${h.folio} · ${u3(h.units)} u · NAV ${nav4(h.nav)}`,
          value: rs(h.current), value_sub: `${h.gain >= 0 ? '+' : ''}${rs(h.gain)}`, tone: tone(h.gain),
          cells: [h.fund.short_name, h.folio, u3(h.units), nav4(h.avg_nav), nav4(h.nav), rs(h.invested), rs(h.current), rs(h.gain)],
        })),
      }],
      empty: pf.holdings.length ? null : 'You don\'t hold any mutual fund units yet.',
      notes: ['Units and values are from the FintechPrimitives holdings report, valued at the latest NAV.'],
    };
  },

  async dividends(user, q) {
    const p = fyOf(q);
    const folios = foliosFor(await ordersRepo.forUser(user.id));
    const txns = folios.length ? (await fp.get(
      `/transactions?folios=${folios.join(',')}&types=dividend_payout,dividend_reinvestment&${txnRange(p)}`,
      { label: 'dividend transactions' },
    )).data || [] : [];
    let paid = 0, reinv = 0;
    const rows = txns.map((t: FpObject) => {
      const amt = Number(t.amount || 0);
      const re = t.type === 'dividend_reinvestment';
      if (re) reinv += amt; else paid += amt;
      const kind = re ? 'Reinvested' : 'Paid out';
      return {
        title: fundName(t.isin, t.rta_scheme_name), sub: `${kind} · ${day(t.traded_on)} · folio ${t.folio_number}`,
        value: rs(amt), value_sub: re ? `${u3(t.units)} u` : undefined, tone: 'up',
        cells: [day(t.traded_on), fundName(t.isin, t.rta_scheme_name), t.folio_number, kind, re ? u3(t.units) : '-', rs(amt)],
      };
    });
    return {
      title: 'Dividend report', period: p.label, fy: p.picker,
      summary: [
        { label: 'Paid to bank', value: rs(paid) },
        { label: 'Reinvested', value: rs(reinv) },
        { label: 'Total dividends', value: rs(paid + reinv) },
      ],
      sections: [{ title: 'IDCW (dividend) credits', columns: ['Date', 'Fund', 'Folio', 'Type', 'Units', 'Amount'], rows }],
      empty: rows.length ? null : `No dividends were declared on your holdings in ${p.label}. Growth-option funds do not pay dividends.`,
      notes: ['Dividends (IDCW) are taxable at your slab rate. Fund houses deduct TDS above ₹5,000 a year per fund house.'],
    };
  },

  async elss(user, q) {
    const p = fyOf(q);
    const all = await ordersRepo.forUser(user.id);
    const elss = new Set(all.flatMap((o) => [o.isin, o.isin_to]).filter((i) => i && scheme(i)?.sub_category === 'ELSS'));
    const folios = foliosFor(all);
    const txns = elss.size && folios.length ? ((await fp.get(
      `/transactions?folios=${folios.join(',')}&types=purchase,switch_in&${txnRange(p)}`, { label: 'ELSS transactions' },
    )).data || []).filter((t: FpObject) => elss.has(t.isin)) : [];
    const total = txns.reduce((a: number, t: FpObject) => a + Number(t.amount || 0), 0);
    const unlock = (d: string) => { const [y, m, dd] = d.split('-'); return `${Number(y) + 3}-${m}-${dd}`; };
    return {
      title: 'ELSS statement', period: p.label, fy: p.picker,
      summary: [
        { label: `Invested in ${p.label}`, value: rs(total) },
        { label: 'Eligible under 80C', value: rs(Math.min(total, 150000)) },
      ],
      sections: [{
        title: 'ELSS investments',
        columns: ['Date', 'Fund', 'Folio', 'Units', 'NAV', 'Amount', 'Lock-in until'],
        rows: txns.map((t: FpObject) => ({
          title: fundName(t.isin, t.rta_scheme_name), sub: `${day(t.traded_on)} · folio ${t.folio_number} · ${u3(t.units)} u`,
          value: rs(Number(t.amount)), value_sub: `Locked till ${day(unlock(t.traded_on))}`,
          cells: [day(t.traded_on), fundName(t.isin, t.rta_scheme_name), t.folio_number, u3(t.units), nav4(t.traded_at), rs(Number(t.amount)), day(unlock(t.traded_on))],
        })),
      }],
      empty: txns.length ? null : `No ELSS (tax-saver) investments in ${p.label}.`,
      notes: [
        'ELSS investments qualify for deduction under Section 80C of the Income Tax Act, up to ₹1,50,000 a year, under the old tax regime only.',
        'Each purchase is locked in for 3 years from its allotment date.',
      ],
    };
  },

  async orders(user, q) {
    const p = fyOf(q);
    const list: OrderLine[] = [];
    for (const o of await ordersRepo.forUser(user.id)) {
      if (o.kind === 'sip') {
        for (const i of o.data.installments || []) {
          if (!inFy(i.traded_on || i.scheduled_on, p)) continue;
          list.push({ date: i.traded_on || i.scheduled_on!, ref: i.old_id ? `#MF${String(i.old_id).padStart(6, '0')}` : i.id, kind: 'SIP instalment', fund: fundName(o.isin), amount: i.amount, units: i.units, state: i.state });
        }
        continue;
      }
      if (o.kind === 'stp') {
        for (const i of o.data.installments || []) {
          if (!inFy(i.traded_on || i.scheduled_on, p)) continue;
          list.push({ date: i.traded_on || i.scheduled_on!, ref: i.old_id ? `#MF${String(i.old_id).padStart(6, '0')}` : i.id, kind: 'STP transfer', fund: `${fundName(o.isin)} → ${fundName(o.isin_to)}`, amount: i.amount, units: i.units_out, state: i.state });
        }
        continue;
      }
      if (o.kind === 'swp') {
        for (const i of o.data.installments || []) {
          if (!inFy(i.traded_on || i.scheduled_on, p)) continue;
          list.push({ date: i.traded_on || i.scheduled_on!, ref: i.old_id ? `#MF${String(i.old_id).padStart(6, '0')}` : i.id, kind: 'SWP withdrawal', fund: fundName(o.isin), amount: i.amount, units: i.units, state: i.state });
        }
        continue;
      }
      if (!inFy(o.created_at, p)) continue;
      const v = view(o);
      list.push({ date: o.created_at, ref: v.ref, kind: { purchase: 'Purchase', redemption: 'Redemption', switch: 'Switch' }[o.kind as 'purchase'], fund: v.fund.short_name + (v.fund_to ? ` → ${v.fund_to.short_name}` : ''), amount: v.amount, units: v.units, state: o.state });
    }
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const ok = list.filter((x) => x.state === 'successful');
    const sumKind = (k: string[]) => ok.filter((x) => k.includes(x.kind)).reduce((a, x) => a + Number(x.amount || 0), 0);
    const label = (s: string) => ({ successful: 'Successful', failed: 'Failed', cancelled: 'Cancelled', reversed: 'Reversed', pending: 'Awaiting payment', submitted: 'Submitted', under_review: 'Processing', confirmed: 'Processing' }[s as 'successful'] || s);
    return {
      title: 'Order history', period: p.label, fy: p.picker,
      summary: [
        { label: 'Orders placed', value: String(list.length) },
        { label: 'Invested', value: rs(sumKind(['Purchase', 'SIP instalment'])) },
        { label: 'Redeemed', value: rs(sumKind(['Redemption', 'SWP withdrawal'])) },
      ],
      sections: [{
        title: 'Orders',
        columns: ['Date', 'Order', 'Type', 'Fund', 'Amount', 'Units', 'Status'],
        rows: list.map((x) => ({
          title: x.fund, sub: `${x.kind} · ${day(x.date)} · ${x.ref}`,
          value: x.amount != null ? rs(Number(x.amount)) : 'All units', value_sub: label(x.state),
          tone: x.state === 'successful' ? 'up' : ['failed', 'cancelled', 'reversed'].includes(x.state) ? 'down' : undefined,
          cells: [day(x.date), x.ref, x.kind, x.fund, x.amount != null ? rs(Number(x.amount)) : 'All units', u3(x.units), label(x.state)],
        })),
      }],
      empty: list.length ? null : `No orders in ${p.label}.`,
      notes: ['Includes every order placed through Risips, including failed and cancelled ones.'],
    };
  },

  async balance(_user, q) {
    const p = fyOf(q);
    return {
      title: 'Risips balance statement', period: p.label, fy: p.picker,
      summary: [{ label: 'Opening balance', value: rs(0) }, { label: 'Closing balance', value: rs(0) }],
      sections: [{ title: 'Entries', columns: ['Date', 'Description', 'Credit', 'Debit', 'Balance'], rows: [] }],
      empty: `No balance entries in ${p.label}. Redemption proceeds are paid straight to your bank account, so your Risips balance stays at ₹0.`,
      notes: [],
    };
  },

  async gst(_user, q) {
    const p = fyOf(q);
    return {
      title: 'GST invoices', period: p.label, fy: p.picker,
      summary: [],
      sections: [{ title: 'Invoices', columns: ['Date', 'Invoice no.', 'Description', 'Amount', 'GST'], rows: [] }],
      empty: `No GST invoices for ${p.label}. Risips hasn't charged you any fees, so there is nothing to invoice.`,
      notes: [],
    };
  },

  async 'contract-notes'(user, q) {
    const p = fyOf(q);
    const list: NoteLine[] = [];
    for (const o of await ordersRepo.forUser(user.id)) {
      if (o.kind === 'sip') {
        for (const i of o.data.installments || []) {
          if (i.state === 'successful' && inFy(i.traded_on || i.scheduled_on, p)) list.push({ id: i.id, date: i.traded_on || i.scheduled_on!, kind: 'SIP instalment', fund: fundName(o.isin), amount: i.amount, ref: i.old_id ? `#MF${String(i.old_id).padStart(6, '0')}` : i.id });
        }
      } else if (o.kind === 'swp') {
        for (const i of o.data.installments || []) {
          if (i.state === 'successful' && inFy(i.traded_on || i.scheduled_on, p)) list.push({ id: i.id, date: i.traded_on || i.scheduled_on!, kind: 'SWP withdrawal', fund: fundName(o.isin), amount: i.amount, ref: i.old_id ? `#MF${String(i.old_id).padStart(6, '0')}` : i.id });
        }
      } else if (o.state === 'successful' && inFy(o.created_at, p)) {
        const v = view(o);
        list.push({ id: o.id, date: o.created_at, kind: { purchase: 'Purchase', redemption: 'Redemption', switch: 'Switch' }[o.kind as 'purchase'], fund: v.fund.short_name, amount: v.amount, ref: v.ref });
      }
    }
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    return {
      title: 'Contract notes', period: p.label, fy: p.picker, summary: [],
      sections: [{
        title: 'Completed orders',
        columns: ['Date', 'Order', 'Type', 'Fund', 'Amount'],
        rows: list.map((x) => ({
          title: x.fund, sub: `${x.kind} · ${day(x.date)} · ${x.ref}`, value: x.amount != null ? rs(Number(x.amount)) : 'All units',
          link: { key: 'contract-note', id: x.id },
          cells: [day(x.date), x.ref, x.kind, x.fund, x.amount != null ? rs(Number(x.amount)) : 'All units'],
        })),
      }],
      empty: list.length ? null : `No completed orders in ${p.label}.`,
      notes: ['Tap an order to view and download its contract note.'],
    };
  },

  async 'contract-note'(user, q) {
    const id = String(q.id || '');
    const mine = await ordersRepo.forUser(user.id);
    const o = mine.find((x) => x.id === id);
    let kind = o?.kind;
    let isin = o?.isin;
    if (!o) {
      const plan = mine.find((x) => ['sip', 'swp'].includes(x.kind) && (x.data.installments || []).some((i) => i.id === id));
      if (!plan) throw new ApiError(404, 'Order not found');
      kind = plan.kind === 'sip' ? 'purchase' : 'redemption';
      isin = plan.isin;
    }
    if (!PATHS[kind!]) throw new ApiError(400, 'No contract note for this order.');
    const f = await fp.get(`${PATHS[kind!]}/${id}`, { label: 'contract note: order' });
    if (f.state !== 'successful') throw new ApiError(400, 'A contract note is available once the order is successful.');
    const ref = `#MF${String(f.old_id).padStart(6, '0')}`;
    const common = [
      { label: 'Order no.', value: ref },
      { label: 'Exchange / RTA order ref', value: f.order_reference || f.rta_order_reference || '-' },
      { label: 'Order placed', value: day(f.created_at) },
      { label: 'Trade date', value: day(f.traded_on) },
      { label: 'Folio', value: f.folio_number || '-' },
    ];
    let details: { label: string; value: unknown }[], row: string[];
    if (kind === 'purchase') {
      details = [...common,
        { label: 'Transaction', value: f.plan ? 'SIP instalment' : 'Purchase (lumpsum)' },
        { label: 'Scheme', value: scheme(isin)?.name || f.scheme },
        { label: 'Amount', value: rs(f.purchased_amount ?? f.amount) },
        { label: 'NAV', value: nav4(f.purchased_price) },
        { label: 'Units allotted', value: u3(f.allotted_units) }];
      row = [scheme(isin)?.name || f.scheme, 'Purchase', rs(f.purchased_amount ?? f.amount), nav4(f.purchased_price), u3(f.allotted_units)];
    } else if (kind === 'redemption') {
      details = [...common,
        { label: 'Transaction', value: 'Redemption' },
        { label: 'Scheme', value: scheme(isin)?.name || f.scheme },
        { label: 'Amount', value: rs(f.redeemed_amount ?? f.amount) },
        { label: 'NAV', value: nav4(f.redeemed_price) },
        { label: 'Units redeemed', value: u3(f.redeemed_units) }];
      row = [scheme(isin)?.name || f.scheme, 'Redemption', rs(f.redeemed_amount ?? f.amount), nav4(f.redeemed_price), u3(f.redeemed_units)];
    } else {
      details = [...common,
        { label: 'Transaction', value: 'Switch' },
        { label: 'Switch out of', value: scheme(f.switch_out_scheme)?.name || f.switch_out_scheme },
        { label: 'Switch into', value: scheme(f.switch_in_scheme)?.name || f.switch_in_scheme },
        { label: 'Amount', value: rs(f.switched_out_amount ?? f.amount) },
        { label: 'Units out / in', value: `${u3(f.switched_out_units)} / ${u3(f.switched_in_units)}` }];
      row = [scheme(f.switch_out_scheme)?.name || f.switch_out_scheme, 'Switch out', rs(f.switched_out_amount ?? f.amount), nav4(f.switched_out_price), u3(f.switched_out_units)];
    }
    if (f.euin) details.push({ label: 'EUIN', value: f.euin });
    return {
      title: 'Contract note', period: `${ref} · ${day(f.traded_on)}`, summary: [], details,
      sections: [{ title: 'Transaction', columns: ['Scheme', 'Type', 'Amount', 'NAV', 'Units'], rows: [{ title: row![0], sub: `${row![1]} · NAV ${row![3]}`, value: row![2], value_sub: `${row![4]} u`, cells: row! }] }],
      empty: null,
      notes: ['Generated by Risips from the order details held by FintechPrimitives. The fund house\'s allotment confirmation, sent by its registrar, is the authoritative record.'],
    };
  },
};

export const REPORT_KEYS = Object.keys(BUILDERS);

export async function buildReport(user: User, key: string, q: ReportQuery) {
  const fn = BUILDERS[key];
  if (!fn) throw new ApiError(404, 'Report not found');
  const u = publicUser(user);
  const rep = await fn(user, q);
  return {
    key, ...rep,
    investor: { name: u.name || u.email, pan: u.pan_masked },
    generated_at: new Date().toISOString(),
  };
}

// ---------- printable HTML ----------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&']));

export function reportHtml(rep: Awaited<ReturnType<typeof buildReport>>) {
  const toneCss = (t: Tone) => (t === 'up' ? ' class="up"' : t === 'down' ? ' class="down"' : '');
  const summary = rep.summary?.length ? `<div class="tiles">${rep.summary.map((s) => `<div class="tile"><div class="k">${esc(s.label)}</div><div${toneCss(s.tone)}><b>${esc(s.value)}</b></div></div>`).join('')}</div>` : '';
  const details = rep.details?.length ? `<table class="kv">${rep.details.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(d.value)}</td></tr>`).join('')}</table>` : '';
  const sections = (rep.sections || []).filter((s) => s.rows.length).map((s) => `
    <h3>${esc(s.title)}</h3>
    <div class="scroll"><table class="grid"><thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${s.rows.map((r) => `<tr>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('');
  const empty = rep.empty ? `<p class="empty">${esc(rep.empty)}</p>` : '';
  const notes = rep.notes?.length ? `<ul class="notes">${rep.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(rep.title)}</title><style>
  body{font-family:Helvetica,Arial,sans-serif;color:#111827;margin:32px;font-size:12px}
  .head{display:flex;justify-content:space-between;border-bottom:2px solid #0b5bd3;padding-bottom:12px;margin-bottom:18px}
  .brand{font-size:22px;font-weight:700;color:#0b5bd3}.muted{color:#6b7280}
  h1{font-size:18px;margin:0 0 4px}h3{font-size:13px;margin:22px 0 8px}
  .tiles{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.tile{border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;min-width:130px}
  .k{color:#6b7280;font-size:11px;margin-bottom:4px}.up{color:#047857}.down{color:#b91c1c}
  table{border-collapse:collapse;width:100%}.grid th{background:#f3f4f6;text-align:left;font-size:10.5px;padding:6px}
  .grid td{border-bottom:1px solid #e5e7eb;padding:6px;font-size:10.5px}
  .kv td{padding:6px 0;border-bottom:1px solid #f3f4f6}.kv td:first-child{color:#6b7280;width:40%}
  .empty{padding:18px;background:#f9fafb;border-radius:8px}.notes{color:#6b7280;font-size:10.5px;margin-top:22px;padding-left:16px}
  .scroll{overflow-x:auto}
  @media (max-width:600px){body{margin:16px}.grid td,.grid th{white-space:nowrap}.head{flex-direction:column;gap:10px}.head>div:last-child{text-align:left!important}}
  .foot{margin-top:28px;border-top:1px solid #e5e7eb;padding-top:10px;color:#9ca3af;font-size:10px}
</style></head><body>
  <div class="head"><div><div class="brand">Risips</div><div class="muted">Arthasuta Finedu Pvt Ltd · AMFI-registered mutual fund distributor</div></div>
  <div style="text-align:right"><div><b>${esc(rep.investor.name)}</b></div><div class="muted">PAN ${esc(rep.investor.pan || '-')}</div></div></div>
  <h1>${esc(rep.title)}</h1><div class="muted">${esc(rep.period || '')}</div>
  ${summary}${details}${sections}${empty}${notes}
  <div class="foot">Generated on ${esc(day(rep.generated_at))}${config.production ? '' : ' · Sandbox build: figures come from the FintechPrimitives sandbox and are not real investments.'}</div>
</body></html>`;
}
