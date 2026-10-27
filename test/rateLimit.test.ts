// Rate limits at their production values (RATE_LIMIT_SCALE=1).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signUp, startServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let t: TestServer;
before(async () => { t = await startServer({ RATE_LIMIT_SCALE: '1' }); });
after(async () => { await t.close(); });

describe('rate limits', () => {
  it('limits sign-in codes to 5 per email per 15 minutes', async () => {
    const email = 'limited@example.com';
    for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/auth/email/start', { email }, null, { 'X-Forwarded-For': `10.1.0.${i}` })).status, 200);
    const r = await t.call('POST', '/auth/email/start', { email }, null, { 'X-Forwarded-For': '10.1.0.99' });
    assert.equal(r.status, 429);
    assert.equal(r.json!.reason, 'rate_limited');
    assert.ok(r.headers.get('retry-after'), 'Retry-After header');
  });

  it('limits sign-in codes to 10 per IP per 15 minutes', async () => {
    const ip = { 'X-Forwarded-For': '10.2.0.1' };
    for (let i = 0; i < 10; i++) assert.equal((await t.call('POST', '/auth/email/start', { email: `ip${i}@example.com` }, null, ip)).status, 200);
    assert.equal((await t.call('POST', '/auth/email/start', { email: 'ip99@example.com' }, null, ip)).status, 429);
  });

  it('limits PIN tries per user', async () => {
    const { token } = await signUp(t, 'pinlimit@example.com');
    await t.call('POST', '/auth/pin/set', { pin: '2468' }, token);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await t.call('POST', '/auth/pin/verify', { pin: '2468' }, token)).status;
    assert.equal(last, 429);
  });
});
