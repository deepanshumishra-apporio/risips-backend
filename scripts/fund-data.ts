// Adds expense ratio, fund managers, objective and portfolio holdings to data/catalog.json. FP and AMFI's NAV feed
// have none of these, so they come from these free, public sources (checked 2026-09-25):
//   - TER: AMFI's daily Total Expense Ratio disclosure (regular + direct), the official source SEBI mandates.
//   - Fund managers + objective: Kuvera's public scheme JSON. Kuvera lists direct plans only; a direct plan has the same
//     portfolio and managers as its regular plan, so the regular ISIN is mapped to its direct twin via AMFI's NAVAll.
//   - Holdings, sectors, credit quality, AUM: each fund house's SEBI-mandated monthly portfolio disclosure.
//     ICICI Pru: one .xlsx per scheme in a zip under /blob/downloads/... (their file-list API only answers in a browser,
//     so recent month paths are tried). ABSL: one .xls with a sheet per scheme, found via their resource-list API.
// Run: node scripts/fund-data.ts   (TER changes daily, portfolios monthly, around the 10th.)
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { ROOT } from '../src/config/env.ts';
import type { FundPortfolio, Scheme } from '../src/types/catalog.ts';
import type { JsonObject } from '../src/types/domain.ts';

/** A download: `body` is text, parsed JSON or bytes, as asked for; missing when the server said no. */
 
interface Download { status: number; body?: any; url?: string }
/** One line of AMFI's NAVAll. */
interface NavRow { isin: string; isin2: string; name: string; plan: string; option: string }
/** One holding line of a portfolio sheet. */
interface SheetLine { name: string; isin: string; industry: string; kind: string; pct: number; mv: number | null }

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The loop returns, or rethrows on the third failure.
async function get(url: string, as?: 'text' | 'json' | 'buf', opts?: RequestInit): Promise<Download>;
async function get(url: string, as = 'text', opts: RequestInit = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, ...opts });
      if (!r.ok) return { status: r.status };
      return { status: r.status, body: as === 'json' ? await r.json() : as === 'buf' ? new Uint8Array(await r.arrayBuffer()) : await r.text(), url: r.url };
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}

/** "ICICI Prudential Large Cap Fund (erstwhile Bluechip Fund) - Regular Plan - Growth" -> "iciciprudentiallargecapfund" */
export const nameKey = (n: unknown): string => String(n).toLowerCase()
  .replace(/\(erstwhile[^)]*\)/g, '')
  .replace(/\s-\s.*$/, '') // plan/option suffix
  .replace(/\.xlsx?$/, '')
  .replace(/fund of funds?/g, 'fof')
  .replace(/[^a-z0-9]/g, '');

/** Like nameKey but keeps " - ..." parts: ICICI's four "Retirement Fund - <X> Plan" files differ only after the dash. */
export const fullKey = (n: unknown) => nameKey(String(n).replace(/\s-\s/g, ' '));

// Fund-house file names that differ from AMFI's scheme name.
const ALIASES: Record<string, string> = { iciciprudentialchildrensfund: 'iciciprudentialchildcarefundgiftplan' };

// ---------- AMFI NAVAll: base scheme name + direct-plan twin ----------
async function navAll() {
  const { body } = await get('https://portal.amfiindia.com/spages/NAVAll.txt');
  const rows: NavRow[] = [];
  for (const line of body.split('\n')) {
    const c = line.trim().split(';');
    if (c.length < 8 || !/^IN/.test(c[1])) continue;
    rows.push({ isin: c[1], isin2: c[2], name: c[3].replace(/\s*-\s*$/, '').trim(), plan: c[4], option: c[5] });
  }
  return rows;
}

// ---------- AMFI TER ----------
const TER_AMC: Record<number, number> = { 15: 20, 3: 3 }; // our amc_id -> AMFI MF_ID (ICICI Prudential 20, Aditya Birla Sun Life 3)
async function terFor(mfId: number): Promise<Record<string, JsonObject>> {
  const now = new Date();
  for (let back = 0; back < 3; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const month = `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    const last: Record<string, JsonObject> = {};
    for (let page = 1; ; page++) {
      const { body: j } = await get(`https://www.amfiindia.com/api/populate-te-rdata-revised?MF_ID=${mfId}&Month=${month}&strCat=-1&strType=-1&page=${page}&pageSize=100`, 'json');
      for (const r of j?.data || []) if (!last[nameKey(r.Scheme_Name)] || r.TER_Date > last[nameKey(r.Scheme_Name)].TER_Date) last[nameKey(r.Scheme_Name)] = r;
      if (!j?.meta || page >= j.meta.pageCount) break;
    }
    if (Object.keys(last).length) return last;
  }
  return {};
}

// ---------- Kuvera (managers, objective) ----------
async function kuvera(directIsin: string) {
  const r = await fetch(`https://mf.captnemo.in/kuvera/${directIsin}`, { headers: UA, redirect: 'manual' });
  const to = r.headers.get('location');
  if (!to) return null;
  const { body } = await get(to, 'json');
  const k = Array.isArray(body) ? body[0] : body;
  if (!k) return null;
  return {
    managers: String(k.fund_manager || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean),
    objective: k.investment_objective || null,
  };
}

// ---------- Portfolio sheets ----------
/** Indian ISINs encode the security: INF = mutual fund units, IN0/IN1/IN2/IN3 = government securities, and for
 *  company ISINs (INE...) characters 8-9 are the type: 01 equity shares, 10/20 partly-paid/rights; the rest
 *  (07 debentures, 14 commercial paper, 16 certificates of deposit, ...) are debt. */
export function kindOf(isin: string) {
  if (/^INF/.test(isin)) return 'fund';
  if (/^IN\d/.test(isin)) return 'debt';
  return ['01', '10', '20'].includes(isin.slice(7, 9)) ? 'equity' : 'debt';
}

/** One scheme's sheet -> holdings. Both fund houses use a header row naming ISIN, Industry/Rating and "% to NAV/AUM". */
export function parseSheet(ws: XLSX.WorkSheet): SheetLine[] | null {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  let h = -1;
  let col = {} as { isin: number; pct: number; name: number; industry: number; mv: number };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i].map((c) => String(c ?? '').toLowerCase());
    const isin = r.findIndex((c) => c.trim() === 'isin');
    const pct = r.findIndex((c) => /% to (nav|aum|net assets)/.test(c));
    if (isin >= 0 && pct >= 0) {
      h = i;
      col = { isin, pct, name: r.findIndex((c) => /name of the instrument|company\/issuer|instrument/.test(c)), industry: r.findIndex((c) => /industry|rating/.test(c)), mv: r.findIndex((c) => /market value/.test(c)) };
      if (col.name < 0) col.name = isin - 1;
      break;
    }
  }
  if (h < 0) return null;
  const out: SheetLine[] = [];
  for (const r of rows.slice(h + 1)) {
    const isin = String(r[col.isin] ?? '').trim();
    const pct = Number(r[col.pct]);
    if (!/^IN[A-Z0-9]{10}$/.test(isin) || !Number.isFinite(pct) || pct <= 0) continue;
    const industry = String(r[col.industry] ?? '').trim();
    const kind = kindOf(isin);
    out.push({ name: String(r[col.name] ?? '').trim().replace(/\s+/g, ' '), isin, industry, kind, pct: pct * 100, mv: Number(r[col.mv]) || null });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
function summarise(list: SheetLine[], asOf: string | null, source: string): FundPortfolio | null {
  if (!list?.length) return null;
  // Same issuer can appear on several lines (e.g. two bond series); merge by name so "top holdings" are companies.
  const by = new Map<string, { name: string; industry: string; kind: string; pct: number }>();
  for (const x of list) {
    const k = x.name.toLowerCase();
    const cur = by.get(k) || { name: x.name, industry: x.industry, kind: x.kind, pct: 0 };
    cur.pct += x.pct;
    by.set(k, cur);
  }
  const holdings = [...by.values()].sort((a, b) => b.pct - a.pct).map((x) => ({ ...x, pct: round2(x.pct) }));
  const group = (rows: SheetLine[]) => {
    const m = new Map<string, number>();
    for (const x of rows) m.set(x.industry || 'Others', (m.get(x.industry || 'Others') || 0) + x.pct);
    return [...m].map(([name, pct]) => ({ name, pct: round2(pct) })).sort((a, b) => b.pct - a.pct);
  };
  // AUM in ₹ crore: market value (₹ lakh) / share of net assets, median over lines to ignore rounding noise.
  const ratios = list.filter((x) => x.mv && x.pct > 0.5).map((x) => x.mv! / (x.pct / 100) / 100).sort((a, b) => a - b);
  const aum = ratios.length ? Math.round(ratios[Math.floor(ratios.length / 2)]) : null;
  const pctOf = (k: string) => round2(list.filter((x) => x.kind === k).reduce((a, x) => a + x.pct, 0));
  return {
    as_of: asOf, source, aum_cr: aum, count: holdings.length,
    mix: { equity: pctOf('equity'), debt: pctOf('debt'), funds: pctOf('fund') },
    holdings: holdings.slice(0, 200),
    sectors: group(list.filter((x) => x.kind === 'equity')),
    ratings: group(list.filter((x) => x.kind === 'debt')),
  };
}

/** ICICI Pru: latest monthly zip (one .xlsx per scheme, named after it). */
async function iciciPortfolios(): Promise<Record<string, FundPortfolio | null>> {
  const now = new Date();
  for (let back = 1; back <= 3; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const full = MONTHS[d.getMonth()];
    const y = d.getFullYear();
    for (const folder of new Set([full.slice(0, 3), full.slice(0, 4), full])) {
      const url = `https://www.icicipruamc.com/blob/downloads/Files/Monthly%20Portfolio%20Disclosures/${y}/${folder}/Monthly-Portfolio-Disclosure-${full}-${y}.zip`;
      const r = await get(url, 'buf');
      if (r.status !== 200 || r.body?.[0] !== 0x50) continue;
      const asOf = new Date(Date.UTC(y, d.getMonth() + 1, 0)).toISOString().slice(0, 10);
      const files = unzipSync(r.body);
      const out: Record<string, FundPortfolio | null> = {};
      for (const [name, data] of Object.entries(files)) {
        if (!/\.xlsx?$/i.test(name)) continue;
        const wb = XLSX.read(data, { type: 'array' });
        const list = parseSheet(wb.Sheets[wb.SheetNames[0]]);
        if (list) out[fullKey(path.basename(name))] = summarise(list, asOf, `ICICI Prudential MF monthly portfolio, ${full} ${y}`);
      }
      console.log('ICICI portfolio', full, y, Object.keys(out).length, 'schemes');
      return out;
    }
  }
  console.log('ICICI portfolio: no file found for the last 3 months');
  return {};
}

/** ABSL: resource-list API -> latest zip -> one .xls with an Index sheet (scheme name -> sheet code). */
async function abslPortfolios(): Promise<Record<string, FundPortfolio | null>> {
  const { body } = await get('https://mutualfund.adityabirlacapital.com/postlogin/CustomApi/Resources/FactsheetAccordionById?id=3ccab227-9de5-4494-b78d-2b4f7c0c054a&ctype=%2Fsitecore%2Fcontent%2FRoot%2FBSL%2FLibrary%2FLists%2FFAQ%2FCustomer%20Types%2FIndividual&month=%20&year=0', 'json');
  const item = body?.AccordionList?.find((a: JsonObject) => /\.zip$/i.test(a.pdfUrl || ''));
  if (!item) { console.log('ABSL portfolio: list API returned no zip'); return {}; }
  const m = item.ResourceLink.match(/as on (\w+) (\d+), (\d{4})/i);
  const asOf = m ? new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1]), +m[2])).toISOString().slice(0, 10) : null;
  // The API still hands out its old Azure CDN host (abcscprod.azureedge.net), which no longer resolves; the same path
  // is served by the main site.
  const r = await get(item.pdfUrl.replace(/^https?:\/\/[^/]+/, 'https://mutualfund.adityabirlacapital.com'), 'buf');
  const files = unzipSync(r.body);
  const out: Record<string, FundPortfolio | null> = {};
  for (const [name, data] of Object.entries(files)) {
    if (!/\.xlsx?$/i.test(name)) continue;
    const wb = XLSX.read(data, { type: 'array' });
    const index = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Index || wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
    for (const row of index) {
      const code = String(row[1] ?? '').trim();
      if (!code || !wb.Sheets[code]) continue;
      const list = parseSheet(wb.Sheets[code]);
      if (list) out[fullKey(row[2])] = summarise(list, asOf, `Aditya Birla Sun Life MF monthly portfolio, ${item.ResourceLink.replace(/^Monthly Portfolios as on /i, '')}`);
    }
  }
  console.log('ABSL portfolio', asOf, Object.keys(out).length, 'schemes');
  return out;
}

if (process.argv[1]?.endsWith('fund-data.ts')) {
  const file = path.join(ROOT, 'data', 'catalog.json');
  const cat: { schemes: Scheme[]; fund_data_at?: string } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nav = await navAll();
  const byIsin = new Map<string, NavRow>(nav.map((r) => [r.isin, r]));
  const ter: Record<string, JsonObject> = {};
  for (const id of new Set(cat.schemes.map((s) => TER_AMC[s.amc_id]).filter(Boolean))) Object.assign(ter, await terFor(id));
  console.log('AMFI TER', Object.keys(ter).length, 'schemes');
  const portfolios = { ...(await iciciPortfolios()), ...(await abslPortfolios()) };
  const today = new Date().toISOString().slice(0, 10);
  for (const s of cat.schemes) {
    const n = byIsin.get(s.isin);
    const key = nameKey(n?.name || s.name);
    const find = <T,>(map: Record<string, T>) => map[key] || map[ALIASES[key]] || null;
    const t = find(ter);
    s.ter = t ? { regular: Number(t.R_TER), direct: Number(t.D_TER), date: t.TER_Date.slice(0, 10), source: 'AMFI TER disclosure' } : null;
    // "Money Market Fund - Cash Option" (regular) vs "Money Market Fund" (direct): compare base names
    const direct = n && nav.find((r) => nameKey(r.name) === key && /direct/i.test(r.plan) && r.option.toLowerCase() === n.option.toLowerCase());
    const k = direct ? await kuvera(direct.isin).catch(() => null) : null;
    s.people = k?.managers?.length ? { managers: k.managers, objective: k.objective, as_of: today, source: 'Kuvera public scheme data (direct plan)' } : null;
    const fk = fullKey(n?.name || s.name);
    s.portfolio = portfolios[fk] || find(portfolios); // full name first (Retirement Fund plans), then base name ("- Cash Option")
    console.log(s.isin, (n?.name || s.name).slice(0, 48).padEnd(48), 'TER', s.ter?.regular ?? '-', '| mgrs', s.people?.managers.length ?? '-', '| holdings', s.portfolio?.count ?? '-', s.portfolio?.aum_cr ? `| AUM ₹${s.portfolio.aum_cr} Cr` : '');
  }
  cat.fund_data_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(cat));
}
