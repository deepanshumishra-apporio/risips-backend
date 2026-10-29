// Cart (Figma "Cart" 8:7695/8:7712, "Checkout" 8:8004, "Order Success" 8:8072) and the cart checkout.
// ONDC batch orders share one payment (verified 2026-09-29), but lumpsums and SIP first instalments can't share one
// (422). So a checkout pays in at most two groups: every one-time line on one UPI checkout, every SIP on another.
// POST /checkouts/:id/next places the next group only when the investor is about to pay it.
import crypto from 'node:crypto';
import { config } from '../config/env.ts';
import { checkoutsRepo } from '../db/repositories/misc.repository.ts';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { asModelOrNull, fp, FpError } from '../integrations/fp.client.ts';
import { Payment } from '../integrations/fp.schemas.ts';
import { ApiError } from '../utils/errors.ts';
import { scheme, summary } from './catalog.service.ts';
import { usableMandate } from './mandate.service.ts';
import { requireTxnOtp } from './otp.service.ts';
import { failText, placeLumpsum, placeLumpsumBatch, refresh, refreshPayment, requireInvestor, TERMINAL, validateLumpsum, view } from './orders.service.ts';
import type { Ctx } from './orders.service.ts';
import { createPlan, createPlanBatch, planView, refreshPlan, validateSip } from './sip.service.ts';
import type { ValidSip } from './sip.service.ts';
import type { CartLine, Checkout, CheckoutItem, Order, User } from '../types/domain.ts';

/** A cart line before it is saved (no id yet). */
export type LineInput = Pick<CartLine, 'isin' | 'mode' | 'amount'>;

const MAX_ITEMS = 10;

const cartOf = async (user: User): Promise<CartLine[]> => (await usersRepo.byId(user.id))?.data.cart || [];
/** Changes the cart with the user row locked: fn gets the current lines (fresh from the database, safe to change) and returns the new ones. */
const changeCart = (user: User, fn: (cart: CartLine[]) => CartLine[]) => usersRepo.update(user.id, (d) => ({ cart: fn(d.cart || []) }));

/** SIP dates every SIP scheme in the list accepts (one SIP date for the whole checkout). */
function commonSipDates(items: LineInput[]) {
  let days = Array.from({ length: 28 }, (_, i) => i + 1);
  for (const it of items.filter((x) => x.mode === 'sip')) {
    const rule = scheme(it.isin)?.sip.find((x) => x.frequency === 'monthly');
    if (rule?.dates?.length) days = days.filter((d) => rule.dates.includes(d));
  }
  return days;
}

/** Checks one cart line against the scheme rules; returns the error text, or null when it can be bought. */
async function problemWith(user: User, it: LineInput, day?: number | null) {
  try {
    if (it.mode === 'lumpsum') await validateLumpsum(user, it);
    else await validateSip(user, { isin: it.isin, amount: it.amount, day: day ?? commonSipDates([it])[0] ?? 1 });
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.message;
    throw e;
  }
}

async function cartView(user: User) {
  const cart = await cartOf(user);
  const items = await Promise.all(cart.map(async (it) => ({
    ...it, fund: summary(scheme(it.isin)), problem: await problemWith(user, it),
  })));
  const sum = (mode: CartLine['mode']) => items.filter((x) => x.mode === mode).reduce((a, x) => a + Number(x.amount), 0);
  return {
    items,
    sip_total: sum('sip'), lumpsum_total: sum('lumpsum'),
    // every SIP's first instalment is paid today along with the one-time investments
    pay_now: sum('sip') + sum('lumpsum'),
    sip_dates: commonSipDates(items),
  };
}

export const getCart = (user: User) => cartView(user);

export async function addToCart(user: User, line: LineInput) {
  requireInvestor(user);
  if (!scheme(line.isin)) throw new ApiError(404, 'Fund not found');
  const problem = await problemWith(user, line);
  if (problem) throw new ApiError(400, problem);
  await changeCart(user, (cart) => {
    // the same fund and mode again replaces the amount instead of adding a second line
    const same = cart.find((x) => x.isin === line.isin && x.mode === line.mode);
    if (same) Object.assign(same, { amount: line.amount });
    else {
      if (cart.length >= MAX_ITEMS) throw new ApiError(400, `Your cart can hold up to ${MAX_ITEMS} funds.`);
      cart.push({ id: `ci_${crypto.randomBytes(5).toString('hex')}`, ...line, added_at: new Date().toISOString() });
    }
    return cart;
  });
  return cartView(user);
}

export async function updateCartLine(user: User, id: string, patch: Partial<LineInput>) {
  const gone = () => new ApiError(404, 'This item is no longer in your cart.');
  const it = (await cartOf(user)).find((x) => x.id === id);
  if (!it) throw gone();
  const line: LineInput = { isin: it.isin, mode: patch.mode ?? it.mode, amount: patch.amount ?? it.amount };
  const problem = await problemWith(user, line);
  if (problem) throw new ApiError(400, problem);
  await changeCart(user, (cart) => {
    const now = cart.find((x) => x.id === id); // re-read: the cart may have changed while the line was checked
    if (!now) throw gone();
    if (cart.some((x) => x.id !== now.id && x.isin === line.isin && x.mode === line.mode)) throw new ApiError(409, 'This fund is already in your cart with that plan type.');
    Object.assign(now, line);
    return cart;
  });
  return cartView(user);
}

export async function removeCartLine(user: User, id: string) {
  await changeCart(user, (cart) => cart.filter((x) => x.id !== id));
  return cartView(user);
}

// ---------- Checkout ----------

/** Live status pill for a checkout line (Figma "Order Success": "SIP active" / "Order placed"). */
async function lineStatus(it: CheckoutItem) {
  if (it.state === 'queued') return { label: 'Not paid yet', tone: 'neutral' };
  if (it.state === 'skipped') return { label: 'Not paid · still in cart', tone: 'neutral' };
  if (it.state === 'placing') return { label: 'Placing order', tone: 'pending' };
  if (it.state === 'failed') return { label: 'Not placed', tone: 'fail', detail: it.error };
  let o = await ordersRepo.get(it.order_id!);
  if (!o) return { label: 'Not placed', tone: 'fail' };
  if (it.mode === 'lumpsum') {
    if (!TERMINAL.includes(o.state)) o = await refresh(o).catch(() => o!);
    o = await refreshPayment(o).catch(() => o!);
    const v = view(o);
    if (o.state === 'successful') return { label: 'Order successful', tone: 'success', ref: v.ref };
    if (['failed', 'cancelled', 'reversed'].includes(o.state)) return { label: 'Order failed', tone: 'fail', detail: failText(v.failure_code), ref: v.ref };
    if (v.payment?.status === 'SUCCESS') return { label: 'Order placed', tone: 'success', ref: v.ref };
    if (['FAILED', 'REJECTED'].includes(v.payment?.status ?? '')) return { label: 'Payment failed', tone: 'fail', ref: v.ref };
    return { label: 'Payment pending', tone: 'pending', ref: v.ref };
  }
  if (!['cancelled', 'completed', 'failed'].includes(o.state)) o = await refreshPlan(o).catch(() => o!);
  const p = planView(o);
  if (p.state === 'failed') return { label: 'Payment failed', tone: 'fail', sip_id: p.id };
  if (['cancelled', 'completed'].includes(p.state)) return { label: p.status, tone: 'neutral', sip_id: p.id };
  if (p.state === 'awaiting_payment') {
    // the first instalment stays submitted for about a minute after it is paid; FP's payment status says paid sooner
    const pay = o.data.first_payment;
    if (pay?.id && pay.status !== 'SUCCESS') {
      const x = await fp.raw('GET', `/api/pg/payments/${pay.id}`, undefined, { quiet: true }).catch(() => null);
      const p = x?.status === 200 ? asModelOrNull(Payment, x.json, { label: 'cart SIP first payment status' }) : null;
      if (p) o = await ordersRepo.upsert({ ...o, data: { first_payment: { ...pay, status: p.status } } });
    }
    const st = o.data.first_payment?.status;
    if (st === 'SUCCESS') return { label: 'SIP active', tone: 'success', sip_id: p.id };
    if (['FAILED', 'REJECTED'].includes(st ?? '')) return { label: 'Payment failed', tone: 'fail', sip_id: p.id };
    return { label: 'Payment pending', tone: 'pending', sip_id: p.id };
  }
  return { label: p.status === 'Active' ? 'SIP active' : p.status, tone: p.state === 'active' ? 'success' : 'pending', sip_id: p.id };
}

async function checkoutView(c: Checkout, live = false) {
  const d = c.data;
  const items = await Promise.all(d.items.map(async (it) => ({
    cart_id: it.cart_id, isin: it.isin, fund: summary(scheme(it.isin)), mode: it.mode, amount: it.amount,
    state: it.state, order_id: it.order_id || null, error: it.error || null,
    status: live ? await lineStatus(it) : null,
  })));
  const count = (s: CheckoutItem['state']) => d.items.filter((x) => x.state === s).length;
  return {
    id: c.id, sip_day: d.sip_day ?? null, created_at: c.created_at, items,
    total: d.items.reduce((a, x) => a + Number(x.amount), 0),
    placed: count('placed'), failed: count('failed'), remaining: count('queued') + count('placing'),
    position: d.items.findIndex((x) => x.state === 'queued' || x.state === 'placing'),
  };
}

async function ownCheckout(user: User, id: string) {
  const c = await checkoutsRepo.get(id);
  if (!c || c.user_id !== user.id) throw new ApiError(404, 'Checkout not found');
  return c;
}

/** Starts a checkout for the cart (or the cart lines in item_ids): checks every line, the SIP date and AutoPay first. */
export async function startCheckout(user: User, b: { item_ids?: string[]; sip_day?: number; otp?: string | null }) {
  requireInvestor(user);
  const cart = await cartOf(user);
  const pick = b.item_ids?.length ? cart.filter((x) => b.item_ids!.includes(x.id)) : cart;
  if (!pick.length) throw new ApiError(400, 'Your cart is empty.');
  const sips = pick.filter((x) => x.mode === 'sip');
  let day: number | null = null;
  if (sips.length) {
    day = Number(b.sip_day);
    if (!commonSipDates(pick).includes(day)) throw new ApiError(400, 'Choose a SIP date that every fund in your cart accepts.');
  }
  for (const it of pick) {
    const problem = await problemWith(user, it, day);
    if (problem) throw new ApiError(400, problem, { cart_id: it.id });
  }
  if (sips.length) {
    // later SIP instalments debit AutoPay; its limit has to cover every SIP in the cart
    const need = sips.reduce((a, x) => a + Number(x.amount), 0);
    try {
      await usableMandate(user, need);
    } catch (e) {
      if (e instanceof ApiError && e.extra?.need_mandate) throw new ApiError(409, e.message, { ...e.extra, need });
      throw e;
    }
  }
  // one OTP authorises every line of this checkout (SEBI 2FA); the lines are placed group by group from /next
  const twofa = await requireTxnOtp(user, 'cart', b.otp);
  const c = await checkoutsRepo.create(user.id, {
    twofa, sip_day: day, items: pick.map((it) => ({ cart_id: it.id, isin: it.isin, mode: it.mode, amount: it.amount, state: 'queued' })),
  });
  return { checkout: await checkoutView(c) };
}

export async function getCheckout(user: User, id: string) {
  return { checkout: await checkoutView(await ownCheckout(user, id), true) };
}

// Checkout ids with an item being placed right now (a double tap must not place it twice). In-process: the API runs as
// one Node process per database (see README "Deploying").
const placing = new Set<string>();

/**
 * Places the next unpaid group (every queued line of the first queued line's mode) and returns its one checkout link.
 * A group that can't be placed is marked failed (its lines stay in the cart) and the response says why, so the app can
 * move on to the next group.
 */
export async function nextCheckoutGroup(ctx: Ctx, id: string) {
  // taken before anything is read, so a double tap is refused even while the first request waits on the database
  const lock = String(id);
  if (placing.has(lock)) throw new ApiError(409, 'Your previous order is still being placed. Please wait a moment.');
  placing.add(lock);
  try {
    const c = await ownCheckout(ctx.user, id);
    const d = c.data;
    if (!d.twofa) throw new ApiError(409, 'This checkout was not confirmed with an OTP. Please check out again.');
    // a line left "placing" by a server restart is not retried blindly: it may have reached FP
    for (const x of d.items) {
      if (x.state === 'placing' && Date.now() - Date.parse(x.started_at!) > 3 * 60e3) Object.assign(x, { state: 'failed', error: 'We could not confirm this order. Check Orders before trying again.' });
    }
    // a line deleted or edited in the cart since this checkout started (or already bought through a newer checkout of
    // the same cart) is not placed from this stale copy
    const cartNow = await cartOf(ctx.user);
    for (const x of d.items) {
      if (x.state !== 'queued') continue;
      const line = cartNow.find((y) => y.id === x.cart_id);
      if (!line) Object.assign(x, { state: 'failed', error: 'This fund is no longer in your cart, so it was not bought here.' });
      else if (line.mode !== x.mode || Number(line.amount) !== Number(x.amount)) Object.assign(x, { state: 'skipped', error: 'Changed in your cart after checkout started. Check out again to buy it.' });
    }
    const first = d.items.find((x) => x.state === 'queued');
    if (!first) {
      await checkoutsRepo.save(c.id, d);
      return { checkout: await checkoutView(c), done: true };
    }
    const group = d.items.filter((x) => x.state === 'queued' && x.mode === first.mode);
    const now = new Date().toISOString();
    for (const x of group) Object.assign(x, { state: 'placing', started_at: now });
    await checkoutsRepo.save(c.id, d);
    let out: { saved: Order[]; token_url?: string };
    try {
      if (first.mode === 'lumpsum') {
        out = group.length > 1 ? await placeLumpsumBatch(ctx, group) : await placeLumpsum(ctx, first).then((x) => ({ ...x, saved: [x.saved] }));
      } else {
        const vs: ValidSip[] = [];
        for (const x of group) vs.push(await validateSip(ctx.user, { isin: x.isin, amount: x.amount, day: d.sip_day }));
        const mandate = await usableMandate(ctx.user, vs.reduce((a, v) => a + Number(v.amount), 0));
        out = group.length > 1
          ? await createPlanBatch(ctx, vs, { mandate, data: { checkout: c.id } })
          : await createPlan(ctx, { ...vs[0], mandate, firstNow: true, firstPay: 'upi', data: { checkout: c.id } }).then((x) => ({ ...x, saved: [x.saved] }));
      }
    } catch (e) {
      if (!(e instanceof ApiError || e instanceof FpError)) throw e;
      const error = e instanceof FpError ? e.userMessage : e.message;
      for (const x of group) Object.assign(x, { state: 'failed', error });
      await checkoutsRepo.save(c.id, d);
      return { checkout: await checkoutView(c), failed: { isin: first.isin, isins: group.map((x) => x.isin), mode: first.mode, error } };
    }
    group.forEach((x, i) => Object.assign(x, { state: 'placed', order_id: out.saved[i].id }));
    out.saved = await Promise.all(out.saved.map((o) => ordersRepo.upsert({ ...o, data: { twofa: d.twofa } })));
    await checkoutsRepo.save(c.id, d);
    // placed: they leave the cart (a failed payment is retried from the order, not by buying it again from the cart)
    const gone = new Set(group.map((x) => x.cart_id));
    await changeCart(ctx.user, (cart) => cart.filter((x) => !gone.has(x.id)));
    return {
      checkout: await checkoutView(c), order_id: out.saved[0].id, order_ids: out.saved.map((o) => o.id), mode: first.mode,
      order: first.mode === 'lumpsum' ? view(out.saved[0]) : planView(out.saved[0]),
      token_url: out.token_url || null, return_url_prefix: `${config.publicUrl}/pay/return`,
    };
  } finally {
    placing.delete(lock);
  }
}

/** Leaves the unpaid lines of a checkout (they stay in the cart). */
export async function stopCheckout(user: User, id: string) {
  const c = await ownCheckout(user, id);
  for (const x of c.data.items) if (x.state === 'queued') x.state = 'skipped';
  await checkoutsRepo.save(c.id, c.data);
  return { checkout: await checkoutView(c, true) };
}
