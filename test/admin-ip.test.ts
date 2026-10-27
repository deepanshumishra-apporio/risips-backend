// ADMIN_API_ALLOWED_IPS refuses every other address, even with the right key.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const KEY = 'test-admin-key-0123456789abcdef';
let t: TestServer;
before(async () => { t = await startServer({ ADMIN_API_KEY: KEY, ADMIN_API_ALLOWED_IPS: '10.9.9.9' }); });
after(async () => { await t.close(); });

describe('admin API IP allowlist', () => {
  it('refuses a caller that is not listed', async () => {
    const r = await t.call('GET', '/admin/v1/summary', undefined, null, { 'x-admin-key': KEY });
    assert.equal(r.status, 403);
  });
});
