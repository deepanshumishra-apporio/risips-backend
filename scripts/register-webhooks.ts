// Registers FP notification webhooks (one per event) pointing at <PUBLIC_URL>/fp/webhook/<FP_WEBHOOK_TOKEN>.
// Idempotent: an event already pointing at our URL is left alone, one pointing elsewhere is updated (PUT).
//   node scripts/register-webhooks.ts            dry run: lists what is registered and what would change
//   node scripts/register-webhooks.ts --apply    makes the changes (add FP_ENV=production for the live tenant)
import { config } from '../src/config/env.ts';
import { fp } from '../src/integrations/fp.client.ts';
import type { JsonObject } from '../src/types/domain.ts';

// Order and plan lifecycles: every one the app shows (src/routes/fpwebhook.ts refreshes the object on each).
const EVENTS = [
  ...['created', 'confirmed', 'submitted', 'successful', 'failed', 'cancelled', 'reversed'].flatMap((s) => [`mf_purchase.${s}`, `mf_redemption.${s}`, `mf_switch.${s}`]),
  ...['created', 'activated', 'completed', 'cancelled', 'failed'].flatMap((s) => [`mf_purchase_plan.${s}`, `mf_switch_plan.${s}`, `mf_redemption_plan.${s}`]),
];

const token = process.env.FP_WEBHOOK_TOKEN;
if (!token || token.length < 24) throw new Error('Set FP_WEBHOOK_TOKEN (24+ random characters) in .env first');
if (!/^https:\/\//.test(config.publicUrl)) throw new Error(`PUBLIC_URL must be the backend's public https address, not ${config.publicUrl}`);
const url = `${config.publicUrl}/fp/webhook/${token}`;
const apply = process.argv.includes('--apply');

const existing = (await fp.get('/v2/notification_webhooks', { label: 'webhooks: list' })).data || [];
console.log(`FP ${config.fpEnv} (${config.fp.tenant}): ${existing.length} webhook(s) registered. Target ${config.publicUrl}/fp/webhook/<token>`);
for (const event of EVENTS) {
  const w = existing.find((x: JsonObject) => x.event === event);
  if (w && w.url === url && w.status === 'enabled') { console.log('  ok     ', event); continue; }
  console.log(`  ${w ? 'update ' : 'create '}`, event, apply ? '' : '(dry run)');
  if (!apply) continue;
  if (w) await fp.put(`/v2/notification_webhooks/${w.id}`, { url, status: 'enabled' }, { label: `webhook: update ${event}` });
  else await fp.post('/v2/notification_webhooks', { event, url, status: 'enabled' }, { label: `webhook: create ${event}` });
}
