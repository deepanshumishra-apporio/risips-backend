// FP reply models (src/integrations/fp.schemas.ts): FP's documented examples pass, replies the money flows can't use are
// refused, and drift in a field we don't depend on is let through.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  RISIPS_ENV: '/nonexistent/.env', FP_SANDBOX_CLIENT_ID: 'x', FP_SANDBOX_CLIENT_SECRET: 'x', FP_PV_SANDBOX_CLIENT_ID: 'x', FP_PV_SANDBOX_CLIENT_SECRET: 'x',
  RISIPS_STATE_DIR: (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'risips-fpschema-')),
  LOG_LEVEL: 'error',
});
const m = await import('../src/integrations/fp.schemas.ts');
const { asModel, asModelOrNull, FpError } = await import('../src/integrations/fp.client.ts');
const { handleEvent } = await import('../src/services/webhook.service.ts');

// The examples on fintechprimitives.com/docs/api (2026-10-28), trimmed to the fields that matter here.
const purchase = {
  object: 'mf_purchase', id: 'mfp_177177219f634373b01072986d2eea7d', old_id: 9123, mf_investment_account: 'mfia_367a75826694614a539c0f82b196027',
  folio_number: '31171511', state: 'pending', amount: 10000.0, scheme: 'INF173K01FE6', gateway: 'rta', traded_on: null, scheduled_on: '2020-04-07',
  created_at: '2020-04-06T15:32:52+05:30', succeeded_at: null, plan: null, failure_code: null, type: 'additional_purchase', allotted_units: null,
  purchased_amount: null, purchased_price: null,
};
const redemption = {
  object: 'mf_redemption', id: 'mfr_15f8d86bae614801bab5accaed131abc', old_id: 6597, folio_number: '15075102', state: 'pending', amount: 10000.0,
  scheme: 'INF173K01FQ0', redemption_mode: 'normal', units: null, redeemed_units: null, redeemed_amount: null, gateway: 'rta',
};
const sw = {
  object: 'mf_switch', id: 'mfs_b1aba06d52184619151d3b82efa65de6', old_id: 16586, state: 'pending', amount: 1000.0, units: null,
  switch_out_scheme: 'INF173K01FE6', switch_in_scheme: 'INF173K02FE5', switched_in_units: null, source_ref_id: null,
};
const plan = {
  object: 'mf_purchase_plan', id: 'mfpp_a2d956440b354dcfaceadb8ac25e5d60', folio_number: null, scheme: 'INF109K01TP7', amount: 21.0, systematic: true,
  frequency: 'daily', installment_day: null, number_of_installments: 6, state: 'review_completed', payment_method: 'mandate', payment_source: '3',
  gateway: 'ondc', reason: null, consent: { email: null, isd_code: null, mobile: null, otp: null },
};

describe('FP models', () => {
  it("accept FP's documented examples, and keep fields they don't model", () => {
    const ok = [
      [m.MfPurchase, purchase], [m.MfRedemption, redemption], [m.MfSwitch, sw], [m.MfPurchasePlan, plan],
      [m.MfRedemptionPlan, { id: 'mfrp_dbabb25ba34c48329dbfbeff70c846f0', state: 'created', installment_day: 1, amount: 1000.0 }],
      [m.MfSwitchPlan, { id: 'mfsp_dbabb25ba34c48329dbfbeff70c846f0', state: 'active', switch_in_scheme: 'INF204KA1B64' }],
      [m.CheckoutPayment, { id: 1, token_url: 'https://tenant.s.finprim.com/api/pg/payments/netbanking/razorpay?txnId=d1c3' }],
      [m.FpMandate, { id: 1, mandate_status: 'APPROVED', mandate_limit: 100000, umrn: null }],
      [m.listOf(m.MfPurchase), { object: 'list', data: [purchase, { ...purchase, id: 'mfp_2', state: 'successful' }] }],
      // decimals as strings, as the holdings report sends them; and nothing allotted yet
      [m.HoldingsReport, { folios: [{ folio_number: '15075102', schemes: [{ isin: 'INF173K01FQ0', market_value: { amount: '497.91', redeemable_amount: '297.91' } }] }] }],
      [m.HoldingsReport, {}],
    ] as const;
    for (const [model, reply] of ok) {
      assert.equal(model.full.safeParse(reply).success, true, model.name);
      assert.equal(asModel(model as never, reply), reply, `${model.name}: returned unchanged`);
    }
    const kept = asModel(m.MfPurchase, { ...purchase, something_new: 1 });
    assert.equal(kept.something_new, 1);
  });

  it('refuse a reply the flow cannot use: no id, the wrong kind of id, no state, a checkout with no link', () => {
    const bad = [
      [m.MfPurchase, { ...purchase, id: undefined }],
      [m.MfPurchase, { ...purchase, id: 'mfr_15f8d86bae614801' }],
      [m.MfRedemption, { ...redemption, state: undefined }],
      [m.CheckoutPayment, { id: 1 }],
      [m.CheckoutPayment, { id: 1, token_url: 'not a url' }],
      [m.listOf(m.MfPurchasePlan), { data: [plan, { ...plan, id: null }] }],
      [m.MfPurchase, '<html>Bad gateway</html>'],
    ] as const;
    for (const [model, reply] of bad) {
      assert.throws(() => asModel(model as never, reply), (e: unknown) => e instanceof FpError && e.malformed, model.name);
      assert.equal(asModelOrNull(model as never, reply), null);
    }
  });

  it('let a mismatch in an optional field through (FP changes shapes without notice)', () => {
    const odd = { ...purchase, state: 'some_new_state', amount: '10000.00', folio_number: 31171511 };
    assert.equal(m.MfPurchase.full.safeParse(odd).success, false, 'the documented shape is not met');
    assert.equal(asModel(m.MfPurchase, odd), odd, 'but the order goes through');
  });

  it('tell the investor to look before retrying when a reply is malformed', () => {
    try {
      asModel(m.CheckoutPayment, { id: 1 });
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof FpError);
      assert.match(e.userMessage, /check Orders before trying again/);
      assert.equal(e.unreachable, false);
    }
  });
});

describe('webhook events', () => {
  it('ignore events without a usable object id, without calling FP', async () => {
    for (const body of [null, 'x', {}, { data: {} }, { data: { object: { id: 42 } } }, { data: { object: { id: '../../admin' } } }]) {
      assert.equal(await handleEvent(body), 'no object id');
    }
  });
});
