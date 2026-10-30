// Rate limits at their production values (RATE_LIMIT_SCALE=1).
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { signUp, startServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let t: TestServer;
before(async () => { t = await startServer({ RATE_LIMIT_SCALE: '1' }); });
after(async () => { await t.close(); });

describe('rate limits', () => {
  it('sends 6-digit sign-in codes, at most one per email per 30 seconds', async () => {
    const email = 'limited@example.com';
    const first = await t.call('POST', '/auth/email/start', { email }, null, { 'X-Forwarded-For': '10.1.0.1' });
    assert.equal(first.status, 200);
    assert.equal(first.json!.code_length, 6);
    assert.match(String(first.json!.dev_otp), /^\d{6}$/);
    const r = await t.call('POST', '/auth/email/start', { email }, null, { 'X-Forwarded-For': '10.1.0.99' });
    assert.equal(r.status, 429);
    assert.equal(r.json!.reason, 'rate_limited');
    assert.ok(Number(r.json!.retry_after) > 0 && Number(r.json!.retry_after) <= 30, 'retry_after');
  });

  it('limits sign-in codes to 20 per IP per hour (the JS backend\'s limit), ignoring the port App Service adds', async () => {
    for (let i = 0; i < 20; i++) {
      assert.equal((await t.call('POST', '/auth/email/start', { email: `ip${i}@example.com` }, null, { 'X-Forwarded-For': `10.2.0.1:${5000 + i}` })).status, 200);
    }
    assert.equal((await t.call('POST', '/auth/email/start', { email: 'ip99@example.com' }, null, { 'X-Forwarded-For': '10.2.0.1:6000' })).status, 429);
  });

  it('after 10 wrong codes in an hour, refuses both checking and sending a code until the block ends', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const email = 'wrongcap@example.com';
      const start = () => t.call('POST', '/auth/email/start', { email });
      const verify = (code: unknown) => t.call('POST', '/auth/email/verify', { email, code });
      let code = '';
      for (let round = 0; round < 2; round++) {
        const s = await start();
        assert.equal(s.status, 200);
        code = String(s.json!.dev_otp);
        const wrong = code === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++) assert.equal((await verify(wrong)).json!.reason, 'wrong');
        mock.timers.tick(31e3);
      }
      const blockedSend = await start();
      assert.equal(blockedSend.status, 429);
      assert.equal(blockedSend.json!.reason, 'rate_limited');
      assert.ok(Number(blockedSend.json!.retry_after) > 0, 'retry_after');
      assert.equal(blockedSend.json!.dev_otp, undefined, 'no code issued');
      assert.equal((await verify(code)).status, 429);

      mock.timers.tick(3600e3);
      const s = await start();
      assert.equal(s.status, 200);
      assert.equal((await verify(s.json!.dev_otp)).status, 200);
    } finally {
      mock.timers.reset();
    }
  });

  it('limits PIN tries per user', async () => {
    const { token } = await signUp(t, 'pinlimit@example.com');
    await t.call('POST', '/auth/pin/set', { pin: '2468' }, token);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await t.call('POST', '/auth/pin/verify', { pin: '2468' }, token)).status;
    assert.equal(last, 429);
  });
});
