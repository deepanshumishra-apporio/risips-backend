// Admin API: key, read-only, masking, filters, audit log.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { signUp, startServer, testDb } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const KEY = 'test-admin-key-0123456789abcdef';
let t: TestServer;
const admin = (p: string, method = 'GET', key: string | null = KEY) =>
  t.call(method, p, method === 'GET' ? undefined : {}, null, { ...(key ? { 'x-admin-key': key } : {}), 'x-admin-actor': 'ops@example.com' });

let uid: number;
before(async () => {
  t = await startServer({ RATE_LIMIT_SCALE: '100', ADMIN_API_KEY: KEY, ADMIN_API_ALLOWED_IPS: '127.0.0.1' });
  uid = (await signUp(t, 'admin-subject@example.com')).user.id as number;
  const db = await testDb();
  await db.run(`UPDATE users SET mobile = '9876543210', data = data || $2::jsonb WHERE id = $1`, [uid, JSON.stringify({
    name: 'Asha Rao', pan: 'ABCPR1234Z', bank: { account_number: '123456789012', ifsc: 'HDFC0000001', verified: true },
    aadhaar_last4: '4321',
  })]);
  await db.run("INSERT INTO orders (id, user_id, kind, isin, amount, state, data) VALUES ('mfp_adm1', $1, 'purchase', 'INF109KC19T7', 500, 'successful', $2::jsonb)",
    [uid, JSON.stringify({ token_url: 'https://pay.example/secret', fp: { folio_number: 'F9' } })]);
  await db.run("INSERT INTO orders (id, user_id, kind, isin, amount, state, data) VALUES ('mfpp_adm1', $1, 'sip', 'INF109KC19T7', 100, 'active', '{}')", [uid]);
});
after(async () => { await t.close(); });

describe('admin API access', () => {
  it('needs the key', async () => {
    assert.equal((await admin('/admin/v1/summary', 'GET', null)).status, 401);
    assert.equal((await admin('/admin/v1/summary', 'GET', 'wrong-key')).status, 401);
    assert.equal((await admin('/admin/v1/summary')).status, 200);
  });

  it('is read-only', async () => {
    assert.equal((await admin('/admin/v1/orders', 'POST')).status, 405);
    assert.equal((await admin('/admin/v1/investors/1', 'DELETE')).status, 405);
  });

  it('does not accept an investor session instead of the key', async () => {
    const { token } = await signUp(t);
    assert.equal((await t.call('GET', '/admin/v1/summary', undefined, token)).status, 401);
  });

  it('logs every call with the actor', async () => {
    await admin('/admin/v1/summary');
    const file = path.join(t.stateDir, 'logs', 'admin_api.log');
    for (let i = 0; i < 20 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.find((l) => l.path === '/admin/v1/summary' && l.status === 200);
    assert.ok(last, 'a log line for the call');
    assert.equal(last.actor, 'ops@example.com');
    assert.equal(last.method, 'GET');
  });
});

describe('admin API data', () => {
  it('summarises investors and orders', async () => {
    const r = await admin('/admin/v1/summary');
    const j = r.json! as { investors: { total: number }; orders: Record<string, Record<string, { count: number }>> };
    assert.ok(j.investors.total >= 1);
    assert.equal(j.orders.purchase.successful.count, 1);
    assert.equal(j.orders.sip.active.count, 1);
  });

  it('lists and finds investors, with the PAN masked', async () => {
    const r = await admin('/admin/v1/investors?q=asha');
    const j = r.json! as { total: number; data: Record<string, unknown>[] };
    assert.equal(j.total, 1);
    assert.equal(j.data[0].id, uid);
    assert.equal(j.data[0].pan_masked, '*******34Z');
    assert.equal(j.data[0].orders, 1);
    assert.equal(j.data[0].plans, 1);
    assert.ok(!JSON.stringify(j).includes('ABCPR1234Z'), 'full PAN never leaves');
  });

  it('shows one investor without full PAN, bank account or payment links', async () => {
    const r = await admin(`/admin/v1/investors/${uid}`);
    assert.equal(r.status, 200);
    const body = JSON.stringify(r.json);
    for (const secret of ['ABCPR1234Z', '123456789012', 'pay.example', 'pin_hash']) assert.ok(!body.includes(secret), secret);
    const inv = r.json!.investor as { bank: { account_masked: string }; aadhaar_masked: string };
    assert.equal(inv.bank.account_masked, '********9012');
    assert.equal(inv.aadhaar_masked, 'XXXX XXXX 4321');
    assert.equal((r.json!.orders as unknown[]).length, 1);
    assert.equal((r.json!.sips as unknown[]).length, 1);
  });

  it('404s an unknown or malformed investor id', async () => {
    assert.equal((await admin('/admin/v1/investors/999999')).status, 404);
    assert.equal((await admin('/admin/v1/investors/abc')).status, 404);
    assert.equal((await admin('/admin/v1/investors/99999999999')).status, 404);
  });

  it('filters orders and validates the filters', async () => {
    const all = (await admin(`/admin/v1/orders?user_id=${uid}`)).json! as { total: number; data: { kind: string }[] };
    assert.equal(all.total, 2);
    const sips = (await admin(`/admin/v1/orders?user_id=${uid}&kind=sip`)).json! as { total: number; data: { kind: string }[] };
    assert.deepEqual(sips.data.map((o) => o.kind), ['sip']);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(((await admin(`/admin/v1/orders?user_id=${uid}&from=${today}&to=${today}`)).json! as { total: number }).total, 2);
    assert.equal(((await admin(`/admin/v1/orders?user_id=${uid}&to=2000-01-01`)).json! as { total: number }).total, 0);
    assert.equal((await admin('/admin/v1/orders?from=2026-02-31')).status, 400);
    assert.equal((await admin('/admin/v1/orders?user_id=-4')).status, 400);
    assert.equal((await admin('/admin/v1/orders?kind=bogus')).status, 400);
    assert.equal((await admin('/admin/v1/orders?kind=')).status, 200, 'an empty filter is no filter');
    const paged = (await admin('/admin/v1/orders?limit=1&offset=0')).json! as { limit: number; data: unknown[] };
    assert.equal(paged.limit, 1);
    assert.equal(paged.data.length, 1);
    assert.equal(((await admin('/admin/v1/orders?limit=5000')).json! as { limit: number }).limit, 200);
  });

  it('shows one order without its payment link', async () => {
    const r = await admin('/admin/v1/orders/mfp_adm1');
    assert.equal(r.status, 200);
    assert.equal(r.json!.id, 'mfp_adm1');
    assert.equal(r.json!.user_id, uid);
    assert.ok(!('token_url' in r.json!));
    assert.equal((await admin('/admin/v1/orders/mfp_nope')).status, 404);
  });
});
