// Admin API data (routes/admin.routes.ts): read-only views of investors, orders and plans for the admin dashboard.
// Full PAN, bank account numbers, Aadhaar, selfie/signature files, payment links, 2FA records and session data never
// leave this server.
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { view, withEstimates } from './orders.service.ts';
import { portfolio } from './portfolio.service.ts';
import { planView as sipView } from './sip.service.ts';
import { planView as stpView } from './stp.service.ts';
import { planView as swpView } from './swp.service.ts';
import { kycCompliant, nextStep } from './user.service.ts';
import type { Order, OrderKind, User, UserData } from '../types/domain.ts';

const mask = (s: string | undefined | null, keep: number) => (s ? '*'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep) : null);

/** Where the investor is: an onboarding step (the app's next screen), 'active' once onboarded, or the deletion state. */
const stageOf = (d: UserData) => (d.deletion?.status === 'deleted' ? 'deleted'
  : d.deletion?.status === 'requested' ? 'deletion_requested'
    : d.onboarded_at ? 'active' : nextStep(d));

interface Counts { orders: number; plans: number }

function investorRow(u: User, counts: Partial<Counts> = {}) {
  const d = u.data || {};
  return {
    id: u.id,
    name: d.name || null,
    email: u.email,
    mobile: u.mobile,
    stage: stageOf(d),
    kyc_compliant: kycCompliant(d),
    pan_masked: mask(d.pan, 3),
    signed_up_at: u.created_at,
    onboarded_at: d.onboarded_at || null,
    orders: counts.orders || 0,
    plans: counts.plans || 0,
  };
}

function investorDetail(u: User) {
  const d = u.data || {};
  return {
    ...investorRow(u),
    dob: d.dob || null,
    gender: d.gender || null,
    occupation: d.occupation || null,
    income_slab: d.income_slab || null,
    marital_status: d.marital_status || null,
    father_name: d.father_name || null,
    address: d.address || null,
    aadhaar_masked: d.aadhaar_last4 ? `XXXX XXXX ${d.aadhaar_last4}` : null,
    bank: d.bank ? {
      account_masked: mask(d.bank.account_number, 4), ifsc: d.bank.ifsc || null, bank_name: d.bank.bank_name || null,
      branch: d.bank.branch || null, verified: !!d.bank.verified,
    } : null,
    nominee: d.nominee?.name ? { name: d.nominee.name, relationship: d.nominee.relationship || null } : null,
    nominee_opted_out: !!d.nominee_skipped,
    checks: {
      mobile_verified: !!d.mobile_verified, email_verified: !!d.email_verified, pan_verified: !!d.pan_verified,
      pan_readiness: d.pan_checks?.readiness?.status || null, aadhaar_verified: !!d.aadhaar_verified,
      selfie: !!d.selfie, signature: !!d.signature, fatca_declared: !!d.fatca_declared, nominee_consent: !!d.nominee_consent,
      esign_consent_at: d.esign_consent_at || null,
    },
    deletion: d.deletion ? { status: d.deletion.status, requested_at: d.deletion.requested_at || null } : null,
    fp: d.fp ? { investor_profile: d.fp.invp || null, investment_account: d.fp.mfia || null } : null,
  };
}

const PLAN_VIEWS: Partial<Record<OrderKind, (o: Order) => Record<string, unknown>>> = { sip: sipView, stp: stpView, swp: swpView };
const isPlan = (kind: OrderKind) => !!PLAN_VIEWS[kind];

/** One order or plan, as the app shows it, minus the payment link and 2FA details. */
function orderOut(o: Order) {
  const v: Record<string, unknown> = PLAN_VIEWS[o.kind]?.(o) ?? view(o);
  const { token_url: _link, ...rest } = v;
  return { ...rest, kind: o.kind, user_id: o.user_id, updated_at: o.updated_at };
}

async function countsByUser() {
  const m = new Map<number, Counts>();
  for (const row of await ordersRepo.countsByUserKind()) {
    const c = m.get(row.user_id) || { orders: 0, plans: 0 };
    if (isPlan(row.kind)) c.plans += row.n; else c.orders += row.n;
    m.set(row.user_id, c);
  }
  return m;
}

/** Totals for the dashboard home. */
export async function summary() {
  const stages: Record<string, number> = {};
  let kyc = 0;
  const all = await usersRepo.all();
  for (const u of all) {
    const s = stageOf(u.data);
    stages[s] = (stages[s] || 0) + 1;
    if (kycCompliant(u.data)) kyc++;
  }
  const byKind: Record<string, Record<string, { count: number; amount: number | null }>> = {};
  for (const row of await ordersRepo.totalsByKindState()) (byKind[row.kind] ||= {})[row.state] = { count: row.n, amount: row.amt };
  return {
    investors: { total: all.length, kyc_compliant: kyc, by_stage: stages },
    orders: byKind,
    generated_at: new Date().toISOString(),
  };
}

/** Investors. q matches name, email, mobile or id; stage is one of stageOf()'s values. */
export async function investors({ q, stage, limit, offset }: { q?: string; stage?: string; limit: number; offset: number }) {
  const counts = await countsByUser();
  let list = await usersRepo.all();
  if (stage) list = list.filter((u) => stageOf(u.data) === stage);
  if (q) list = list.filter((u) => [u.id, u.email, u.mobile, u.data.name].some((v) => v != null && String(v).toLowerCase().includes(q)));
  return { total: list.length, limit, offset, data: list.slice(offset, offset + limit).map((u) => investorRow(u, counts.get(u.id))) };
}

async function investorOr404(id: number) {
  const u = await usersRepo.byId(id);
  if (!u) throw new ApiError(404, 'No such investor.');
  return u;
}

export async function investor(id: number) {
  const u = await investorOr404(id);
  const all = await withEstimates(await ordersRepo.forUser(u.id));
  return {
    investor: investorDetail(u),
    orders: all.filter((o) => !isPlan(o.kind)).map(orderOut),
    sips: all.filter((o) => o.kind === 'sip').map(orderOut),
    stps: all.filter((o) => o.kind === 'stp').map(orderOut),
    swps: all.filter((o) => o.kind === 'swp').map(orderOut),
  };
}

/** Holdings and value, fetched live from FP (slower: the dashboard calls it only when the screen shows them). */
export async function investorPortfolio(id: number) {
  const u = await investorOr404(id);
  if (!u.data.fp?.mfia) return { holdings: [], note: 'Investor has no investment account yet.' };
  return portfolio(u);
}

/** Orders and plans across investors, newest first. from / to are the created date in UTC (YYYY-MM-DD). */
export async function orders(f: { kind?: string; state?: string; user_id?: number; from?: string; to?: string; limit: number; offset: number }) {
  const { limit, offset, ...filters } = f;
  const { total, rows } = await ordersRepo.search(filters, limit, offset);
  return { total, limit, offset, data: (await withEstimates(rows)).map(orderOut) };
}

export async function order(id: string) {
  const o = await ordersRepo.get(id);
  if (!o) throw new ApiError(404, 'No such order.');
  return orderOut((await withEstimates([o]))[0]);
}
