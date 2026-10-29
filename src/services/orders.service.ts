// One-time orders: lumpsum purchases (single and batch), redemptions, switches; order views and status refresh.
// Flow details and gotchas: CLAUDE.md "FintechPrimitives" section (ONDC gateway).
import crypto from 'node:crypto';
import { config } from '../config/env.ts';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { asModelOrNull, fp, FpError } from '../integrations/fp.client.ts';
import { CheckoutPayment, HoldingsReport, listOf, MfPurchase, MfRedemption, MfSwitch, Payment } from '../integrations/fp.schemas.ts';
import type { FpModel, FpOrderObject } from '../integrations/fp.schemas.ts';
import { poll, sleep } from '../utils/async.ts';
import { ApiError } from '../utils/errors.ts';
import { scheme, summary } from './catalog.service.ts';
import { requireTxnOtp } from './otp.service.ts';
import type { FpObject, Order, OrderData, OrderKind, TxnConsent, User } from '../types/domain.ts';

/** Who is acting: the signed-in investor and their IP (FP records it with every order). */
export interface Ctx { user: User; ip: string }

export const PATHS: Partial<Record<OrderKind, string>> & Record<'purchase' | 'redemption' | 'switch', string> = { purchase: '/v2/mf_purchases', redemption: '/v2/mf_redemptions', switch: '/v2/mf_switches' };
export const TERMINAL = ['successful', 'failed', 'cancelled', 'reversed', 'completed'];

/** The model of each one-time order kind's FP object. */
const ORDER_MODELS: Record<'purchase' | 'redemption' | 'switch', FpModel<FpOrderObject>> = { purchase: MfPurchase, redemption: MfRedemption, switch: MfSwitch };

export function requireInvestor(user: User) {
  const f = user.data.fp;
  if (!user.data.onboarded_at || !f?.mfia) throw new ApiError(403, 'Please complete your KYC to invest.');
  return f;
}

export const consentFor = (user: User) => ({ email: user.email, isd_code: '91', mobile: user.mobile });

const STATE_LABEL: Record<string, string> = {
  under_review: 'Processing', pending: 'Awaiting payment', confirmed: 'Processing', submitted: 'Submitted to AMC',
  successful: 'Successful', failed: 'Failed', cancelled: 'Cancelled', reversed: 'Reversed',
};

/** FP failure / state codes -> investor-facing text (raw codes never reach the app). */
export const FAIL_MSG: Record<string, string> = {
  pan_kyc_incomplete: 'Your KYC is not complete with the KRA yet.',
  order_failure_at_gateway: 'The fund house rejected the order.',
  payment_failed_by_user: 'The payment was not completed.',
  fp_payment_url_unused: 'The payment link expired before it was used.',
  order_processing_error: 'The fund platform could not process this order right now. Please try again in a few minutes.',
};
export const failText = (code: string | null | undefined, fallback = 'Please try again in a moment.') => FAIL_MSG[code!] || fallback;

/**
 * Text for a SIP/STP/SWP that FP failed. During an ONDC outage (2026-09-29 12:09–12:31 IST) every plan failed within a
 * second of confirm with the generic reason "Failed to process your request. Please contact admin.", which is not
 * something to show an investor.
 */
export function planFailText(kind: string, reason: string | null | undefined) {
  if (!reason || /contact admin|failed to process/i.test(reason)) {
    return `The fund platform could not register this ${kind} right now. Nothing was debited; please try again in a few minutes.`;
  }
  return `The fund house did not accept this ${kind}: ${reason}`;
}

/** Unpaid purchase that FP still lists as submitted/pending: say so instead of "Submitted to AMC". */
function purchaseStatus(o: Order) {
  const pay = o.data?.payment?.status;
  if (o.kind !== 'purchase' || !['pending', 'confirmed', 'submitted'].includes(o.state) || !o.data?.payment) return null;
  if (pay === 'SUCCESS') return null;
  return ['FAILED', 'REJECTED'].includes(pay ?? '') ? 'Payment failed' : 'Payment pending';
}

/** App-facing order view. */
export function view(o: Order) {
  const d = o.data || {};
  const f = d.fp || {};
  const s = scheme(o.isin);
  const s2 = o.isin_to ? scheme(o.isin_to) : null;
  const units = f.allotted_units ?? f.redeemed_units ?? f.switched_out_units ?? null;
  return {
    id: o.id,
    ref: f.old_id ? `#MF${String(f.old_id).padStart(6, '0')}` : o.id,
    kind: o.kind,
    isin: o.isin,
    fund: summary(s) || { name: (typeof f.scheme_name === 'string' && f.scheme_name) || o.isin, short_name: o.isin },
    fund_to: s2 ? summary(s2) : null,
    amount: o.amount ?? f.redeemed_amount ?? f.switched_out_amount ?? null, // null until FP prices a full redemption/switch
    units,
    units_in: f.switched_in_units ?? null,
    nav: f.purchased_price ?? f.redeemed_price ?? f.switched_out_price ?? null,
    state: o.state,
    status: purchaseStatus(o) || STATE_LABEL[o.state] || o.state,
    failure_code: f.failure_code || null,
    folio: f.folio_number || f.switch_in_folio_number || null,
    token_url: ['pending', 'confirmed', 'submitted'].includes(o.state) && d.payment?.status !== 'SUCCESS' ? d.token_url || null : null,
    payment: d.payment || null,
    created_at: o.created_at,
    updated_at: o.updated_at,
    succeeded_at: f.succeeded_at || null,
    traded_on: f.traded_on || null,
    // a redemption / switch of all units carries no amount until the fund house prices it
    all_units: (o.kind === 'redemption' || o.kind === 'switch') && o.amount == null,
    // all units: what they're worth at the latest NAV, until processed (see withEstimates)
    estimated_amount: o.estimate ?? null,
    // what the fund house actually did (purchased_amount is net of stamp duty); null until allotted
    processed_amount: f.purchased_amount ?? f.redeemed_amount ?? f.switched_out_amount ?? null,
    processed_units: f.allotted_units ?? f.redeemed_units ?? f.switched_out_units ?? null,
    fp_id: o.id,
    fp_old_id: f.old_id || null,
  };
}

export async function refresh(o: Order): Promise<Order> {
  const m = ORDER_MODELS[o.kind as keyof typeof ORDER_MODELS];
  if (!PATHS[o.kind] || !m) return o;
  const f = await fp.get(`${PATHS[o.kind]}/${o.id}`, { label: `refresh ${o.kind}`, as: m });
  return await ordersRepo.upsert({ ...o, state: f.state, data: { fp: f } });
}

/** Latest FP payment status for a purchase (FP flips it to FAILED only when the checkout fails or expires). */
export async function refreshPayment(o: Order): Promise<Order> {
  if (o.kind !== 'purchase' || !o.data.payment?.id || o.data.payment.status === 'SUCCESS') return o;
  const p = await fp.raw('GET', `/api/pg/payments/${o.data.payment.id}`, undefined, { quiet: true });
  const pay = p.status === 200 ? asModelOrNull(Payment, p.json, { label: 'payment status' }) : null;
  if (!pay) return o;
  return await ordersRepo.upsert({ ...o, data: { payment: { id: o.data.payment.id, status: pay.status, reference: pay.payment_reference ?? null } } });
}

/** Folio already opened with this AMC (the AMC does not reuse folios automatically). */
export async function folioForAmc(userId: number, amcId: number): Promise<string | null> {
  for (const o of await ordersRepo.forUser(userId)) {
    const f = o.data.fp || {};
    // a SIP plan may carry no folio of its own until its first instalment is allotted; the instalments do
    const folio = o.kind === 'switch' ? f.switch_in_folio_number || f.folio_number : f.folio_number || (o.data.installments || []).find((i) => i.folio)?.folio;
    if (folio && scheme(o.isin_to || o.isin)?.amc_id === amcId) return folio;
  }
  return null;
}

async function waitReview<T extends { state: string }>(path: string, id: string, as: FpModel<T>): Promise<T> {
  return poll(() => fp.get(`${path}/${id}`, { quiet: true, as }), (x) => x.state !== 'under_review', { every: 2000, max: 45000 });
}

// ---------- Lumpsum ----------

/** Checks a one-time investment against the scheme rules (the additional-purchase minimum once a folio exists). */
export async function validateLumpsum(user: User, { isin, amount }: { isin: string; amount: number | string }) {
  const s = scheme(isin);
  if (!s) throw new ApiError(404, 'Fund not found');
  const name = summary(s).short_name;
  if (s.lumpsum.allowed === false) throw new ApiError(400, `${name} accepts SIP only. One-time investments are not open for it right now.`);
  amount = Number(amount);
  const folio = await folioForAmc(user.id, s.amc_id);
  const min = folio ? s.lumpsum.additional_min || s.lumpsum.min : s.lumpsum.min;
  if (!(amount >= min!)) throw new ApiError(400, `Minimum investment in ${name} is ₹${min!.toLocaleString('en-IN')}.`);
  if (s.lumpsum.multiples > 1 && amount % s.lumpsum.multiples) throw new ApiError(400, `Amount for ${name} must be in multiples of ₹${s.lumpsum.multiples}.`);
  return { s, amount, folio };
}

/** Places a lumpsum up to the payment: create -> review -> consent -> UPI checkout link -> confirm. Returns { saved, token_url }. */
export async function placeLumpsum(ctx: Ctx, { isin, amount: rawAmount, twofa }: { isin: string; amount: number | string; twofa?: TxnConsent }) {
  const ids = requireInvestor(ctx.user);
  const { s, amount, folio } = await validateLumpsum(ctx.user, { isin, amount: rawAmount });
  const ip = ctx.ip;
  // 1. create order
  let o = await fp.post('/v2/mf_purchases', {
    mf_investment_account: ids.mfia, scheme: s.isin, amount, user_ip: ip, server_ip: ip, gateway: 'ondc',
    source_ref_id: `risips-${ctx.user.id}-${crypto.randomBytes(5).toString('hex')}`,
    ...(folio ? { folio_number: folio } : {}),
  }, { label: 'lumpsum: create order', as: MfPurchase });
  await ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind: 'purchase', isin: s.isin, amount, state: o.state, data: { fp: o, amc_id: s.amc_id, twofa } });
  // 2. wait for review -> pending
  o = await waitReview(PATHS.purchase, o.id, MfPurchase);
  await ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind: 'purchase', isin: s.isin, amount, state: o.state, data: { fp: o } });
  if (o.state !== 'pending') throw new ApiError(422, `Order could not be placed. ${failText(o.failure_code, o.state === 'under_review' ? 'The fund house is taking longer than usual; check Orders in a minute.' : 'Please try again in a moment.')}`, { order: view((await ordersRepo.get(o.id))!) });
  // 3. consent alone (ONDC rejects consent + state together for purchases)
  await fp.patch('/v2/mf_purchases', { id: o.id, consent: consentFor(ctx.user) }, { label: 'lumpsum: investor consent' });
  // 4. payment -> token_url (ONDC UPI checkout the investor must open)
  const pay = await fp.post('/api/pg/payments/netbanking', {
    amc_order_ids: [o.old_id], method: 'UPI', provider_name: 'ONDC', bank_account_id: ids.bank_old_id,
    payment_postback_url: `${config.publicUrl}/pay/return?order=${o.id}`,
  }, { label: 'lumpsum: create payment', as: CheckoutPayment });
  // 5. confirm -> submitted
  o = await fp.patch('/v2/mf_purchases', { id: o.id, state: 'confirmed' }, { label: 'lumpsum: confirm order', as: MfPurchase });
  // During an ONDC outage FP fails the order ~1 s after confirm (order_processing_error). Catch that here so the
  // investor isn't sent to a checkout for a dead order; a healthy order is 'submitted' within ~2 s.
  o = await poll(() => fp.get(`${PATHS.purchase}/${o.id}`, { quiet: true, as: MfPurchase }), (x) => x.state !== 'confirmed', { every: 1500, max: 3000 });
  if (['failed', 'cancelled'].includes(o.state)) {
    await ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind: 'purchase', isin: s.isin, amount, state: o.state, data: { fp: o } });
    throw new ApiError(503, `Order could not be placed. ${failText(o.failure_code)} Nothing was debited.`, { order: view((await ordersRepo.get(o.id))!) });
  }
  const saved = await ordersRepo.upsert({
    id: o.id, user_id: ctx.user.id, kind: 'purchase', isin: s.isin, amount, state: o.state,
    data: { fp: o, token_url: pay.token_url, payment: { id: pay.id, status: pay.status || 'PENDING' } },
  });
  return { saved, token_url: pay.token_url };
}

/** FP answers a stray 502 now and then (seen on a consent PATCH, 2026-09-29); a second try goes through. */
export async function retry5xx<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof FpError) || !(e.status >= 500)) throw e;
    await sleep(1500);
    return fn();
  }
}

/**
 * Places several lumpsums (max 10) as one ONDC batch paid on ONE UPI checkout: POST /v2/mf_purchases/batch -> review
 * -> consent per order -> one payment for every old_id -> PATCH /v2/mf_purchases/batch confirmed. Only batch-created
 * orders share a payment (orders created one by one -> 422). Verified 2026-09-29: two orders, one ₹2,000 checkout, both
 * allotted ~10 s after paying. FP fails the whole batch if any order fails, so any failure fails every line here too.
 * Returns { saved: [order per line, in order], token_url }.
 */
export async function placeLumpsumBatch(ctx: Ctx, lines: { isin: string; amount: number | string }[]) {
  const ids = requireInvestor(ctx.user);
  const ip = ctx.ip;
  const vs: Awaited<ReturnType<typeof validateLumpsum>>[] = [];
  for (const x of lines) vs.push(await validateLumpsum(ctx.user, x));
  const created = await fp.post('/v2/mf_purchases/batch', {
    mf_purchases: vs.map(({ s, amount, folio }) => ({
      mf_investment_account: ids.mfia, scheme: s.isin, amount, user_ip: ip, server_ip: ip, gateway: 'ondc',
      source_ref_id: `risips-${ctx.user.id}-${crypto.randomBytes(5).toString('hex')}`,
      ...(folio ? { folio_number: folio } : {}),
    })),
  }, { label: 'cart: create batch orders', as: listOf(MfPurchase) });
  let os: MfPurchase[] = created.data;
  const save = (o: MfPurchase, i: number, data: OrderData = {}) => ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind: 'purchase', isin: vs[i].s.isin, amount: vs[i].amount, state: o.state, data: { fp: o, amc_id: vs[i].s.amc_id, ...data } });
  await Promise.all(os.map((o, i) => save(o, i)));
  os = await Promise.all(os.map((o) => waitReview(PATHS.purchase, o.id, MfPurchase)));
  await Promise.all(os.map((o, i) => save(o, i)));
  const bad = os.find((o) => o.state !== 'pending');
  if (bad) throw new ApiError(422, `These orders could not be placed. ${failText(bad.failure_code, bad.state === 'under_review' ? 'The fund house is taking longer than usual; please try again in a few minutes.' : 'Please try again in a moment.')}`);
  for (const o of os) await retry5xx(() => fp.patch('/v2/mf_purchases', { id: o.id, consent: consentFor(ctx.user) }, { label: 'cart: batch consent' }));
  const pay = await fp.post('/api/pg/payments/netbanking', {
    amc_order_ids: os.map((o) => o.old_id), method: 'UPI', provider_name: 'ONDC', bank_account_id: ids.bank_old_id,
    payment_postback_url: `${config.publicUrl}/pay/return?order=${os[0].id}`,
  }, { label: 'cart: batch payment', as: CheckoutPayment });
  await fp.patch('/v2/mf_purchases/batch', { mf_purchases: os.map((o) => ({ id: o.id, state: 'confirmed' })) }, { label: 'cart: batch confirm' });
  // as for a single order: an outage fails the batch ~1 s after confirm; don't open a checkout for dead orders
  os = await Promise.all(os.map((o) => poll(() => fp.get(`${PATHS.purchase}/${o.id}`, { quiet: true, as: MfPurchase }), (x) => x.state !== 'confirmed', { every: 1500, max: 3000 })));
  const failed = os.find((o) => ['failed', 'cancelled'].includes(o.state));
  await Promise.all(os.map((o, i) => save(o, i, failed ? {} : { token_url: pay.token_url, payment: { id: pay.id, status: pay.status || 'PENDING' }, batch_payment: pay.id })));
  if (failed) throw new ApiError(503, `These orders could not be placed. ${failText(failed.failure_code)} Nothing was debited.`);
  return { saved: (await Promise.all(os.map((o) => ordersRepo.get(o.id)))) as Order[], token_url: pay.token_url };
}

// ---------- Redemption / switch ----------

async function placeSellSide(ctx: Ctx, kind: 'redemption' | 'switch', body: FpObject, meta: { isin: string; isin_to?: string; amount: number | null }, otp: string | null | undefined) {
  const path = PATHS[kind];
  const as: FpModel<MfRedemption | MfSwitch> = kind === 'redemption' ? MfRedemption : MfSwitch;
  const twofa = await requireTxnOtp(ctx.user, kind === 'redemption' ? 'redeem' : 'switch', otp); // after validation, before the first FP write
  let o = await fp.post(path, body, { label: `${kind}: create order`, as });
  await ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind, ...meta, state: o.state, data: { fp: o, twofa } });
  o = await waitReview(path, o.id, as);
  if (o.state !== 'pending') {
    await ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind, ...meta, state: o.state, data: { fp: o } });
    throw new ApiError(422, o.state === 'under_review'
      ? 'The fund house is taking longer than usual to review this order. Check Orders in a minute.'
      : `The order could not be placed. ${failText(o.failure_code)}`);
  }
  // consent + confirmed in ONE call for redemptions/switches
  o = await fp.patch(path, { id: o.id, state: 'confirmed', consent: consentFor(ctx.user) }, { label: `${kind}: consent + confirm`, as });
  return await ordersRepo.upsert({ id: o.id, user_id: ctx.user.id, kind, ...meta, state: o.state, data: { fp: o } });
}

/**
 * The folio's redeemable value for a scheme (FP rejects amounts above it), or null when the report can't be read.
 * FP already leaves out units under an open redemption / switch (verified 2026-10-23: ₹497.91 held, two ₹100 orders
 * open, ₹297.91 redeemable). market = true gives the full value (units held x latest NAV) instead.
 */
async function redeemableValue(folio: string, isin: string, market = false): Promise<number | null> {
  const rep = await fp.get(`/api/oms/reports/holdings?folios=${encodeURIComponent(folio)}`, { label: 'redeemable amount', as: HoldingsReport }).catch(() => null);
  if (!rep) return null;
  const held = (rep.folios ?? []).flatMap((f) => f.schemes ?? []).find((x) => x.isin === isin);
  return held ? Number((market ? null : held.market_value?.redeemable_amount) ?? held.market_value?.amount ?? 0) : 0;
}

// ---------- Orders in progress ----------
// FP's holdings report changes only once the fund house processes an order (1-2 working days on production), so until
// then a switched-out holding still looks untouched and the switched-in fund isn't there at all.

const isSell = (o: Order) => o.kind === 'redemption' || o.kind === 'switch';
/** A redemption / switch whose units haven't left the folio yet (`pending` = never confirmed: it goes nowhere). */
const sellOpen = (o: Order) => isSell(o) && ['confirmed', 'submitted'].includes(o.state);
/** A switch that FP marks successful after its out-leg, before the units arrive in the target fund. */
const switchInPending = (o: Order) => o.kind === 'switch' && o.state === 'successful' && o.data.fp?.switched_in_units == null;
/** A paid purchase not allotted yet (an unpaid one is "Payment pending" in Orders, not money on its way). */
const buyOpen = (o: Order) => o.kind === 'purchase' && ['confirmed', 'submitted'].includes(o.state) && !purchaseStatus(o);
export const inProgress = (o: Order) => sellOpen(o) || switchInPending(o) || buyOpen(o);

/** Open redemptions / switches out of this folio + fund. */
export const outOf = (all: Order[], folio: string, isin: string) => all.filter((o) => sellOpen(o) && o.isin === isin && o.data.fp?.folio_number === folio);

/**
 * Refuses a new redemption, switch, STP or SWP while every unit is already leaving (FP's redeemable value is then 0,
 * which would only say "no redeemable units"). Returns the value unchanged: FP already nets off open orders.
 */
export async function freeValue<T extends number | null>(userId: number, folio: string, isin: string, value: T): Promise<T> {
  const out = outOf(await ordersRepo.forUser(userId), folio, isin);
  const full = out.find((o) => o.amount == null);
  if (full) {
    throw new ApiError(409, `A ${full.kind === 'switch' ? 'switch' : 'redemption'} of all units in this fund is already in progress. You can place a new order once the fund house has processed it.`);
  }
  return value;
}

/** An order in progress for the portfolio, without the payment link (the Admin API passes the portfolio on). */
export const openView = (o: Order) => { const { token_url: _link, ...v } = view(o); return v; };

const estimates = new Map<string, { amount: number | null; at: number }>(); // order id -> { amount, at }
/**
 * Puts `estimate` (units held x latest NAV, from FP's holdings report) on open all-units redemptions / switches, for
 * view(). Cached 10 min per order, so list screens don't call FP on every refresh.
 */
export async function withEstimates(rows: Order[]): Promise<Order[]> {
  for (const o of rows) {
    if (!sellOpen(o) || o.amount != null || !o.data.fp?.folio_number) continue;
    let e = estimates.get(o.id);
    if (!e || Date.now() - e.at > 10 * 60_000) {
      const v = await redeemableValue(o.data.fp.folio_number, o.isin!, true);
      e = { amount: v == null ? null : Math.round(v * 100) / 100, at: Date.now() };
      if (v != null) estimates.set(o.id, e);
    }
    o.estimate = e.amount;
  }
  return rows;
}

/** One order in progress, as the portfolio shows it. */
export const pendingItem = (o: Order, dir: 'in' | 'out') => ({
  id: o.id, kind: o.kind, dir, status: o.kind === 'switch' && switchInPending(o) ? 'Units on the way' : STATE_LABEL[o.state] || o.state,
  amount: o.amount ?? null, all: isSell(o) && o.amount == null, created_at: o.created_at,
  ...(o.kind === 'switch' ? (dir === 'out' ? { to: summary(scheme(o.isin_to))?.short_name || o.isin_to } : { from: summary(scheme(o.isin))?.short_name || o.isin }) : {}),
});


// ---------- order entry points ----------

export async function lumpsum(ctx: Ctx, { isin, amount, otp }: { isin: string; amount: number; otp?: string | null }) {
  requireInvestor(ctx.user);
  await validateLumpsum(ctx.user, { isin, amount }); // before the OTP, so a bad amount doesn't spend it
  const twofa = await requireTxnOtp(ctx.user, 'lumpsum', otp);
  const { saved, token_url } = await placeLumpsum(ctx, { isin, amount, twofa });
  return { order: view(saved), token_url, return_url_prefix: `${config.publicUrl}/pay/return` };
}

export async function redeem(ctx: Ctx, b: { isin: string; folio: string; all: boolean; amount?: number; otp?: string | null }) {
  const ids = requireInvestor(ctx.user);
  const s = scheme(b.isin);
  if (!s) throw new ApiError(404, 'Fund not found');
  const { folio } = b;
  // all=true leaves out amount and units: FP then redeems the entire holding in the folio
  const all = b.all;
  const amount = all ? null : Math.floor(Number(b.amount));
  if (!all && !(amount! >= 100)) throw new ApiError(400, 'Minimum redemption is ₹100.');
  const value = await freeValue(ctx.user.id, folio, s.isin, await redeemableValue(folio, s.isin));
  if (value != null && value <= 0) throw new ApiError(400, 'There are no redeemable units of this fund in this folio right now.');
  if (value != null && !all && amount! > Math.floor(value)) throw new ApiError(400, `You can redeem up to ₹${Math.floor(value).toLocaleString('en-IN')} from this fund right now.`);
  const o = await placeSellSide(ctx, 'redemption', {
    mf_investment_account: ids.mfia, folio_number: folio, scheme: s.isin, ...(all ? {} : { amount }), user_ip: ctx.ip, server_ip: ctx.ip,
    source_ref_id: `risips-r-${ctx.user.id}-${crypto.randomBytes(4).toString('hex')}`,
  }, { isin: s.isin, amount }, b.otp);
  return { order: view(o) };
}

export async function switchFunds(ctx: Ctx, b: { from_isin: string; to_isin: string; folio: string; all: boolean; amount?: number; otp?: string | null }) {
  const ids = requireInvestor(ctx.user);
  const from = scheme(b.from_isin);
  const to = scheme(b.to_isin);
  if (!from || !to) throw new ApiError(404, 'Fund not found');
  if (from.amc_id !== to.amc_id) throw new ApiError(400, 'You can only switch between funds of the same fund house.');
  const { folio } = b;
  const all = b.all; // same as redemption: no amount/units = switch the entire holding
  const amount = all ? null : Math.floor(Number(b.amount));
  // the target's own switch-in minimum (Liquid / Money Market take ₹1; FP sets no switch-out minimum); ₹100 if unknown
  const min = to.switch_in?.min || 100;
  if (!all && !(amount! >= min)) throw new ApiError(400, `${to.name} takes switches of at least ₹${min.toLocaleString('en-IN')}.`);
  const value = await freeValue(ctx.user.id, folio, from.isin, await redeemableValue(folio, from.isin));
  if (value != null && value <= 0) throw new ApiError(400, 'There are no redeemable units of this fund in this folio right now.');
  if (value != null && all && value < min) throw new ApiError(400, `You hold ₹${Math.floor(value).toLocaleString('en-IN')}, less than the ₹${min.toLocaleString('en-IN')} minimum switch into ${to.name}.`);
  if (value != null && !all && amount! > Math.floor(value)) throw new ApiError(400, `You can switch up to ₹${Math.floor(value).toLocaleString('en-IN')} from this fund right now.`);
  const o = await placeSellSide(ctx, 'switch', {
    mf_investment_account: ids.mfia, folio_number: folio, switch_out_scheme: from.isin, switch_in_scheme: to.isin, ...(all ? {} : { amount }),
    user_ip: ctx.ip, server_ip: ctx.ip, source_ref_id: `risips-s-${ctx.user.id}-${crypto.randomBytes(4).toString('hex')}`,
  }, { isin: from.isin, isin_to: to.isin, amount }, b.otp);
  return { order: view(o) };
}

// ---------- order history ----------

export async function listOrders(user: User) {
  let list = (await ordersRepo.forUser(user.id)).filter((o) => PATHS[o.kind]); // plans (sip/stp/swp) have their own lists
  // refresh a few open orders so statuses move even when a webhook is missed
  const open = list.filter((o) => !TERMINAL.includes(o.state)).slice(0, 8);
  await Promise.all(open.map((o) => refresh(o).then(refreshPayment).catch(() => {})));
  if (open.length) list = (await ordersRepo.forUser(user.id)).filter((o) => PATHS[o.kind]);
  return { orders: list.map(view) };
}

/** The user's own order or plan of that kind; anyone else's is a 404 (not a 403, which would confirm it exists). */
export async function ownOrder(user: User, id: string, kind: OrderKind, notFound: string): Promise<Order> {
  const o = await ordersRepo.get(id);
  if (!o || o.user_id !== user.id || o.kind !== kind) throw new ApiError(404, notFound);
  return o;
}

export async function getOrder(user: User, id: string, force: boolean) {
  const found = await ordersRepo.get(id);
  if (!found || found.user_id !== user.id) throw new ApiError(404, 'Order not found');
  let o = found;
  // a switch turns successful after its out-leg; keep refreshing until the in-leg units arrive
  const inLegPending = o.kind === 'switch' && o.state === 'successful' && o.data.fp?.switched_in_units == null;
  if (!TERMINAL.includes(o.state) || inLegPending || force) o = await refresh(o);
  o = await refreshPayment(o);
  return { order: view(o) };
}
