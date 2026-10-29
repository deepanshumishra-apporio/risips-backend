// SWP (systematic withdrawal plans = FP redemption plans): register to `active` on ONDC, list, detail, cancel.
// The Figma has no SWP frames; the screens follow "STP - Confirm" / "STP - Success", with the payout bank in place of
// the target fund.
import crypto from 'node:crypto';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { asModel, fp } from '../integrations/fp.client.ts';
import { HoldingsReport, listOf, MfRedemption, MfRedemptionPlan, SkipInstruction } from '../integrations/fp.schemas.ts';
import { poll } from '../utils/async.ts';
import { ApiError } from '../utils/errors.ts';
import { istToday } from '../utils/format.ts';
import { scheme, summary } from './catalog.service.ts';
import { requireTxnOtp, sendTxnOtp } from './otp.service.ts';
import { consentFor, freeValue, ownOrder, planFailText, requireInvestor } from './orders.service.ts';
import { STATUS } from './stp.service.ts';
import type { Ctx } from './orders.service.ts';
import type { Instalment, Order, User } from '../types/domain.ts';

export const planView = (o: Order) => {
  const f = o.data.fp || {};
  return {
    id: o.id, isin: o.isin, fund: summary(scheme(o.isin)), amount: o.amount, state: o.state, status: STATUS[o.state] || o.state,
    frequency: f.frequency, installment_day: f.installment_day, start_date: f.start_date,
    next_installment_date: f.next_installment_date, previous_installment_date: f.previous_installment_date,
    number_of_installments: f.number_of_installments, remaining_installments: f.remaining_installments,
    folio: f.folio_number, created_at: o.created_at, reason: f.reason || null, installments: o.data.installments || [],
    until_stopped: !!o.data.until_stopped,
    // withdrawals the investor asked for (a later start month adds skipped ones to FP's count)
    withdrawals: o.data.until_stopped ? null : f.number_of_installments != null ? f.number_of_installments - (o.data.start_offset || 0) : null,
    first_withdrawal: firstWithdrawal(o),
    // FP's next date ignores the start-month skip: before the first real withdrawal, that one is next
    next_withdrawal: f.next_installment_date && firstWithdrawal(o)! > f.next_installment_date ? firstWithdrawal(o) : f.next_installment_date || null,
  };
};

/** The first withdrawal that actually pays out: FP's start date, moved on by the skipped start months. */
function firstWithdrawal(o: Order): string | null {
  const f = o.data.fp || {};
  const start = f.start_date || f.next_installment_date;
  const n = o.data.start_offset || 0;
  if (!start || !n) return start || null;
  const [y, m, d] = start.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}

export async function refreshPlan(o: Order): Promise<Order> {
  const f = await fp.get(`/v2/mf_redemption_plans/${o.id}`, { label: 'refresh SWP', as: MfRedemptionPlan });
  let installments = o.data.installments || [];
  try {
    const l = await fp.get(`/v2/mf_redemptions?plan=${o.id}`, { label: 'SWP installments', as: listOf(MfRedemption) });
    installments = l.data.map((x): Instalment => ({
      id: x.id, old_id: x.old_id, state: x.state, amount: x.redeemed_amount ?? x.amount, scheduled_on: x.scheduled_on, traded_on: x.traded_on || null,
      units: x.redeemed_units ?? x.units, nav: x.redeemed_price ?? null, failure_code: x.failure_code,
    }));
  } catch {}
  return await ordersRepo.upsert({ ...o, state: f.state, data: { fp: f, installments } });
}


// ---------- entry points ----------

/** Figma "Start SWP - OTP Sheet". Kept for app builds from before the shared POST /txn/otp. */
export async function sendSwpOtp(user: User) {
  requireInvestor(user);
  return await sendTxnOtp(user, 'swp');
}

// "I stop it" on the Figma = a plan that runs until the investor cancels it; FP needs a count, and accepts 1200
// monthly withdrawals (verified 2026-09-25). FP also stops a plan once the units run out.
const UNTIL_STOPPED = 1200;

export async function startSwp(ctx: Ctx, b: { isin: string; folio: string; amount: number; day: number; until?: 'stopped'; installments?: number; start_offset: number; otp?: string | null }) {
  const ids = requireInvestor(ctx.user);
  const s = scheme(b.isin);
  if (!s) throw new ApiError(404, 'Fund not found');
  // FP answers `frequency "not allowed"` for a scheme without monthly SWP data (Nifty50 Value 20 Growth).
  const rule = s.swp;
  if (!rule) throw new ApiError(400, `${summary(s).short_name} does not allow SWPs.`);
  const { folio } = b;
  const amount = Math.floor(b.amount);
  if (!(amount >= rule.min)) throw new ApiError(400, `Minimum withdrawal is ₹${rule.min.toLocaleString('en-IN')} a month.`);
  if (amount % (rule.multiples || 1)) throw new ApiError(400, `Amount must be in multiples of ₹${rule.multiples}.`);
  const untilStopped = b.until === 'stopped';
  // Figma "Starting from": FP has no activation date for redemption plans ("Unrecognized field
  // requested_activation_date"), so a later start month skips the first withdrawal(s) with a skip instruction.
  const offset = b.start_offset;
  const wanted = untilStopped ? UNTIL_STOPPED : Number(b.installments);
  if (!(wanted >= (rule.installments_min || 1))) throw new ApiError(400, `An SWP needs at least ${rule.installments_min} monthly withdrawals.`);
  // skipped withdrawals still count towards number_of_installments, so add them back
  const installments = untilStopped ? UNTIL_STOPPED : wanted + offset;
  const day = b.day;
  if (!rule.dates.includes(day)) throw new ApiError(400, 'Choose a withdrawal date between 1 and 28.');
  // A later start is a skip instruction on the first withdrawal, which FP needs at least 2 days ahead: refuse it
  // before registering a plan that would then have to be cancelled.
  if (offset) {
    const today = istToday();
    const [ty, tm, td] = today.split('-').map(Number);
    const first = new Date(Date.UTC(ty, tm - 1 + (day > td ? 0 : 1), day)).toISOString().slice(0, 10);
    if (first < istToday(2)) throw new ApiError(400, 'The first withdrawal date is too close to start later. Pick another date or start this month.');
  }
  // As with STP, ONDC's review does not check holdings (₹5,000/mo on a ₹986 holding reached review_completed), so we do.
  const rep = await fp.get(`/api/oms/reports/holdings?folios=${encodeURIComponent(folio)}`, { label: 'SWP: holding', as: HoldingsReport });
  const held = (rep.folios ?? []).flatMap((f) => f.schemes ?? []).find((x) => x.isin === s.isin);
  const value = await freeValue(ctx.user.id, folio, s.isin, Number(held?.market_value?.redeemable_amount ?? held?.market_value?.amount ?? 0));
  if (value < amount) throw new ApiError(400, `You hold ₹${Math.floor(value).toLocaleString('en-IN')} in this fund, less than one withdrawal.`);
  // OTP last, so a validation error above doesn't use up the code
  const twofa = await requireTxnOtp(ctx.user, 'swp', b.otp);

  const meta = { user_id: ctx.user.id, kind: 'swp' as const, isin: s.isin, amount };
  let p = await fp.post('/v2/mf_redemption_plans', {
    mf_investment_account: ids.mfia, folio_number: folio, scheme: s.isin, amount, frequency: 'monthly',
    installment_day: day, number_of_installments: installments, systematic: true, auto_generate_installments: true,
    initiated_by: 'investor', initiated_via: 'mobile_app', user_ip: ctx.ip,
    source_ref_id: `risips-swp-${ctx.user.id}-${crypto.randomBytes(4).toString('hex')}`,
  }, { label: 'SWP: create plan', as: MfRedemptionPlan });
  await ordersRepo.upsert({ id: p.id, ...meta, state: p.state, data: { fp: p, twofa } });
  p = await poll(() => fp.get(`/v2/mf_redemption_plans/${p.id}`, { quiet: true, as: MfRedemptionPlan }), (x) => x.state !== 'created', { every: 2000, max: 45000 });
  if (p.state !== 'review_completed') {
    await ordersRepo.upsert({ id: p.id, ...meta, state: p.state, data: { fp: p } });
    throw new ApiError(422, p.state === 'created'
      ? 'The fund house is taking longer than usual to review this SWP. Please check again in a few minutes.'
      : planFailText('SWP', p.reason));
  }
  // consent + confirmed in one call, as for SIP and STP plans (verified 2026-09-25: active within seconds)
  p = await fp.patch('/v2/mf_redemption_plans', { id: p.id, state: 'confirmed', consent: consentFor(ctx.user) }, { label: 'SWP: consent + confirm', as: MfRedemptionPlan });
  p = await poll(() => fp.get(`/v2/mf_redemption_plans/${p.id}`, { quiet: true, as: MfRedemptionPlan }), (x) => !['confirmed', 'submitted'].includes(x.state), { every: 2000, max: 30000 });
  let saved = await ordersRepo.upsert({ id: p.id, ...meta, state: p.state, data: { fp: p, until_stopped: untilStopped, start_offset: offset } });
  // Only active (or still activating) counts as started; anything else after confirm is a rejection.
  if (!['active', 'confirmed', 'submitted'].includes(p.state)) throw new ApiError(422, planFailText('SWP', p.reason));
  if (offset) {
    const first = p.start_date || p.next_installment_date;
    // an active plan always has a start date; without one there is nothing to skip from, so don't guess
    if (!first) {
      await fp.post(`/v2/mf_redemption_plans/${p.id}/cancel`, {}, { label: 'SWP: cancel (no start date for a later start)' }).catch(() => {});
      await ordersRepo.upsert({ ...saved, state: 'cancelled' });
      throw new ApiError(422, 'The fund house did not give this SWP a start date, so a later start could not be set. Please try again.');
    }
    const [y, m, d] = first.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1 + offset - 1, d)).toISOString().slice(0, 10);
    const sk = await fp.raw('POST', `/v2/mf_redemption_plans/${p.id}/skip_instructions`, { from: first, to: last }, { label: 'SWP: later start (skip instruction)' });
    if (sk.status !== 200) {
      // don't leave a plan that starts earlier than the investor chose
      await fp.post(`/v2/mf_redemption_plans/${p.id}/cancel`, {}, { label: 'SWP: cancel (later start refused)' }).catch(() => {});
      await ordersRepo.upsert({ ...saved, state: 'cancelled' });
      throw new ApiError(422, `The fund house did not accept a later start: ${sk.json?.error?.message || 'please pick the earliest month'}.`);
    }
    const skip = asModel(SkipInstruction, sk.json, { label: 'SWP: later start (skip instruction)' });
    saved = await ordersRepo.upsert({ ...saved, data: { skip: { id: skip.id, from: first, to: last } } });
  }
  return { swp: planView(saved) };
}

export async function listSwps(user: User) {
  const list = await ordersRepo.forUser(user.id, 'swp');
  const open = list.filter((x) => !['cancelled', 'completed', 'failed'].includes(x.state)).slice(0, 12);
  await Promise.all(open.map((o) => refreshPlan(o).catch(() => {})));
  return { swps: (await ordersRepo.forUser(user.id, 'swp')).map(planView) };
}

export async function getSwp(user: User, id: string) {
  return { swp: planView(await refreshPlan(await ownOrder(user, id, 'swp', 'SWP not found'))) };
}

export async function cancelSwp(user: User, id: string, otp: string | null | undefined) {
  const found = await ownOrder(user, id, 'swp', 'SWP not found');
  const o = await refreshPlan(found).catch(() => found); // the stored state can lag FP's
  if (['cancelled', 'completed', 'failed'].includes(o.state)) return { swp: planView(o) };
  // ONDC refuses to cancel a plan that was never confirmed ("Cancellation not allowed ... with ONDC gateway").
  if (!['active', 'confirmed', 'submitted'].includes(o.state)) throw new ApiError(400, 'This SWP never started, so there is nothing to cancel. No withdrawals will run on it.');
  await ordersRepo.upsert({ ...o, data: { cancel_twofa: await requireTxnOtp(user, 'swp_cancel', otp) } });
  // Cancels by path, like switch plans. The response and an immediate GET still say `active`; FP flips it ~1 s later.
  await fp.post(`/v2/mf_redemption_plans/${o.id}/cancel`, {}, { label: 'SWP: cancel' });
  await poll(() => fp.get(`/v2/mf_redemption_plans/${o.id}`, { quiet: true, as: MfRedemptionPlan }), (x) => x.state !== 'active', { every: 1500, max: 15000 }).catch(() => {});
  return { swp: planView(await refreshPlan(o)) };
}
