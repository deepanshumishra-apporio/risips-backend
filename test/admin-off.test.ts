// Without ADMIN_API_KEY the Admin API does not exist.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let t: TestServer;
before(async () => { t = await startServer({ ADMIN_API_KEY: '' }); });
after(async () => { await t.close(); });

describe('admin API without a key', () => {
  it('is a 404, whatever key is sent', async () => {
    assert.equal((await t.call('GET', '/admin/v1/summary')).status, 404);
    assert.equal((await t.call('GET', '/admin/v1/summary', undefined, null, { 'x-admin-key': '' })).status, 404);
  });
});
