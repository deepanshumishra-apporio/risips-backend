// Pure functions: PII redaction, validation schemas, the error handler's output for FP failures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  RISIPS_ENV: '/nonexistent/.env', FP_SANDBOX_CLIENT_ID: 'x', FP_SANDBOX_CLIENT_SECRET: 'x', FP_PV_SANDBOX_CLIENT_ID: 'x', FP_PV_SANDBOX_CLIENT_SECRET: 'x',
  RISIPS_STATE_DIR: (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'risips-unit-')),
  LOG_LEVEL: 'error',
});
const { redact } = await import('../src/utils/redact.ts');
const { onboardingSchemas } = await import('../src/validation/onboarding.validation.ts');
const { authSchemas } = await import('../src/validation/auth.validation.ts');
const { ordersSchemas } = await import('../src/validation/orders.validation.ts');
const { errorHandler } = await import('../src/middleware/errorHandler.ts');
const { FpError } = await import('../src/integrations/fp.client.ts');

describe('redact', () => {
  it('masks PAN, bank, phone, email and secrets, deep inside objects', () => {
    const out = redact({
      pan: { value: 'ABCPX1234K' }, first_tax_residency: { taxid_number: 'ABCPX1234K' },
      bank_accounts: [{ value: { account_number: '50100123451195', ifsc_code: 'HDFC0000001' } }],
      number: 9876543210, email: 'a.person@example.com', access_token: 'abc', amount: 1000, nav: { value: 12.34 },
    }) as Record<string, any>;
    const s = JSON.stringify(out);
    for (const secret of ['ABCPX1234K', '50100123451195', '9876543210', 'a.person@example.com', '"abc"']) assert.ok(!s.includes(secret), secret);
    assert.equal(out.amount, 1000);
    assert.equal(out.nav.value, 12.34, 'a NAV value is not personal');
    assert.equal(out.bank_accounts[0].value.ifsc_code, 'HDFC0000001');
  });
});

describe('validation schemas', () => {
  it('accepts an individual PAN and normalises it', () => {
    const r = onboardingSchemas.pan.body.parse({ pan: ' abcpx1234k ', name: 'Ravi  Kumar', dob: '1990-04-12' });
    assert.deepEqual(r, { pan: 'ABCPX1234K', name: 'Ravi Kumar', dob: '1990-04-12' });
  });
  it('rejects a company PAN, an impossible date, a bad name', () => {
    assert.equal(onboardingSchemas.pan.body.safeParse({ pan: 'ABCCX1234K', name: 'Ravi Kumar', dob: '1990-04-12' }).success, false);
    assert.equal(onboardingSchemas.pan.body.safeParse({ pan: 'ABCPX1234K', name: 'Ravi Kumar', dob: '1990-02-31' }).success, false);
    assert.equal(onboardingSchemas.pan.body.safeParse({ pan: 'ABCPX1234K', name: 'R2D2', dob: '1990-04-12' }).success, false);
  });
  it('normalises mobile numbers and refuses repeated digits', () => {
    assert.equal(authSchemas.mobileStart.body.parse({ mobile: '+91 98765-43210' }).mobile, '9876543210');
    assert.equal(authSchemas.mobileStart.body.safeParse({ mobile: '9999999999' }).success, false);
    assert.equal(authSchemas.mobileStart.body.safeParse({ mobile: '1234567890' }).success, false);
  });
  it('needs an amount unless the whole holding is redeemed', () => {
    const base = { isin: 'INF109KC19T7', folio: '9LCKSUCHPHR4Y' };
    assert.equal(ordersSchemas.redeem.body.safeParse(base).success, false);
    assert.equal(ordersSchemas.redeem.body.safeParse({ ...base, all: true }).success, true);
    assert.equal(ordersSchemas.redeem.body.parse({ ...base, amount: '500' }).amount, 500);
    assert.equal(ordersSchemas.redeem.body.safeParse({ ...base, amount: -5 }).success, false);
  });
  it('requires the nominee fields unless skipped', () => {
    assert.equal(onboardingSchemas.nominee.body.safeParse({ skip: true, otp: '123456' }).success, true);
    const r = onboardingSchemas.nominee.body.safeParse({ name: 'Sita Verma', dob: '1965-06-01', relationship: 'aunt', pan: 'ABCPV1234K' });
    assert.equal(r.success, false);
    assert.equal(r.error!.issues[0].message, 'Select the relationship.');
  });
});

describe('error handler', () => {
  it("gives the investor FP's message but never FP's raw reply", () => {
    let status = 0;
    let body: unknown;
    const res = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
    const err = new FpError('POST /v2/mf_purchases failed (HTTP 400)', 400, { error: { message: 'amount is less than the min switch in amount', internal: 'secret stack' } });
    errorHandler(err, { id: 'r1', method: 'POST', path: '/x' } as never, res as never, () => {});
    assert.equal(status, 502);
    assert.deepEqual(body, { error: 'amount is less than the min switch in amount' });
  });
  it('hides internal errors behind a generic 500', () => {
    let body: unknown;
    const res = { status() { return this; }, json(b: unknown) { body = b; return this; } };
    errorHandler(new Error('SQLITE_CORRUPT: details'), { id: 'r2', method: 'GET', path: '/y' } as never, res as never, () => {});
    assert.deepEqual(body, { error: 'Something went wrong. Please try again.' });
  });
});
