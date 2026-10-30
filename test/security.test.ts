// HTTP-level security: headers, body limits, error shapes, sessions, OTP storage, signed file links.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pngDataUrl, signUp, startServer, testDb } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let t: TestServer;
before(async () => { t = await startServer({ RATE_LIMIT_SCALE: '100' }); });
after(async () => { await t.close(); });

describe('headers', () => {
  it('sets security headers, a request id, and hides Express', async () => {
    const r = await t.call('GET', '/health');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.match(r.headers.get('x-request-id') || '', /^[a-f0-9]{16}$/);
  });

  it('marks personal-data responses as not cacheable', async () => {
    const { token } = await signUp(t);
    const r = await t.call('GET', '/onb/kyc-form', undefined, token);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

describe('one mobile per account', () => {
  it('refuses a mobile another account verified, in any format', async () => {
    const mobile = `9${String(Date.now()).slice(-9)}`;
    const a = await signUp(t);
    const s = await t.call('POST', '/auth/mobile/start', { mobile }, a.token);
    assert.equal((await t.call('POST', '/auth/mobile/verify', { mobile, code: s.json!.dev_otp }, a.token)).status, 200);
    const b = await signUp(t);
    for (const m of [mobile, `+91${mobile}`, `0${mobile}`]) {
      const r = await t.call('POST', '/auth/mobile/start', { mobile: m }, b.token);
      assert.equal(r.status, 409, m);
      assert.equal(r.json!.reason, 'mobile_taken');
      assert.equal(r.json!.dev_otp, undefined, 'no code sent');
    }
    // the owner's own number is not "taken" (a 429 here is only the 30 s gap between codes)
    assert.notEqual((await t.call('POST', '/auth/mobile/start', { mobile }, a.token)).json!.reason, 'mobile_taken');
  });
});

describe('request bodies and errors', () => {
  it('answers 404 JSON for unknown routes', async () => {
    const r = await t.call('GET', '/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'Not found' });
  });

  it('rejects malformed JSON with 400', async () => {
    const r = await t.call('POST', '/auth/email/start', '{bad json');
    assert.equal(r.status, 400);
    assert.equal(r.json!.error, 'The request body is not valid JSON.');
  });

  it('rejects bodies over 100 KB with 413', async () => {
    const r = await t.call('POST', '/auth/email/start', { email: 'a@b.com', pad: 'x'.repeat(120_000) });
    assert.equal(r.status, 413);
  });

  it('returns validation errors with the message, reason and fields', async () => {
    const r = await t.call('POST', '/auth/email/start', { email: 'not-an-email' });
    assert.equal(r.status, 400);
    assert.equal(r.json!.error, 'Enter a valid email address.');
    assert.equal(r.json!.reason, 'validation');
    assert.deepEqual(r.json!.fields, { email: 'Enter a valid email address.' });
  });

  it('requires a session on investor routes', async () => {
    for (const p of ['/me', '/portfolio', '/orders', '/sips', '/cart', '/settings/devices']) {
      const r = await t.call('GET', p);
      assert.equal(r.status, 401, p);
    }
    assert.equal((await t.call('GET', '/me', undefined, 'garbage token with spaces')).status, 401);
  });
});

describe('sessions', () => {
  it('stores only a hash of the session token', async () => {
    const { token } = await signUp(t);
    const rows = await (await testDb()).all('SELECT * FROM sessions');
    assert.ok(rows.length > 0);
    for (const row of rows) assert.ok(!Object.values(row).includes(token), 'plain token found in the sessions table');
    assert.equal((await t.call('GET', '/me', undefined, token)).status, 200);
  });

  it('ends a session after the idle limit', async () => {
    const { token } = await signUp(t);
    await (await testDb()).run("UPDATE sessions SET last_seen = now() - interval '31 days', created_at = now() - interval '31 days'");
    assert.equal((await t.call('GET', '/me', undefined, token)).status, 401);
  });

  it('logout ends the session', async () => {
    const { token } = await signUp(t);
    assert.equal((await t.call('POST', '/auth/logout', {}, token)).status, 200);
    assert.equal((await t.call('GET', '/me', undefined, token)).status, 401);
  });
});

describe('OTPs', () => {
  it('stores codes hashed, and a code works once', async () => {
    const email = `otp${Date.now()}@example.com`;
    const start = await t.call('POST', '/auth/email/start', { email });
    const code = start.json!.dev_otp as string;
    const row = (await (await testDb()).get('SELECT * FROM otps WHERE target = $1', [email]))!;
    assert.ok(!Object.values(row).includes(code), 'plain OTP found in the otps table');
    assert.equal((await t.call('POST', '/auth/email/verify', { email, code })).status, 200);
    const again = await t.call('POST', '/auth/email/verify', { email, code });
    assert.equal(again.status, 400);
    assert.equal(again.json!.reason, 'missing');
  });

  it('locks a code after 5 wrong tries', async () => {
    const email = `lock${Date.now()}@example.com`;
    const start = await t.call('POST', '/auth/email/start', { email });
    const wrong = start.json!.dev_otp === '0000' ? '1111' : '0000';
    for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/auth/email/verify', { email, code: wrong })).json!.reason, 'wrong');
    const r = await t.call('POST', '/auth/email/verify', { email, code: start.json!.dev_otp });
    assert.equal(r.json!.reason, 'locked');
  });
});

describe('PIN', () => {
  it('ends the session after 5 wrong PINs', async () => {
    const { token } = await signUp(t);
    assert.equal((await t.call('POST', '/auth/pin/set', { pin: '2468' }, token)).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await t.call('POST', '/auth/pin/verify', { pin: '1357' }, token)).status, 400);
    const r = await t.call('POST', '/auth/pin/verify', { pin: '1357' }, token);
    assert.equal(r.status, 401);
    assert.equal(r.json!.reason, 'pin_locked');
    assert.equal((await t.call('GET', '/me', undefined, token)).status, 401);
  });
});

describe('selfie and signature files', () => {
  it('serves an image only through its signed link', async () => {
    const { token } = await signUp(t);
    const up = await t.call('POST', '/onb/selfie', { image: pngDataUrl() }, token);
    assert.equal(up.status, 200);
    const url = (up.json!.user as Record<string, string>).selfie_url;
    assert.match(url, /^\/files\/\d+_selfie_[a-f0-9]{32}\.png\?exp=\d+&sig=[a-f0-9]{64}$/);
    assert.equal((await t.call('GET', url)).status, 200);
    assert.equal((await t.call('GET', url.split('?')[0])).status, 404, 'unsigned link');
    assert.equal((await t.call('GET', url.replace(/sig=./, 'sig=0'))).status, 404, 'tampered signature');
    assert.equal((await t.call('GET', url.replace(/exp=\d+/, 'exp=1000000000'))).status, 404, 'expired / altered expiry');
  });

  it('rejects data that is not really a PNG / JPEG', async () => {
    const { token } = await signUp(t);
    const fake = `data:image/png;base64,${Buffer.alloc(800, 1).toString('base64')}`;
    const r = await t.call('POST', '/onb/selfie', { image: fake }, token);
    assert.equal(r.status, 400);
    assert.equal(r.json!.error, 'Invalid image.');
  });
});

describe('ownership', () => {
  it("can't read another investor's order or plan", async () => {
    const a = await signUp(t);
    const db = await testDb();
    await db.run("INSERT INTO orders (id, user_id, kind, isin, amount, state, data) VALUES ('mfp_owneda', $1, 'purchase', 'INF109KC19T7', 100, 'successful', '{}')", [a.user.id as number]);
    await db.run("INSERT INTO orders (id, user_id, kind, isin, amount, state, data) VALUES ('mfpp_owneda', $1, 'sip', 'INF109KC19T7', 100, 'cancelled', '{}')", [a.user.id as number]);
    const b = await signUp(t);
    assert.equal((await t.call('GET', '/orders/mfp_owneda', undefined, b.token)).status, 404);
    assert.equal((await t.call('POST', '/sips/mfpp_owneda/cancel', { otp: '123456' }, b.token)).status, 404);
  });
});

describe('webhook', () => {
  it('hides the endpoint without the right token', async () => {
    assert.equal((await t.call('POST', '/fp/webhook/wrong-token', {})).status, 404);
  });
});

describe('demo-only routes', () => {
  it('serves the API log in demo mode only to signed-in users', async () => {
    assert.equal((await t.call('GET', '/debug/trace')).status, 401);
  });
});
