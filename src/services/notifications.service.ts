// Notifications (Figma 8:8860), the market-holiday announcement (8:8841) and promos (8:8908 modal, 8:8936 banner).
// Built from the investor's real orders and SIPs, NSE's holiday calendar and the content files in src/content.
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { sessionsRepo } from '../db/repositories/sessions.repository.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { holidays } from '../integrations/nse.ts';
import type { Holiday } from '../integrations/nse.ts';
import { addDays, dm, dmy, inrExact as inr, istToday as istDate, dbUtcToIso as utc, weekday } from '../utils/format.ts';
import { scheme, summary } from './catalog.service.ts';
import { readContent as readJson } from './content.service.ts';
import { failText } from './orders.service.ts';
import { notifyPrefs } from './settings.service.ts';
import { planView } from './sip.service.ts';
import type { JsonObject, User } from '../types/domain.ts';

/** One entry in the notification list. */
interface Notification { id: string; tag: string; title: string; body: string; at: string; route?: string | null }

/** The next day after `iso` that is neither a weekend nor a market holiday (the NAV date for orders placed on `iso`). */
export function nextBusinessDay(iso: string, list: Holiday[]) {
  const off = new Set(list.map((h) => h.date));
  let d = addDays(iso, 1);
  while ([0, 6].includes(weekday(d)) || off.has(d)) d = addDays(d, 1);
  return d;
}

// ---------- Promos ----------

function activePromos(): JsonObject[] {
  const today = istDate();
  return readJson('promos.json').promos.filter((p: JsonObject) => p.active && (!p.from || p.from <= today) && (!p.to || today <= p.to));
}

// ---------- Notification list ----------

const shortName = (isin: string | null) => summary(scheme(isin))?.short_name || isin;
const DAY = 864e5;

async function build(user: User) {
  const out: Notification[] = [];
  const today = istDate();
  const now = Date.now();

  // Market holidays in the next 3 days (and today's), posted 3 days ahead
  const hol = await holidays();
  for (const h of hol.filter((x) => x.date >= today && x.date <= addDays(today, 3) && ![0, 6].includes(weekday(x.date)))) {
    const nav = nextBusinessDay(h.date, hol);
    out.push({
      id: `holiday-${h.date}`, tag: 'MARKET', title: `Market holiday: ${h.name}`,
      body: `Markets are closed ${dm(h.date)}. Orders placed ${h.date === today ? 'today' : `on ${dm(h.date)}`} get the ${dm(nav)} NAV.`,
      at: `${addDays(h.date, -3) < today ? addDays(h.date, -3) : today}T03:30:00Z`,
    });
  }

  // Promos (REWARDS)
  for (const p of activePromos()) {
    out.push({ id: `promo-${p.id}`, tag: 'REWARDS', title: p.notification_title, body: p.notification_body, at: `${p.from || today}T03:30:00Z`, route: p.route });
  }

  // Announcements the client posts in src/content/announcements.json (NFOs, maintenance)
  for (const a of readJson('announcements.json').items || []) {
    const at = a.at?.length === 10 ? `${a.at}T03:30:00Z` : a.at;
    if (!at || Date.parse(at) > now || (a.to && a.to < today)) continue;
    out.push({ id: `ann-${a.id}`, tag: a.tag, title: a.title, body: a.body, at, route: a.route || null });
  }

  // Orders placed through Risips that finished in the last 30 days
  const all = await ordersRepo.forUser(user.id);
  for (const o of all.filter((x) => ['purchase', 'redemption', 'switch'].includes(x.kind))) {
    const f = o.data.fp || {};
    const at = f.succeeded_at || f.failed_at || utc(o.updated_at);
    if (!['successful', 'failed'].includes(o.state) || now - Date.parse(at) > 30 * DAY) continue;
    const name = shortName(o.isin);
    const route = o.kind === 'purchase' ? `/invest/result?id=${o.id}` : `/order/${o.id}`;
    const amount = o.amount ?? f.redeemed_amount ?? f.switched_out_amount;
    if (o.state === 'successful') {
      const text = {
        purchase: [`Order successful: ${inr(amount)} in ${name}`, f.allotted_units != null ? `${Number(f.allotted_units).toFixed(3)} units allotted at NAV ${inr(f.purchased_price)}.` : 'Your units have been allotted.'],
        redemption: [`Withdrawal processed: ${name}`, `${amount != null ? inr(amount) : 'The money'} is on its way to your bank account (usually 1–3 working days).`],
        switch: [`Switch done: ${name} → ${shortName(o.isin_to)}`, `${amount != null ? `${inr(amount)} moved` : 'Your units moved'} to ${shortName(o.isin_to)}.`],
      }[o.kind as 'purchase'];
      out.push({ id: `order-${o.id}-ok`, tag: 'ORDER', title: text[0], body: text[1], at, route });
    } else {
      const refund = o.kind === 'purchase' && o.data.payment?.status === 'SUCCESS' ? ' Any money debited is refunded to your bank account.' : '';
      out.push({ id: `order-${o.id}-fail`, tag: 'ORDER', title: `${{ purchase: 'Order', redemption: 'Withdrawal', switch: 'Switch' }[o.kind as 'purchase']} failed: ${name}`, body: `${failText(f.failure_code)}${refund}`, at, route });
    }
  }

  // SIPs: instalments due in the next 3 days, recent instalment results, pause / resume
  for (const o of all.filter((x) => x.kind === 'sip')) {
    const p = planView(o);
    const name = shortName(o.isin);
    const route = `/sip/${o.id}`;
    if (p.state === 'active' && p.next_debit && p.next_debit >= today && p.next_debit <= addDays(today, 3)) {
      out.push({
        id: `sipdue-${o.id}-${p.next_debit}`, tag: 'SIP', title: `SIP instalment on ${dm(p.next_debit)}`,
        body: `${inr(p.amount)} for ${name} will be debited via AutoPay. Keep enough balance in your bank account.`,
        at: `${addDays(p.next_debit, -3) < today ? addDays(p.next_debit, -3) : today}T03:30:00Z`, route,
      });
    }
    for (const i of p.installments.filter((x) => ['successful', 'failed'].includes(x.state) && x.scheduled_on && now - Date.parse(x.scheduled_on) < 30 * DAY)) {
      // the up-front instalment is paid at set-up but scheduled for the next business day: date it by the plan
      // instead, or the list would hide its result until that evening
      const sched = `${i.scheduled_on!.slice(0, 10)}T12:30:00Z`;
      const at = Date.parse(sched) <= now ? sched : i.upfront ? utc(o.created_at) : new Date(now).toISOString();
      out.push(i.state === 'successful'
        ? { id: `sipinst-${i.id}-ok`, tag: 'SIP', title: `SIP instalment successful: ${name}`, body: `${inr(i.amount)} invested${i.units != null ? `, ${Number(i.units).toFixed(3)} units allotted` : ''}.`, at, route }
        : i.upfront
          // the first instalment is paid on the UPI checkout at set-up; when it fails the SIP never starts (see sip.ts)
          ? { id: `sipinst-${i.id}-fail`, tag: 'SIP', title: `SIP not started: ${name}`, body: `${failText(i.failure_code, 'The first payment did not go through.')} Nothing more will be debited for this SIP.`, at, route }
          : { id: `sipinst-${i.id}-fail`, tag: 'ACTION NEEDED', title: `SIP instalment failed: ${name}`, body: `${failText(i.failure_code, 'The AutoPay debit did not go through.')} Check your bank balance and AutoPay.`, at, route });
    }
    const d = o.data;
    if (p.pause && d.paused_at) {
      out.push({ id: `sippause-${o.id}-${p.pause.from}`, tag: 'SIP', title: `SIP paused: ${name}`, body: `${p.pause.skipped.length === 1 ? `The ${dm(p.pause.from)} instalment is` : `${p.pause.skipped.length} instalments are`} skipped. It resumes on ${dmy(p.pause.resumes_on)}.`, at: d.paused_at, route });
    } else if (d.resumed_at && (!d.paused_at || d.resumed_at > d.paused_at) && now - Date.parse(d.resumed_at) < 30 * DAY && p.state === 'active') {
      out.push({ id: `sipresume-${o.id}-${d.resumed_at}`, tag: 'SIP', title: `SIP resumed: ${name}`, body: p.next_debit ? `Your next instalment of ${inr(p.amount)} is on ${dmy(p.next_debit)}.` : 'Your instalments will continue as scheduled.', at: d.resumed_at, route });
    }
  }

  // SEBI: every folio needs a nominee or an explicit opt-out (skipping the nominee step records the opt-out)
  const u = user.data;
  if (u.onboarded_at && !u.nominee && !u.nominee_skipped) {
    out.push({ id: 'nominee-missing', tag: 'ACTION NEEDED', title: 'Add a nominee', body: 'SEBI requires nomination (or an opt-out) on your folios.', at: u.onboarded_at, route: '/profile/account' });
  }
  // fresh KYC (kyc.service.ts): submitted to the KRA, then approved (the kyc-approvals job sets kyc_approved_at)
  if (u.kyc_fresh && u.kyc_approved_at) {
    out.push({ id: 'kyc-approved', tag: 'KYC', title: 'Your KYC is approved', body: 'The KRA has approved your KYC. You can start investing now.', at: u.kyc_approved_at, route: '/explore' });
  } else if (u.kyc_fresh && u.kyc_form?.status === 'submitted') {
    const at = u.kyc_form.submitted_at && Date.parse(u.kyc_form.submitted_at) ? new Date(u.kyc_form.submitted_at).toISOString() : u.onboarded_at || new Date(now).toISOString();
    out.push({ id: 'kyc-with-kra', tag: 'KYC', title: 'Your KYC is with the KRA', body: 'It usually takes 1–3 working days. We’ll let you know as soon as you can invest.', at, route: '/profile/account' });
  }

  const read = new Set((await usersRepo.byId(user.id))!.data.notif_read || []);
  return out
    .filter((n) => Date.parse(n.at) <= now + 60e3)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 50)
    .map((n) => ({ route: null, ...n, read: read.has(n.id) }));
}

/** The one modal to show now: today's market holiday first, then the current promo; each is shown once. */
async function modalFor(user: User) {
  const seen = new Set((await usersRepo.byId(user.id))!.data.modals_seen || []);
  const today = istDate();
  const hol = await holidays();
  const h = hol.find((x) => x.date === today);
  if (h && !seen.has(`holiday-${today}`)) {
    const nav = nextBusinessDay(today, hol);
    return {
      id: `holiday-${today}`, kind: 'holiday', date: today, title: 'Market holiday', name: h.name,
      body: 'Markets are closed today, so trading and NAV updates are paused.',
      note: `Orders you place today will be processed at the NAV of ${dmy(nav)} (next business day).`,
      nav_date: nav,
    };
  }
  const p = activePromos().find((x) => !seen.has(`promo-${x.id}`));
  if (p) return { id: `promo-${p.id}`, kind: 'promo', tag: p.tag, title: p.title, body: p.body, highlight: p.highlight, cta: p.cta, route: p.route };
  return null;
}

/** "Security alerts" (always on, Settings > Manage notifications): sign-ins on other devices and PIN changes, last 30 days. */
async function securityAlerts(user: User, token: string) {
  const since = Date.now() - 30 * 864e5;
  const read = new Set(user.data.notif_read || []);
  const at = (s: string) => new Date(String(s).replace(' ', 'T') + (/[Z+]/.test(s) ? '' : 'Z')).toISOString();
  const out: Notification[] = (await sessionsRepo.recentForUser(user.id))
    .filter((s) => !sessionsRepo.isToken(s, token) && Date.parse(at(s.created_at)) > since)
    .map((s) => ({
      id: `login-${s.id}`, tag: 'SECURITY', title: `New sign-in on ${s.device || 'another device'}`,
      body: `${s.os ? `${s.os}. ` : ''}If this wasn’t you, log it out in Settings > Active devices.`, at: at(s.created_at), route: '/settings/devices',
    }));
  const pc = user.data.pin_changed_at;
  if (pc && Date.parse(pc) > since) out.push({ id: `pin-${pc}`, tag: 'SECURITY', title: 'Your app PIN was changed', body: 'If you didn’t do this, contact support right away.', at: pc, route: null });
  return out.map((n) => ({ ...n, read: read.has(n.id) }));
}

export async function listNotifications(user: User, token: string) {
  const prefs = notifyPrefs(user);
  // Optional categories follow the investor's preferences; order, SIP-outcome and security messages always show.
  const list = [...(await securityAlerts(user, token)), ...(await build(user))]
    .filter((n) => (prefs.sip_reminders || !n.id.startsWith('sipdue-')) && (prefs.market_insights || !/^(promo|ann)-/.test(n.id)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const promo = prefs.market_insights ? activePromos()[0] : null;
  const modal = await modalFor(user);
  return {
    notifications: list,
    unread: list.filter((n) => !n.read).length,
    modal: modal && (prefs.market_insights || modal.kind !== 'promo') ? modal : null,
    banner: promo ? { id: promo.id, title: promo.banner_title, body: promo.banner_body, route: promo.route } : null,
  };
}

/** Marks the given notification ids read, or every current one when no ids are sent. */
export async function markRead(user: User, token: string, ids?: string[]) {
  const read = ids ?? [...(await securityAlerts(user, token)), ...(await build(user))].map((n) => n.id);
  // keep the list bounded: ids of events older than the 30-day window stop mattering
  await usersRepo.update(user.id, (d) => ({ notif_read: [...new Set([...(d.notif_read || []), ...read])].slice(-500) }));
  return { ok: true };
}

export async function markModalSeen(user: User, id: string) {
  if (id) await usersRepo.update(user.id, (d) => ({ modals_seen: [...new Set([...(d.modals_seen || []), id])].slice(-100) }));
  return { ok: true };
}
