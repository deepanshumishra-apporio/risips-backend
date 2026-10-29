// SIPs: plan create/confirm (single and cart batch), list, detail, cancel, pause / resume (FP skip instructions) and
// modify; the first-payment sweep. AutoPay mandates are in mandate.service.ts.
import crypto from 'node:crypto';
import { config } from '../config/env.ts';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { asModel, asModelOrNull, fp } from '../integrations/fp.client.ts';
import { CheckoutPayment, listOf, MfPurchase, MfPurchasePlan, NachPayment, Payment, SkipInstruction } from '../integrations/fp.schemas.ts';
import { poll } from '../utils/async.ts';
import { ApiError } from '../utils/errors.ts';
import { addMonths, istToday } from '../utils/format.ts';
import { scheme, summary } from './catalog.service.ts';
import { usableMandate } from './mandate.service.ts';
import { requireTxnOtp } from './otp.service.ts';
import { consentFor, folioForAmc, ownOrder, planFailText, requireInvestor } from './orders.service.ts';
import type { Ctx } from './orders.service.ts';
import type { PlanRule, Scheme } from '../types/catalog.ts';
import type { FirstPayment, Instalment, Mandate, Order, OrderData, Skip, User } from '../types/domain.ts';

/** What createPlan() registers: a validateSip() result plus how to start it. */
interface PlanInput {
  s: Scheme; rule: PlanRule; amount: number; day: number; mandate: Mandate; firstNow?: boolean; firstPay?: string;
  installments?: number | string; folio?: string | null; data?: OrderData;
}
export type ValidSip = Awaited<ReturnType<typeof validateSip>>;

/** The first instalment paid up front when the SIP was set up (UPI checkout, or a NACH debit on older builds), if any. */
const upfrontInstallment = (o: Order): Instalment | null => {
  const fpay = o.data.first_payment;
  const list = o.data.installments || [];
  if (!fpay || !list.length) return null;
  return list.find((i) => i.old_id === fpay.order_old_id) || list.reduce((a, b) => (b.old_id! < a.old_id! ? b : a));
};

const STATUS: Record<string, string> = {
  created: 'Setting up', under_review: 'Setting up', review_completed: 'Not started', confirmed: 'Activating', active: 'Active',
  cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed',
};

// ---------- Pause (FP skip instructions) ----------
// POST /v2/mf_purchase_plans/:id/skip_instructions {from, to} works on ONDC (verified 2026-09-25, although FP's docs say
// RTA only). FP's next_installment_date ignores skips, so the paused window and the resume date are worked out here.

const OPEN_SKIP = ['PENDING', 'ACTIVE'];
// A modified SIP's start skip (see /modify) keeps the new plan off months the old one would not have debited; it isn't a pause.
const openSkips = (o: Order) => (o.data.skips || []).filter((s) => OPEN_SKIP.includes(s.state) && s.id !== o.data.start_skip?.id);
const skipView = (s: SkipInstruction): Skip => ({ id: s.id, state: s.state ?? '', from: s.from_date ?? '', to: s.to_date ?? '', remaining: Number(s.remaining_installments ?? 0), skipped: Number(s.skipped_installments ?? 0) });

/** The live pause, if any: first/last skipped instalment and the date debits restart. */
function pauseOf(o: Order) {
  const f = o.data.fp || {};
  const open = openSkips(o).filter((s) => s.to).sort((a, b) => a.from.localeCompare(b.from));
  if (!open.length || !['active', 'confirmed'].includes(o.state)) return null;
  const last = open.at(-1)!;
  // skipped instalments = every instalment date between from and to (inclusive)
  const skipped: string[] = [];
  for (let d = open[0].from, i = 0; d <= last.to && i < 12; i++, d = addMonths(open[0].from, i, f.installment_day)) skipped.push(d);
  return { ids: open.map((s) => s.id), from: open[0].from, to: last.to, skipped, resumes_on: addMonths(last.to, 1, f.installment_day) };
}

export const planView = (o: Order) => {
  const f = o.data.fp || {};
  const list = o.data.installments || [];
  const up = upfrontInstallment(o);
  const pause = pauseOf(o);
  // The SIP only counts as started once its up-front first payment has gone through, whatever FP's plan state says:
  // failed -> never started (the plan is cancelled in refreshPlan); still submitted -> waiting for the investor to pay.
  const awaiting = !o.data.first_payment_failed && ['active', 'confirmed'].includes(o.state) && up && !['successful', 'failed', 'cancelled'].includes(up.state);
  // paid, units not allotted yet (a working day on production)
  const received = !!awaiting && o.data.first_payment?.status === 'SUCCESS';
  const state = o.data.first_payment_failed ? 'failed' : awaiting ? 'awaiting_payment' : o.state;
  // FP fills previous_installment_date as soon as the plan activates, even before (or without) a successful debit.
  const ok = list.filter((i) => i.state === 'successful');
  const lastOk = ok.map((i) => i.scheduled_on).filter(Boolean).sort().at(-1) || null;
  // What this SIP has bought so far, valued at the latest NAV (units come from the allotted instalments).
  const invested = ok.reduce((a, i) => a + Number(i.amount || 0), 0);
  const units = ok.reduce((a, i) => a + Number(i.units || 0), 0);
  const nav = scheme(o.isin)?.nav;
  const current = units && nav ? Math.round(units * nav * 100) / 100 : null;
  const next = f.next_installment_date;
  const ss = o.data.start_skip;
  const afterStart = ss && next && next >= ss.from && next <= ss.to ? addMonths(ss.to, 1, f.installment_day) : next;
  return {
    id: o.id, isin: o.isin, fund: summary(scheme(o.isin)), amount: o.amount, state,
    status: o.data.first_payment_failed ? 'Payment failed' : received ? 'Payment received' : awaiting ? 'Awaiting first payment' : pause ? 'Paused' : o.data.replaced_by && o.state === 'cancelled' ? 'Modified' : STATUS[o.state] || o.state,
    first_payment_failed: !!o.data.first_payment_failed,
    first_payment_received: received,
    frequency: f.frequency, installment_day: f.installment_day, start_date: f.start_date, next_installment_date: next,
    // what the next debit would be once any pause is lifted (the Resume sheet); a modified SIP's start skip stays
    next_after_resume: afterStart || null,
    // the next debit that will actually run (FP's next date ignores skip instructions)
    // a cancelled / completed / never-started plan keeps FP's next date, but nothing will be debited on it
    next_debit: !['active', 'confirmed'].includes(o.state) || o.data.first_payment_failed ? null
      : pause && afterStart && afterStart >= pause.from && afterStart <= pause.to ? pause.resumes_on : afterStart || null,
    previous_installment_date: lastOk, number_of_installments: f.number_of_installments,
    remaining_installments: f.remaining_installments, folio: f.folio_number, created_at: o.created_at,
    installments: list.map((i) => ({ ...i, upfront: i.id === up?.id })), mandate_id: f.payment_source,
    paid_count: ok.length, invested, units: units || null, current_value: current,
    gain_pct: current != null && invested ? Math.round(((current - invested) / invested) * 10000) / 100 : null,
    pause, replaced_by: o.data.replaced_by || null, replaces: o.data.replaces || null,
    cancellation_code: f.cancellation_code || o.data.cancellation_code || null,
  };
};

export async function refreshPlan(o: Order): Promise<Order> {
  const f = await fp.get(`/v2/mf_purchase_plans/${o.id}`, { label: 'refresh SIP plan', as: MfPurchasePlan });
  let installments = o.data.installments || [];
  try {
    const l = await fp.get(`/v2/mf_purchases?plan=${o.id}`, { label: 'SIP installments', as: listOf(MfPurchase) });
    installments = l.data.map((x): Instalment => ({ id: x.id, old_id: x.old_id, state: x.state, amount: x.amount, scheduled_on: x.scheduled_on, traded_on: x.traded_on || null, units: x.allotted_units, nav: x.purchased_price, folio: x.folio_number, failure_code: x.failure_code }));
  } catch {}
  let skips = o.data.skips || [];
  if (['active', 'confirmed'].includes(f.state) || openSkips(o).length) {
    const s = await fp.raw('GET', `/v2/mf_purchase_plans/${o.id}/skip_instructions`, undefined, { quiet: true });
    const list = s.status === 200 ? asModelOrNull(listOf(SkipInstruction), s.json, { label: 'SIP skip instructions' }) : null;
    if (list) skips = list.data.map(skipView);
  }
  let saved = await ordersRepo.upsert({ ...o, state: f.state, data: { fp: f, installments, skips } });
  // On production the paid first instalment is allotted a working day later: track the payment itself so the app
  // doesn't keep asking an investor who has paid to pay (as cart.service.ts does for cart SIPs).
  const pay = saved.data.first_payment;
  if (pay?.id && pay.status !== 'SUCCESS' && !['successful', 'failed'].includes(upfrontInstallment(saved)?.state ?? '')) {
    const x = await fp.raw('GET', `/api/pg/payments/${pay.id}`, undefined, { quiet: true }).catch(() => null);
    const p = x?.status === 200 ? asModelOrNull(Payment, x.json, { label: 'SIP first payment status' }) : null;
    if (p) saved = await ordersRepo.upsert({ ...saved, data: { first_payment: { ...pay, status: p.status } } });
  }
  // FP keeps the plan active when the up-front first payment fails, and would start debiting the mandate on the
  // next SIP date. The investor never started this SIP, so cancel it (retried on each refresh until FP accepts).
  if (upfrontInstallment(saved)?.state === 'failed') {
    saved = await ordersRepo.upsert({ ...saved, data: { first_payment_failed: true } });
    if (!['cancelled', 'completed', 'failed'].includes(f.state)) {
      try {
        const c = await fp.post('/v2/mf_purchase_plans/cancel', { id: o.id, cancellation_code: 'amount_not_available' }, { label: 'SIP: cancel (first payment failed)', as: MfPurchasePlan });
        saved = await ordersRepo.upsert({ ...saved, state: c.state, data: { fp: c } });
      } catch {}
    }
  }
  return saved;
}

/**
 * Background sweep: a SIP whose up-front first payment failed must be cancelled before its first mandate debit, even if
 * the investor never opens the app again (refreshPlan cancels it). Recent plans still waiting on that payment only.
 */
export async function sweepFirstPayments() {
  for (const id of await ordersRepo.recentRunningSipIds()) {
    const o = await ordersRepo.get(id);
    if (!o?.data.first_payment || o.data.first_payment_failed) continue;
    const up = upfrontInstallment(o);
    if (up && ['successful', 'failed'].includes(up.state)) continue; // already settled
    try { await refreshPlan(o); } catch {}
  }
}

/** Checks a SIP request against the scheme rules and the investor's AutoPay; returns what createPlan needs. */
export async function validateSip(user: User, { isin, amount, day, frequency = 'monthly' }: { isin: string | null; amount: number | string; day: number | string | null; frequency?: string }) {
  const s = scheme(isin);
  if (!s) throw new ApiError(404, 'Fund not found');
  const rule = s.sip.find((x) => x.frequency === frequency);
  if (!rule) throw new ApiError(400, `SIP is not available for ${summary(s).short_name} at this frequency.`);
  amount = Number(amount);
  if (!(amount >= rule.min)) throw new ApiError(400, `Minimum SIP for ${summary(s).short_name} is ₹${rule.min.toLocaleString('en-IN')}.`);
  if (rule.multiples > 1 && amount % rule.multiples) throw new ApiError(400, `SIP amount must be in multiples of ₹${rule.multiples}.`);
  day = Number(day);
  if (rule.dates?.length && !rule.dates.includes(day)) throw new ApiError(400, 'Choose a SIP date between 1 and 28.');
  return { s, rule, amount, day };
}

/**
 * Registers a monthly SIP with FP and confirms it: create -> review_completed -> consent + confirmed -> active.
 * firstNow: generate the first instalment today (the app then pays it on the ONDC UPI checkout; firstPay 'upi').
 * Returns { saved, token_url? }.
 */
export async function createPlan(ctx: Ctx, { s, rule, amount, day, mandate, firstNow, firstPay, installments, folio, data = {} }: PlanInput): Promise<{ saved: Order; token_url?: string }> {
  const ids = requireInvestor(ctx.user);
  // reuse this AMC's folio if we have one
  folio = folio || await folioForAmc(ctx.user.id, s.amc_id);
  let p = await fp.post('/v2/mf_purchase_plans', {
    mf_investment_account: ids.mfia, scheme: s.isin, frequency: rule.frequency, installment_day: day, amount,
    number_of_installments: Math.max(rule.installments_min || 6, Number(installments) || 120),
    systematic: true, payment_method: 'mandate', payment_source: String(mandate.id), gateway: 'ondc',
    generate_first_installment_now: !!firstNow, auto_generate_installments: true,
    initiated_by: 'investor', initiated_via: 'mobile_app', user_ip: ctx.ip,
    source_ref_id: `risips-sip-${ctx.user.id}-${crypto.randomBytes(4).toString('hex')}`,
    ...(folio ? { folio_number: folio } : {}),
  }, { label: 'SIP: create plan', as: MfPurchasePlan });
  const meta = { id: p.id, user_id: ctx.user.id, kind: 'sip' as const, isin: s.isin, amount };
  await ordersRepo.upsert({ ...meta, state: p.state, data: { fp: p, ...data } });
  p = await poll(() => fp.get(`/v2/mf_purchase_plans/${p.id}`, { quiet: true, as: MfPurchasePlan }), (x) => !['created', 'under_review'].includes(x.state), { every: 2000, max: 45000 });
  if (p.state !== 'review_completed') {
    await ordersRepo.upsert({ ...meta, state: p.state, data: { fp: p } });
    throw new ApiError(422, ['created', 'under_review'].includes(p.state)
      ? 'The fund house is taking longer than usual to review this SIP. Please check your SIPs in a few minutes.'
      : planFailText('SIP', p.reason));
  }
  p = await fp.patch('/v2/mf_purchase_plans', { id: p.id, state: 'confirmed', consent: consentFor(ctx.user) }, { label: 'SIP: consent + confirm', as: MfPurchasePlan });
  p = await poll(() => fp.get(`/v2/mf_purchase_plans/${p.id}`, { quiet: true, as: MfPurchasePlan }), (x) => x.state !== 'confirmed', { every: 2000, max: 30000 });
  let saved = await ordersRepo.upsert({ ...meta, state: p.state, data: { fp: p } });
  if (!['active', 'confirmed'].includes(p.state)) throw new ApiError(422, planFailText('SIP', p.reason));
  saved = await refreshPlan(saved).catch(() => saved);
  // A first installment generated now needs its payment created explicitly (FP does not auto-create it).
  // FP's sample flow pays it through the ONDC UPI checkout (settles in seconds); older app builds that don't
  // send first_pay=upi keep the NACH debit on the mandate (runs in hourly batches).
  const first = saved.data.installments?.[0];
  if (first && firstNow) {
    await poll(() => fp.get(`/v2/mf_purchases/${first.id}`, { quiet: true, as: MfPurchase }), (x) => x.state !== 'under_review', { every: 2000, max: 30000 });
    if (firstPay === 'upi') {
      const pay = await fp.post('/api/pg/payments/netbanking', {
        amc_order_ids: [first.old_id], method: 'UPI', provider_name: 'ONDC', bank_account_id: ids.bank_old_id,
        payment_postback_url: `${config.publicUrl}/pay/return?sip=${p.id}`,
      }, { label: 'SIP: first installment payment (UPI checkout)' });
      saved = await ordersRepo.upsert({ ...saved, data: { first_payment: { id: pay.id, method: 'UPI', order_old_id: first.old_id } } });
      return { saved, token_url: asModel(CheckoutPayment, pay, { label: 'SIP: first installment payment (UPI checkout)' }).token_url };
    }
    const pay = await fp.raw('POST', '/api/pg/payments/nach', { mandate_id: mandate.id, amc_order_ids: [first.old_id] }, { label: 'SIP: first installment debit' });
    // a refused debit has no id: keep FP's reason, so the sweep and the app see a first payment that went nowhere
    const debit = pay.status < 300 ? asModelOrNull(NachPayment, pay.json, { label: 'SIP: first installment debit' }) ?? (pay.json as FirstPayment) : null;
    saved = await ordersRepo.upsert({ ...saved, data: { first_payment: debit ?? { failed: String(pay.json?.error?.message || `HTTP ${pay.status}`) } } });
  }
  return { saved };
}

/**
 * Registers several SIPs (max 10) as one ONDC batch whose first instalments are paid on ONE UPI checkout:
 * POST /v2/mf_purchase_plans/batch -> review_completed -> PATCH .../batch {id, state: confirmed, consent} -> active ->
 * one payment for every first instalment. Verified 2026-09-29: two SIPs, one ₹1,500 checkout, both instalments
 * allotted ~10 s after paying. Lumpsums and SIP instalments can't share a payment (422), so the cart pays them apart.
 * `vs` are validateSip() results. Returns { saved: [plan per line, in order], token_url }.
 */
export async function createPlanBatch(ctx: Ctx, vs: ValidSip[], { mandate, data = {} }: { mandate: Mandate; data?: OrderData }) {
  const ids = requireInvestor(ctx.user);
  const folios: (string | null)[] = [];
  for (const { s } of vs) folios.push(await folioForAmc(ctx.user.id, s.amc_id));
  const created = await fp.post('/v2/mf_purchase_plans/batch', {
    mf_purchase_plans: vs.map(({ s, rule, amount, day }, i) => {
      const folio = folios[i];
      return {
        mf_investment_account: ids.mfia, scheme: s.isin, frequency: rule.frequency, installment_day: day, amount,
        number_of_installments: Math.max(rule.installments_min || 6, 120),
        systematic: true, payment_method: 'mandate', payment_source: String(mandate.id), gateway: 'ondc',
        generate_first_installment_now: true, auto_generate_installments: true,
        initiated_by: 'investor', initiated_via: 'mobile_app', user_ip: ctx.ip,
        source_ref_id: `risips-sip-${ctx.user.id}-${crypto.randomBytes(4).toString('hex')}`,
        ...(folio ? { folio_number: folio } : {}),
      };
    }),
  }, { label: 'cart: create batch SIPs', as: listOf(MfPurchasePlan) });
  let ps: MfPurchasePlan[] = created.data;
  const save = (p: MfPurchasePlan, i: number, extra: OrderData = {}) => ordersRepo.upsert({ id: p.id, user_id: ctx.user.id, kind: 'sip', isin: vs[i].s.isin, amount: vs[i].amount, state: p.state, data: { fp: p, ...data, ...extra } });
  await Promise.all(ps.map((p, i) => save(p, i)));
  const get = (p: MfPurchasePlan) => fp.get(`/v2/mf_purchase_plans/${p.id}`, { quiet: true, as: MfPurchasePlan });
  ps = await Promise.all(ps.map((p) => poll(() => get(p), (x) => !['created', 'under_review'].includes(x.state), { every: 2000, max: 45000 })));
  await Promise.all(ps.map((p, i) => save(p, i)));
  const bad = ps.find((p) => p.state !== 'review_completed');
  if (bad) {
    throw new ApiError(422, ['created', 'under_review'].includes(bad.state)
      ? 'The fund house is taking longer than usual to review these SIPs. Please check your SIPs in a few minutes.'
      : planFailText('SIP', bad.reason));
  }
  await fp.patch('/v2/mf_purchase_plans/batch', { mf_purchase_plans: ps.map((p) => ({ id: p.id, state: 'confirmed', consent: consentFor(ctx.user) })) }, { label: 'cart: batch SIP confirm' });
  ps = await Promise.all(ps.map((p) => poll(() => get(p), (x) => x.state !== 'confirmed', { every: 2000, max: 30000 })));
  let saved = await Promise.all(ps.map((p, i) => save(p, i)));
  // a half-started batch must not leave SIPs debiting AutoPay without their first payment
  const abandon = async () => {
    for (const p of ps.filter((x) => ['active', 'confirmed'].includes(x.state))) {
      await fp.post('/v2/mf_purchase_plans/cancel', { id: p.id, cancellation_code: 'amount_not_available' }, { label: 'cart: cancel batch SIP (batch failed)' }).catch(() => {});
    }
  };
  const off = ps.find((p) => !['active', 'confirmed'].includes(p.state));
  if (off) { await abandon(); throw new ApiError(422, planFailText('SIP', off.reason)); }
  saved = await Promise.all(saved.map((o) => refreshPlan(o).catch(() => o)));
  const firsts = saved.map((o) => o.data.installments?.[0]);
  if (firsts.some((x) => !x)) { await abandon(); throw new ApiError(502, 'The fund platform did not create the first instalments, so these SIPs were not started. Please try again in a few minutes.'); }
  await Promise.all(firsts.map((x) => poll(() => fp.get(`/v2/mf_purchases/${x!.id}`, { quiet: true, as: MfPurchase }), (y) => y.state !== 'under_review', { every: 2000, max: 30000 })));
  const pay = await fp.post('/api/pg/payments/netbanking', {
    amc_order_ids: firsts.map((x) => x!.old_id), method: 'UPI', provider_name: 'ONDC', bank_account_id: ids.bank_old_id,
    payment_postback_url: `${config.publicUrl}/pay/return?sip=${saved[0].id}`,
  }, { label: 'cart: batch SIP first installments payment (UPI checkout)' });
  saved = await Promise.all(saved.map((o, i) => ordersRepo.upsert({ ...o, data: { first_payment: { id: pay.id, method: 'UPI', order_old_id: firsts[i]!.old_id }, batch_payment: pay.id } })));
  return { saved, token_url: asModel(CheckoutPayment, pay, { label: 'cart: batch SIP first installments payment (UPI checkout)' }).token_url };
}


// ---------- entry points ----------

export async function startSip(ctx: Ctx, b: { isin: string; amount: number; day: number; frequency: string; first_now: boolean; first_pay?: string; installments?: number; otp?: string | null }) {
  requireInvestor(ctx.user);
  const v = await validateSip(ctx.user, { isin: b.isin, amount: b.amount, day: b.day, frequency: b.frequency });
  const mandate = await usableMandate(ctx.user, v.amount); // may answer need_mandate: the OTP is checked after, so it isn't spent
  const twofa = await requireTxnOtp(ctx.user, 'sip', b.otp);
  const { saved, token_url } = await createPlan(ctx, { ...v, mandate, firstNow: b.first_now, firstPay: b.first_pay, installments: b.installments, data: { twofa } });
  return { sip: planView(saved), ...(token_url ? { token_url, return_url_prefix: `${config.publicUrl}/pay/return` } : {}) };
}

export async function listSips(user: User) {
  const list = await ordersRepo.forUser(user.id, 'sip');
  // refresh every open plan, so statuses and totals on the SIPs tab are never stale
  const open = list.filter((x) => !['cancelled', 'completed', 'failed'].includes(x.state)).slice(0, 12);
  await Promise.all(open.map((o) => refreshPlan(o).catch(() => {})));
  return { sips: (await ordersRepo.forUser(user.id, 'sip')).map(planView) };
}

const ownSip = (user: User, id: string) => ownOrder(user, id, 'sip', 'SIP not found');

export async function getSip(user: User, id: string) {
  return { sip: planView(await refreshPlan(await ownSip(user, id))) };
}

export const CANCEL_CODES = ['amount_not_available', 'investment_returns_not_as_expected', 'amc_support_not_satisfactory', 'exit_load_not_as_expected',
  'switch_to_other_scheme', 'fund_manager_changed', 'investment_goal_complete', 'mandate_not_ready', 'invest_later', 'customer_support_not_satisfactory'];

async function cancelPlan(o: Order, code: string | undefined) {
  // FP: POST /v2/mf_purchase_plans/cancel {id, cancellation_code}; codes are a fixed, case-sensitive list.
  const c = await fp.post('/v2/mf_purchase_plans/cancel', { id: o.id, cancellation_code: code && CANCEL_CODES.includes(code) ? code : 'invest_later' }, { label: 'SIP: cancel', as: MfPurchasePlan });
  // Use the cancel response: an immediate re-read can still return the old state.
  return await ordersRepo.upsert({ ...o, state: c.state, data: { fp: c } });
}

export async function cancelSip(user: User, id: string, code: string | undefined, otp: string | null | undefined) {
  const o = await ownSip(user, id);
  if (['cancelled', 'completed', 'failed'].includes(o.state)) throw new ApiError(409, 'This SIP has already stopped.');
  const twofa = await requireTxnOtp(user, 'sip_cancel', otp);
  const c = await cancelPlan(o, code);
  return { sip: planView(await ordersRepo.upsert({ ...c, data: { cancel_twofa: twofa } })) };
}

// SEBI caps consecutive missed monthly instalments at 3, and FP only allows skips that stay 1 below that
// (installments_to_skip_exceeds_limit "remaining allowed (2)", verified 2026-09-25), so a pause is 1 or 2 months.
export const MAX_PAUSE_MONTHS = 2;

export async function pauseSip(user: User, id: string, months: number, otp: string | null | undefined) {
  let o = await refreshPlan(await ownSip(user, id));
  if (o.state !== 'active' || o.data.first_payment_failed) throw new ApiError(409, 'Only an active SIP can be paused.');
  if (pauseOf(o)) throw new ApiError(409, 'This SIP is already paused.');
  const f = o.data.fp!;
  if (!f.next_installment_date) throw new ApiError(409, 'This SIP has no upcoming instalment to pause.');
  // FP needs a skip instruction at least 2 calendar days before its first skipped instalment.
  const soonest = istToday(2);
  let from = f.next_installment_date;
  const ss = o.data.start_skip; // a modified SIP's first months are already skipped
  if (ss && from >= ss.from && from <= ss.to) from = addMonths(ss.to, 1, f.installment_day);
  while (from < soonest) from = addMonths(from, 1, f.installment_day);
  const to = addMonths(from, months - 1, f.installment_day);
  const twofa = await requireTxnOtp(user, 'sip_pause', otp);
  const r1 = await fp.raw('POST', `/v2/mf_purchase_plans/${o.id}/skip_instructions`, { from, to }, { label: 'SIP: pause (skip instruction)' });
  if (r1.status !== 200) {
    const e = r1.json?.error;
    if (e?.code === 'installments_to_skip_exceeds_limit') {
      const left = Number(String(e.message).match(/allowed \((\d+)\)/)?.[1]);
      throw new ApiError(400, left ? `SEBI rules allow skipping at most ${left} instalment${left > 1 ? 's' : ''} in a row for this SIP right now.` : 'SEBI rules don’t allow skipping this many instalments in a row.');
    }
    throw new ApiError(422, e?.message || 'The fund platform did not accept the pause. Please try again.');
  }
  const skip = asModel(SkipInstruction, r1.json, { label: 'SIP: pause (skip instruction)' });
  o = await ordersRepo.upsert({ ...o, data: { skips: [...(o.data.skips || []).filter((x) => x.id !== skip.id), skipView(skip)], paused_at: new Date().toISOString(), pause_twofa: twofa } });
  return { sip: planView(o) };
}

export async function resumeSip(user: User, id: string, otp: string | null | undefined) {
  let o = await refreshPlan(await ownSip(user, id));
  const open = openSkips(o);
  if (!open.length) throw new ApiError(409, 'This SIP is not paused.');
  const twofa = await requireTxnOtp(user, 'sip_resume', otp);
  for (const s of open) {
    const c = await fp.raw('POST', `/v2/mf_purchase_plans/skip_instructions/${s.id}/cancel`, {}, { label: 'SIP: resume (cancel skip instruction)' });
    if (c.status !== 200) throw new ApiError(422, c.json?.error?.message || 'The fund platform did not accept the resume. Please try again.');
  }
  // FP answers CANCELLATION_REQUESTED and flips to CANCELLED a moment later; either way no instalment is skipped any more.
  o = await ordersRepo.upsert({ ...o, data: { skips: (o.data.skips || []).map((x) => (open.some((s) => s.id === x.id) ? { ...x, state: 'CANCELLED' } : x)), resumed_at: new Date().toISOString(), resume_twofa: twofa } });
  return { sip: planView(o) };
}

/**
 * Modify = register a new plan with the new amount/date on the same folio and AutoPay, then cancel the old one.
 * FP only updates plans whose gateway is rta ("A plan can be updated only if plan gateway = rta"), and on RTA only
 * non-systematic ones. Nothing is charged today. The new plan starts in the month of the old plan's next instalment:
 * FP picks the earliest possible date and ONDC rejects requested_activation_date ("Unrecognized field", verified
 * 2026-09-25), so any earlier instalments get a skip instruction. Otherwise a SIP whose up-front payment just went
 * through (next debit in ~6 weeks) would be debited again within days.
 */
export async function modifySip(ctx: Ctx, id: string, b: { amount: number; day: number; otp?: string | null }) {
  let old = await refreshPlan(await ownSip(ctx.user, id));
  if (old.state !== 'active' || old.data.first_payment_failed) throw new ApiError(409, 'Only an active SIP can be changed.');
  if (pauseOf(old)) throw new ApiError(409, 'Resume this SIP before changing it.');
  const f = old.data.fp!;
  const v = await validateSip(ctx.user, { isin: old.isin, amount: b.amount, day: b.day, frequency: f.frequency || 'monthly' });
  if (v.amount === Number(old.amount) && v.day === Number(f.installment_day)) throw new ApiError(400, 'Change the amount or the SIP date first.');
  const mandate = await usableMandate(ctx.user, v.amount);
  const twofa = await requireTxnOtp(ctx.user, 'sip_modify', b.otp);
  const left = Number(f.remaining_installments);
  const { saved } = await createPlan(ctx, {
    ...v, mandate, firstNow: false, folio: f.folio_number, installments: left > 0 && left < 1000 ? left : 120,
    data: { replaces: old.id, twofa },
  });
  const oldNext = planView(old).next_debit; // skip-aware (the old plan may carry its own start skip)
  const startMonth = oldNext ? `${oldNext.slice(0, 7)}-01` : null;
  const nf = saved.data.fp || {};
  let fresh = saved;
  if (startMonth && nf.next_installment_date && nf.next_installment_date < startMonth) {
    const from = nf.next_installment_date;
    let to = from;
    while (addMonths(to, 1, nf.installment_day) < startMonth) to = addMonths(to, 1, nf.installment_day);
    const sk = from >= istToday(2)
      ? await fp.raw('POST', `/v2/mf_purchase_plans/${saved.id}/skip_instructions`, { from, to }, { label: 'SIP modify: start skip' })
      : { status: 0, json: { error: { message: 'the first new instalment is less than 2 days away' } } };
    if (sk.status !== 200) {
      // don't leave both plans running, or one that debits earlier than the old SIP would have: keep the old SIP
      await cancelPlan(saved, 'invest_later').catch(() => {});
      throw new ApiError(422, `We couldn't move this SIP to the new date without an extra debit (${sk.json?.error?.message || 'the fund house refused'}). Your current SIP is unchanged; try another date.`);
    }
    const skip = asModel(SkipInstruction, sk.json, { label: 'SIP modify: start skip' });
    fresh = await ordersRepo.upsert({ ...saved, data: { start_skip: { id: skip.id, from, to }, skips: [skipView(skip)] } });
  }
  // The new plan is live, so stop the old one. If FP refuses, say so: both plans would otherwise debit.
  try {
    old = await cancelPlan(old, 'invest_later');
    old = await ordersRepo.upsert({ ...old, data: { replaced_by: saved.id } });
  } catch {
    throw new ApiError(502, 'Your new SIP is registered, but the old one could not be cancelled. Please cancel it from your SIPs.', { sip: planView(fresh) });
  }
  return { sip: planView(fresh), old: planView(old) };
}
