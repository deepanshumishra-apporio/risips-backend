// FP webhook events. FP's event is { id: "evt_…", type: "mf_purchase.successful", data: { object: { id, … } }, time }.
// It carries no signature, so the payload is only a hint: we re-fetch the object from FP and update our copy through
// the same refresh code the app's polling uses. The secret path segment keeps everyone else out.
import { config } from '../config/env.ts';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { fp } from '../integrations/fp.client.ts';
import { safeEqual } from '../utils/crypto.ts';
import { refresh } from './orders.service.ts';
import { refreshPlan as refreshSip } from './sip.service.ts';
import { refreshPlan as refreshStp } from './stp.service.ts';
import { refreshPlan as refreshSwp } from './swp.service.ts';
import type { FpObject, Order, OrderKind } from '../types/domain.ts';

const PLAN: Partial<Record<OrderKind, (o: Order) => Promise<Order>>> = { sip: refreshSip, stp: refreshStp, swp: refreshSwp };
const ORDER_PATH: Record<string, string> = { mfp_: '/v2/mf_purchases', mfr_: '/v2/mf_redemptions', mfs_: '/v2/mf_switches' };

/** The secret in the webhook URL (constant-time compare; webhooks are off until a 24+ character token is set). */
export const webhookTokenOk = (t: string) => config.webhookToken.length >= 24 && safeEqual(t, config.webhookToken);

/** Refreshes whatever our record for this FP object is; returns what was done (for the log). */
export async function handleEvent(evt: FpObject): Promise<string> {
  const id = evt?.data?.object?.id;
  if (typeof id !== 'string' || !/^[a-z]+_[A-Za-z0-9]{1,64}$/.test(id)) return 'no object id';
  const o = await ordersRepo.get(id);
  if (o) {
    await (PLAN[o.kind] || refresh)(o);
    return `refreshed ${o.kind} ${id}`;
  }
  // An instalment of one of our plans (SIP/STP/SWP): we store the plan, not each instalment.
  const path = ORDER_PATH[id.slice(0, 4)];
  if (!path) return `not ours: ${id}`;
  const f = await fp.get(`${path}/${id}`, { label: `webhook ${evt.type}` });
  const plan: Order | null = f.plan ? await ordersRepo.get(f.plan) : null;
  if (!plan || !PLAN[plan.kind]) return `not ours: ${id}`;
  await PLAN[plan.kind]!(plan);
  return `refreshed ${plan.kind} ${plan.id} (instalment ${id})`;
}
