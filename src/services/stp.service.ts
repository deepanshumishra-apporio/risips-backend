// STP (systematic transfer plans = FP switch plans): register to `active` on ONDC, list, detail, cancel.
import crypto from 'node:crypto';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { fp } from '../integrations/fp.client.ts';
import { HoldingsReport, listOf, MfSwitch, MfSwitchPlan } from '../integrations/fp.schemas.ts';
import { poll } from '../utils/async.ts';
import { ApiError } from '../utils/errors.ts';
import { scheme, summary } from './catalog.service.ts';
import { requireTxnOtp } from './otp.service.ts';
import { consentFor, freeValue, ownOrder, planFailText, requireInvestor } from './orders.service.ts';
import type { Ctx } from './orders.service.ts';
import type { Instalment, Order, User } from '../types/domain.ts';

export const STATUS: Record<string, string> = {
  created: 'Setting up', review_completed: 'Not started', confirmed: 'Activating', submitted: 'Activating',
  active: 'Active', cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed',
};

export const planView = (o: Order) => {
  const f = o.data.fp || {};
  return {
    id: o.id, isin: o.isin, isin_to: o.isin_to, fund: summary(scheme(o.isin)), fund_to: summary(scheme(o.isin_to)),
    amount: o.amount, state: o.state, status: STATUS[o.state] || o.state, frequency: f.frequency,
    installment_day: f.installment_day, start_date: f.start_date, next_installment_date: f.next_installment_date,
    previous_installment_date: f.previous_installment_date, number_of_installments: f.number_of_installments,
    remaining_installments: f.remaining_installments, folio: f.folio_number, created_at: o.created_at,
    reason: f.reason || null, installments: o.data.installments || [],
  };
};

export async function refreshPlan(o: Order): Promise<Order> {
  const f = await fp.get(`/v2/mf_switch_plans/${o.id}`, { label: 'refresh STP', as: MfSwitchPlan });
  let installments = o.data.installments || [];
  try {
    const l = await fp.get(`/v2/mf_switches?plan=${o.id}`, { label: 'STP installments', as: listOf(MfSwitch) });
    installments = l.data.map((x): Instalment => ({
      id: x.id, old_id: x.old_id, state: x.state, amount: x.amount ?? x.switched_out_amount, scheduled_on: x.scheduled_on, traded_on: x.traded_on || null,
      units_out: x.switched_out_units, units_in: x.switched_in_units, failure_code: x.failure_code,
    }));
  } catch {}
  return await ordersRepo.upsert({ ...o, state: f.state, data: { fp: f, installments } });
}


// ---------- entry points ----------

export async function startStp(ctx: Ctx, b: { from_isin: string; to_isin: string; folio: string; amount: number; day: number; installments: number; otp?: string | null }) {
  const ids = requireInvestor(ctx.user);
  const from = scheme(b.from_isin);
  const to = scheme(b.to_isin);
  if (!from || !to) throw new ApiError(404, 'Fund not found');
  if (from.isin === to.isin) throw new ApiError(400, 'Choose a different fund to transfer into.');
  if (from.amc_id !== to.amc_id) throw new ApiError(400, 'An STP can only move money between funds of the same fund house.');
  // FP checks STP rules on both legs; a scheme without them fails with "frequency not supported".
  if (!from.stp?.out) throw new ApiError(400, `${summary(from).short_name} does not allow STPs out of it.`);
  if (!to.stp?.in) throw new ApiError(400, `${summary(to).short_name} does not accept STPs.`);
  const { folio } = b;
  const amount = Math.floor(b.amount);
  const min = Math.max(from.stp.min, to.stp.min);
  if (!(amount >= min)) throw new ApiError(400, `Minimum transfer is ₹${min.toLocaleString('en-IN')} a month.`);
  const mult = Math.max(from.stp.multiples || 1, to.stp.multiples || 1);
  if (amount % mult) throw new ApiError(400, `Amount must be in multiples of ₹${mult}.`);
  const minN = Math.max(from.stp.installments_min || 1, to.stp.installments_min || 1);
  const installments = b.installments;
  if (!(installments >= minN)) throw new ApiError(400, `An STP needs at least ${minN} monthly transfers.`);
  const day = b.day;
  if (!from.stp.dates.includes(day) || !to.stp.dates.includes(day)) throw new ApiError(400, 'Choose a transfer date between 1 and 28.');
  // ONDC's review does not check holdings (a plan on units the folio doesn't have reaches `active`), so we do.
  const rep = await fp.get(`/api/oms/reports/holdings?folios=${encodeURIComponent(folio)}`, { label: 'STP: source holding', as: HoldingsReport });
  const held = (rep.folios ?? []).flatMap((f) => f.schemes ?? []).find((s) => s.isin === from.isin);
  const value = await freeValue(ctx.user.id, folio, from.isin, Number(held?.market_value?.redeemable_amount ?? held?.market_value?.amount ?? 0));
  if (value < amount) throw new ApiError(400, `You hold ₹${Math.floor(value).toLocaleString('en-IN')} in this fund, less than one transfer.`);

  const twofa = await requireTxnOtp(ctx.user, 'stp', b.otp);
  const meta = { user_id: ctx.user.id, kind: 'stp' as const, isin: from.isin, isin_to: to.isin, amount };
  let p = await fp.post('/v2/mf_switch_plans', {
    mf_investment_account: ids.mfia, folio_number: folio, switch_out_scheme: from.isin, switch_in_scheme: to.isin,
    amount, frequency: 'monthly', installment_day: day, number_of_installments: installments, systematic: true,
    auto_generate_installments: true, initiated_by: 'investor', initiated_via: 'mobile_app', user_ip: ctx.ip,
    source_ref_id: `risips-stp-${ctx.user.id}-${crypto.randomBytes(4).toString('hex')}`,
  }, { label: 'STP: create plan', as: MfSwitchPlan });
  await ordersRepo.upsert({ id: p.id, ...meta, state: p.state, data: { fp: p, twofa } });
  p = await poll(() => fp.get(`/v2/mf_switch_plans/${p.id}`, { quiet: true, as: MfSwitchPlan }), (x) => x.state !== 'created', { every: 2000, max: 45000 });
  if (p.state !== 'review_completed') {
    await ordersRepo.upsert({ id: p.id, ...meta, state: p.state, data: { fp: p } });
    throw new ApiError(422, p.state === 'created'
      ? 'The fund house is taking longer than usual to review this STP. Please check again in a few minutes.'
      : planFailText('STP', p.reason));
  }
  // consent + confirmed in one call, as for SIP plans
  p = await fp.patch('/v2/mf_switch_plans', { id: p.id, state: 'confirmed', consent: consentFor(ctx.user) }, { label: 'STP: consent + confirm', as: MfSwitchPlan });
  p = await poll(() => fp.get(`/v2/mf_switch_plans/${p.id}`, { quiet: true, as: MfSwitchPlan }), (x) => !['confirmed', 'submitted'].includes(x.state), { every: 2000, max: 30000 });
  const saved = await ordersRepo.upsert({ id: p.id, ...meta, state: p.state, data: { fp: p } });
  // Only active (or still activating) counts as started; anything else after confirm is a rejection.
  if (!['active', 'confirmed', 'submitted'].includes(p.state)) throw new ApiError(422, planFailText('STP', p.reason));
  return { stp: planView(saved) };
}

export async function listStps(user: User) {
  const list = await ordersRepo.forUser(user.id, 'stp');
  const open = list.filter((x) => !['cancelled', 'completed', 'failed'].includes(x.state)).slice(0, 12);
  await Promise.all(open.map((o) => refreshPlan(o).catch(() => {})));
  return { stps: (await ordersRepo.forUser(user.id, 'stp')).map(planView) };
}

export async function getStp(user: User, id: string) {
  return { stp: planView(await refreshPlan(await ownOrder(user, id, 'stp', 'STP not found'))) };
}

export async function cancelStp(user: User, id: string, otp: string | null | undefined) {
  const found = await ownOrder(user, id, 'stp', 'STP not found');
  const o = await refreshPlan(found).catch(() => found); // the stored state can lag FP's
  if (['cancelled', 'completed', 'failed'].includes(o.state)) return { stp: planView(o) };
  // ONDC refuses to cancel a plan that was never confirmed ("Cancellation not allowed ... with ONDC gateway").
  if (!['active', 'confirmed', 'submitted'].includes(o.state)) throw new ApiError(400, 'This STP never started, so there is nothing to cancel. No transfers will run on it.');
  await ordersRepo.upsert({ ...o, data: { cancel_twofa: await requireTxnOtp(user, 'stp_cancel', otp) } });
  // Unlike purchase plans (POST /v2/mf_purchase_plans/cancel {id, code}), switch plans cancel by path.
  await fp.post(`/v2/mf_switch_plans/${o.id}/cancel`, {}, { label: 'STP: cancel' });
  // Same as SWP: the cancel response and an immediate GET can still say `active`, so wait for FP to flip it.
  await poll(() => fp.get(`/v2/mf_switch_plans/${o.id}`, { quiet: true, as: MfSwitchPlan }), (x) => x.state !== 'active', { every: 1500, max: 15000 }).catch(() => {});
  return { stp: planView(await refreshPlan(o)) };
}
