// Settings ("risips final" Figma 274:6801 and the 743:5505-6038 frames): notification preferences, change PIN,
// active devices, account deletion. Logout is POST /auth/logout.
import { sessionsRepo } from '../db/repositories/sessions.repository.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { log } from '../utils/logger.ts';
import { checkPin, hashPin, pinMatches } from './auth.service.ts';
import { requireTxnOtp } from './otp.service.ts';
import { TERMINAL } from './orders.service.ts';
import { publicUser } from './user.service.ts';
import type { Deletion, Order, SessionRow, User } from '../types/domain.ts';

// ---------- Notification preferences (743:5505) ----------
// Security alerts and transaction/account messages are always on. These toggles filter the in-app feed
// (notifications.service.ts). Push, WhatsApp and email are stored for when a delivery provider is wired up.
export const NOTIFY_DEFAULTS = {
  sip_reminders: true, portfolio_summary: true, goals_reviews: true, market_insights: false,
  push: true, whatsapp: true, email: false,
};
export type NotifyPref = keyof typeof NOTIFY_DEFAULTS;
export const NOTIFY_KEYS = Object.keys(NOTIFY_DEFAULTS) as NotifyPref[];

export const notifyPrefs = (user: User) => ({ ...NOTIFY_DEFAULTS, ...(user.data.notify_prefs || {}) });

export async function updateNotifyPrefs(user: User, patch: Partial<Record<NotifyPref, boolean>>) {
  const u = await usersRepo.merge(user.id, { notify_prefs: { ...(user.data.notify_prefs || {}), ...patch } });
  return { prefs: notifyPrefs(u) };
}

// ---------- Change PIN (743:5674 / 5701 / 5727 / 5753) ----------
// Same rule as /auth/pin/verify: a run of wrong PINs ends the session.

/** Step 1 of the app's flow checks the current PIN before asking for a new one. */
export async function checkCurrentPin(user: User, token: string, current: string) {
  await checkPin(user, token, current, { wrongReason: 'wrong_pin' });
  return { ok: true };
}

/** The current PIN is checked again here: the app's step 1 is a convenience, not the authorisation. */
export async function changePin(user: User, token: string, current: string, pin: string) {
  await checkPin(user, token, current, { wrongReason: 'wrong_pin' });
  if (pinMatches(user, pin)) throw new ApiError(400, 'Choose a PIN different from your current one.');
  await usersRepo.setPinHash(user.id, hashPin(user.id, pin));
  const u = await usersRepo.merge(user.id, { pin_changed_at: new Date().toISOString() });
  log.info('PIN changed', { uid: user.id });
  return { ok: true, user: publicUser(u) };
}

// ---------- Active devices (743:5931 / 5980) ----------

const deviceView = (s: SessionRow, current: boolean) => ({
  id: s.id,
  name: s.device || 'Unknown device',
  os: s.os || null,
  signed_in_at: s.created_at,
  last_active_at: s.last_seen || s.created_at,
  current,
});

export async function devices(user: User, token: string) {
  const all = await sessionsRepo.forUser(user.id);
  const cur = all.find((s) => sessionsRepo.isToken(s, token));
  return { current: cur ? deviceView(cur, true) : null, others: all.filter((s) => s !== cur).map((s) => deviceView(s, false)) };
}

export async function logoutDevice(user: User, token: string, id: number) {
  const cur = (await sessionsRepo.forUser(user.id)).find((s) => sessionsRepo.isToken(s, token));
  if (cur && cur.id === id) throw new ApiError(400, 'Use Logout to sign out of this device.');
  if (!(await sessionsRepo.dropById(user.id, id))) throw new ApiError(404, 'That device is already signed out.');
  return { ok: true };
}

export const logoutOtherDevices = async (user: User, token: string) => ({ ok: true, signed_out: await sessionsRepo.dropOthers(user.id, token) });

// ---------- Delete account (743:5780 / 5838 / 5913) ----------
// A request, not an instant delete: the account is erased 30 days later unless the investor signs in again
// (auth.service.ts cancels it). Units stay in the folios with the AMCs; transaction records are kept as the law
// requires. The OTP comes from the shared POST /txn/otp {action: "delete_account"}.
export const GRACE_DAYS = 30;
const PLAN_KINDS = ['sip', 'stp', 'swp'];
export const DELETION_REASONS = ['not_using', 'other_platform', 'privacy', 'other'] as const;

/** What blocks a deletion: live SIP/STP/SWP plans, and orders still being processed (an unpaid checkout doesn't count). */
export async function deletionChecks(userId: number) {
  const all = await ordersRepo.forUser(userId);
  const live = (o: Order) => !TERMINAL.includes(o.state);
  const plans = all.filter((o) => PLAN_KINDS.includes(o.kind) && live(o));
  const pending = all.filter((o) => ['purchase', 'redemption', 'switch'].includes(o.kind) && live(o)
    && (o.kind !== 'purchase' || o.data.payment?.status === 'SUCCESS'));
  return { active_plans: plans.length, pending_orders: pending.length, ok: !plans.length && !pending.length };
}

const deletionView = (d: Deletion | undefined) => (d ? { status: d.status, requested_at: d.requested_at, purge_after: d.purge_after } : null);

export const deletionStatus = async (user: User) => ({ checks: await deletionChecks(user.id), request: deletionView(user.data.deletion), grace_days: GRACE_DAYS });

export async function requestDeletion(user: User, reason: string | null, otp: string | null | undefined) {
  const c = await deletionChecks(user.id);
  if (c.active_plans) throw new ApiError(409, 'Stop your active SIPs, STPs and SWPs before deleting your account.', { checks: c });
  if (c.pending_orders) throw new ApiError(409, 'Wait for your pending orders to complete before deleting your account.', { checks: c });
  const proof = await requireTxnOtp(user, 'delete_account', otp);
  const now = new Date();
  const deletion: Deletion = {
    status: 'requested', reason, requested_at: now.toISOString(),
    purge_after: new Date(now.getTime() + GRACE_DAYS * 864e5).toISOString(), consent: proof,
  };
  await usersRepo.merge(user.id, { deletion });
  await sessionsRepo.dropAll(user.id); // signed out everywhere; signing in again cancels the request
  log.info('Account deletion requested', { uid: user.id, purge_after: deletion.purge_after });
  return { ok: true, request: deletionView(deletion) };
}

// Keeps KYC and FP identifiers (needed for the retained transaction records); erases the login, PIN, preferences,
// watchlist and imported external holdings. The email is freed, so signing up again starts a new account.
const ERASE = ['notify_prefs', 'biometric', 'pin_set', 'pin_fails', 'watchlist', 'ext', 'notif_read', 'modals_seen', 'cart', 'goals'];

/** Erases accounts whose 30-day window has passed (a background job). Each one under its row lock: a sign-in since
 *  the query cancels the request, and is then left alone. Returns how many were erased. */
export async function purgeDueDeletions(now = new Date()) {
  let n = 0;
  for (const id of await usersRepo.dueForPurge(now.toISOString())) {
    const requested = await usersRepo.purge(id, ERASE, now.toISOString());
    if (requested === null) continue;
    n++;
    log.info('Account deleted', { uid: id, requested_at: requested });
  }
  return n;
}
