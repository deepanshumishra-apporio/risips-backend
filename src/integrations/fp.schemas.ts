// Shapes of the FintechPrimitives objects the money flows read: orders, plans, payments, mandates, skip instructions,
// the holdings report and webhook events. Taken from FP's API reference (fintechprimitives.com/docs/api, read
// 2026-10-28) plus the fields seen live on the ONDC tenant that the reference leaves out (under_review /
// review_completed states, switch_in_folio_number, payment_reference).
//
// Each model has two schemas:
// - `core`: the few fields the code can't work without (an order's id and state, a payment's token_url). A reply
//   without them is an FpError: carrying on would save a broken order or send the investor to no checkout.
// - `full`: every documented field. A mismatch here is only logged once (FP changes shapes without notice, and an
//   order FP already accepted must not fail over, say, a number sent as a string). Its type is what callers see.
// Both are loose: fields we don't model are kept, so the stored FP object stays complete.
import { z } from 'zod';

/** A model of one FP reply. T is the type callers get; the reply itself is returned unchanged. */
export interface FpModel<T> { name: string; core: z.ZodType; full: z.ZodType<T> }

function model<C extends z.ZodRawShape, R extends z.ZodRawShape>(name: string, core: C, rest: R) {
  // `rest` may narrow a core field (state: any string at runtime, the known states in the type)
  const shape = { ...core, ...rest } as Omit<C, keyof R> & R;
  return { name, core: z.looseObject(core), full: z.looseObject(shape) };
}

/** A list reply: `{ data: [...] }` (FP's list and batch endpoints). */
export function listOf<T>(m: FpModel<T>): FpModel<{ data: T[]; [k: string]: unknown }> {
  return {
    name: `${m.name} list`,
    core: z.looseObject({ data: z.array(m.core) }),
    full: z.looseObject({ data: z.array(m.full) }),
  };
}

// FP sends null for anything not yet known (folio before allotment, units before trade, ...).
const str = z.string().nullish();
const num = z.number().nullish();
/** Some FP reports send decimals as strings ("1234.56"); callers wrap these in Number(). */
const numLike = z.union([z.number(), z.string()]).nullish();
/** An ISO timestamp or yyyy-mm-dd date. */
const time = z.string().nullish();

// ---------- states ----------

/** Purchase / redemption / switch states. under_review is ONDC only. */
export const ORDER_STATES = ['under_review', 'pending', 'confirmed', 'submitted', 'successful', 'failed', 'cancelled', 'reversed'] as const;
export type FpOrderState = typeof ORDER_STATES[number];

/** Plan states: FP's documented five plus the ONDC review steps and the confirm / submit hops seen live. */
export const PLAN_STATES = ['created', 'under_review', 'review_completed', 'confirmed', 'submitted', 'active', 'cancelled', 'completed', 'failed'] as const;
export type FpPlanState = typeof PLAN_STATES[number];

const orderState = z.enum(ORDER_STATES);
const planState = z.enum(PLAN_STATES);

// ---------- one-time orders ----------

const orderCommon = {
  object: str,
  mf_investment_account: str,
  folio_number: str,
  amount: num,
  plan: str,
  gateway: str,
  traded_on: time,
  scheduled_on: time,
  created_at: time,
  confirmed_at: time,
  submitted_at: time,
  succeeded_at: time,
  failed_at: time,
  reversed_at: time,
  cancelled_at: time,
  source_ref_id: str,
  user_ip: str,
  server_ip: str,
  initiated_by: str,
  initiated_via: str,
  euin: str,
  partner: str,
  /** payment_failure, order_expiry, order_failure_at_gateway, pan_kyc_incomplete, fp_payment_url_unused, ... */
  failure_code: str,
};

export const MfPurchase = model('mf_purchase', {
  id: z.string().startsWith('mfp_'),
  state: z.string(),
}, {
  ...orderCommon,
  state: orderState,
  /** Payments take this numeric id (amc_order_ids). Always present, but checked where it is used, not here: the order
   *  exists at FP by the time we read it, and must be saved even if this field ever goes missing. */
  old_id: z.number(),
  scheme: str,
  /** purchase (new folio) or additional_purchase */
  type: str,
  allotted_units: num,
  purchased_amount: num,
  purchased_price: num,
  allotted_nav_date: time,
  retried_at: time,
});
export type MfPurchase = z.infer<typeof MfPurchase.full>;

export const MfRedemption = model('mf_redemption', {
  id: z.string().startsWith('mfr_'),
  state: z.string(),
}, {
  ...orderCommon,
  state: orderState,
  old_id: num,
  scheme: str,
  units: num,
  redemption_mode: str,
  redeemed_units: num,
  redeemed_amount: num,
  redeemed_price: num,
  redeemed_nav_date: time,
  redemption_bank_account_number: str,
  redemption_bank_account_ifsc_code: str,
});
export type MfRedemption = z.infer<typeof MfRedemption.full>;

export const MfSwitch = model('mf_switch', {
  id: z.string().startsWith('mfs_'),
  state: z.string(),
}, {
  ...orderCommon,
  state: orderState,
  old_id: num,
  units: num,
  switch_out_scheme: str,
  switch_in_scheme: str,
  /** Not in FP's reference; set on ONDC once the switch-in is allotted. */
  switch_in_folio_number: str,
  switched_out_units: num,
  switched_out_amount: num,
  switched_out_price: num,
  switched_in_units: num,
  switched_in_amount: num,
  switched_in_price: num,
});
export type MfSwitch = z.infer<typeof MfSwitch.full>;

// ---------- plans (SIP, SWP, STP) ----------

const consent = z.looseObject({ email: str, isd_code: str, mobile: str }).nullish();

const planCommon = {
  object: str,
  state: planState,
  mf_investment_account: str,
  folio_number: str,
  amount: num,
  systematic: z.boolean().nullish(),
  frequency: str,
  installment_day: num,
  number_of_installments: num,
  remaining_installments: num,
  auto_generate_installments: z.boolean().nullish(),
  requested_activation_date: time,
  start_date: time,
  end_date: time,
  next_installment_date: time,
  previous_installment_date: time,
  source_ref_id: str,
  partner: str,
  gateway: str,
  euin: str,
  user_ip: str,
  server_ip: str,
  initiated_by: str,
  initiated_via: str,
  created_at: time,
  activated_at: time,
  cancelled_at: time,
  cancellation_scheduled_on: time,
  completed_at: time,
  failed_at: time,
  /** Why FP failed the plan (free text). */
  reason: str,
  consent,
};

export const MfPurchasePlan = model('mf_purchase_plan', {
  id: z.string().startsWith('mfpp_'),
  state: z.string(),
}, {
  ...planCommon,
  scheme: str,
  /** mandate (SIP) */
  payment_method: str,
  /** The mandate id, as a string. */
  payment_source: str,
  purpose: str,
  cancellation_code: str,
  auto_cancelled: z.boolean().nullish(),
});
export type MfPurchasePlan = z.infer<typeof MfPurchasePlan.full>;

export const MfRedemptionPlan = model('mf_redemption_plan', {
  id: z.string().startsWith('mfrp_'),
  state: z.string(),
}, {
  ...planCommon,
  scheme: str,
});
export type MfRedemptionPlan = z.infer<typeof MfRedemptionPlan.full>;

export const MfSwitchPlan = model('mf_switch_plan', {
  id: z.string().startsWith('mfsp_'),
  state: z.string(),
}, {
  ...planCommon,
  switch_in_scheme: str,
  switch_out_scheme: str,
});
export type MfSwitchPlan = z.infer<typeof MfSwitchPlan.full>;

/** A pause: FP skip instruction on a purchase or redemption plan. */
export const SkipInstruction = model('skip instruction', {
  // only the id is needed to save it: a missing state must not stop a pause or a SIP change half-way
  id: z.string(),
}, {
  state: str,
  /** PENDING, ACTIVE, CANCELLATION_REQUESTED, CANCELLED, ... */
  from_date: time,
  to_date: time,
  remaining_installments: num,
  skipped_installments: num,
});
export type SkipInstruction = z.infer<typeof SkipInstruction.full>;

// ---------- payments and mandates ----------

/** POST /api/pg/payments/netbanking: the checkout the investor must open. */
export const CheckoutPayment = model('netbanking payment', {
  id: z.number(),
  token_url: z.url(),
}, {
  status: str,
});
export type CheckoutPayment = z.infer<typeof CheckoutPayment.full>;

/** POST /api/pg/payments/nach: a mandate debit. */
export const NachPayment = model('nach payment', { id: z.number() }, { status: str });
export type NachPayment = z.infer<typeof NachPayment.full>;

/** GET /api/pg/payments/:id */
export const Payment = model('payment', {
  id: z.number(),
}, {
  /** PENDING, SUCCESS, FAILED, REJECTED, ... (NACH has its own set) */
  status: str,
  payment_type: str,
  method: str,
  amount: num,
  amc_order_ids: z.array(z.number()).nullish(),
  /** Not in FP's reference: the gateway reference (pay_...) once the investor has paid. */
  payment_reference: str,
  provider_name: str,
  failure_code: str,
  failed_reason: str,
  from_bank_account_id: num,
  debit_date: time,
  created_at: time,
  submitted_at: time,
  debit_confirmed_at: time,
  failed_at: time,
  settled_at: time,
  late_auth: z.boolean().nullish(),
  refund_status: str,
});
export type Payment = z.infer<typeof Payment.full>;

/** GET /api/pg/mandates/:id (POST returns just { id }). */
export const FpMandate = model('mandate', {
  id: z.number(),
}, {
  bank_account_id: num,
  mandate_ref: str,
  mandate_token: str,
  valid_from: time,
  valid_to: time,
  mandate_limit: num,
  /** E_MANDATE, UPI */
  mandate_type: str,
  /** CREATED, RECEIVED, SUBMITTED, APPROVED, REJECTED, CANCELLED */
  mandate_status: str,
  umrn: str,
  rejected_reason: str,
  provider_name: str,
  created_at: time,
  approved_at: time,
  rejected_at: time,
  cancelled_at: time,
});
export type FpMandate = z.infer<typeof FpMandate.full>;

export const CreatedMandate = model('created mandate', { id: z.number() }, {});

/** POST /api/pg/payments/emandate/auth: the authorisation page for a mandate. */
export const MandateAuth = model('mandate authorisation', { token_url: z.url() }, {});

// ---------- investor account ----------

/** POST /v2/related_parties: a nominee (or other related person) on an investor profile. */
export const RelatedParty = model('related party', { id: z.string().startsWith('relp_') }, { name: str, relationship: str, date_of_birth: time });
export type RelatedParty = z.infer<typeof RelatedParty.full>;

/**
 * GET /v2/mf_investment_accounts/:id. `folio_defaults` holds the ids FP copies into every folio opened from now on
 * (communication contacts, payout bank, nominees); a PATCH of it does not reach existing folios.
 */
export const MfInvestmentAccount = model('mf investment account', {
  id: z.string().startsWith('mfia_'),
  folio_defaults: z.record(z.string(), z.unknown()).nullish(),
}, {
  old_id: num,
  primary_investor: str,
  holding_pattern: str,
});
export type MfInvestmentAccount = z.infer<typeof MfInvestmentAccount.full>;

// ---------- holdings ----------

const value = z.looseObject({ amount: numLike, as_on: time }).nullish();

/** GET /api/oms/reports/holdings?folios=... An investor with nothing allotted may get no folios at all, so callers read
 *  `folios ?? []`; a scheme line without an ISIN can't be matched to anything and is refused. */
export const HoldingsReport = model('holdings report', {
  folios: z.array(z.looseObject({ schemes: z.array(z.looseObject({ isin: z.string() })).nullish() })).nullish(),
}, {
  folios: z.array(z.looseObject({
    folio_number: z.string(),
    schemes: z.array(z.looseObject({
      isin: z.string(),
      name: str,
      holdings: z.looseObject({ units: numLike, redeemable_units: numLike, as_on: time }).nullish(),
      market_value: z.looseObject({ amount: numLike, redeemable_amount: numLike, as_on: time }).nullish(),
      invested_value: value,
      nav: z.looseObject({ value: numLike, as_on: time }).nullish(),
    })).nullish(),
  })).nullish(),
});
export type HoldingsReport = z.infer<typeof HoldingsReport.full>;

// ---------- webhooks ----------

/** FP's event: { id: "evt_…", type: "mf_purchase.successful", data: { object: { id, … } }, time }. Unsigned. */
export const FpEvent = z.looseObject({
  // only data.object.id is relied on; id and type are logged as they come
  id: z.unknown(),
  type: z.unknown(),
  data: z.looseObject({ object: z.looseObject({ id: z.string().regex(/^[a-z]+_[A-Za-z0-9]{1,64}$/) }) }),
});
export type FpEvent = z.infer<typeof FpEvent>;

// ---------- what an order row keeps ----------

/** T's named fields only (Omit on a loose object's index signature would drop every named field). */
type Known<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
/** Optional and nullable: a field one kind requires (a purchase's old_id) is absent or null on another. */
type Fields<T> = { [K in keyof Omit<Known<T>, 'object' | 'state'>]?: Known<T>[K] | null };
/**
 * orders.data.fp: the last FP object for the row, whichever kind it is (purchase, redemption, switch or one of the
 * three plans). Every documented field of every kind, all optional; rows written before this type existed match it.
 */
export type StoredFp = Fields<MfPurchase> & Fields<MfRedemption> & Fields<MfSwitch>
  & Fields<MfPurchasePlan> & Fields<MfRedemptionPlan> & Fields<MfSwitchPlan>
  & { id?: string; object?: string | null; state?: string }
  // fields FP sent that aren't modelled are kept too; read them as unknown and check the type
  & { [k: string]: unknown };

/** An order or plan read from FP, of any kind. */
export type FpOrderObject = MfPurchase | MfRedemption | MfSwitch | MfPurchasePlan | MfRedemptionPlan | MfSwitchPlan;
