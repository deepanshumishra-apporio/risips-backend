// One-time codes: sign-in (email, mobile) and SEBI 2FA on every transaction.
//
// SEBI 2FA: every transaction (and the nomination / opt-out) is authorised with a one-time code sent to the investor's
// registered mobile and email. FP's order docs: "investor consent must be obtained by sending a One-Time Password to
// the investor at his email/phone number" (for an existing folio, the contacts on that folio; for a new folio, the
// account's folio_defaults). Every folio here is opened with the user's own mobile and email, so both are the same.
//
// Codes go out through MSG91 (integrations/msg91.ts) once its templates are set, and to the server log until then.
// Demo mode also returns them to the app.
import { config } from '../config/env.ts';
import { otpsRepo } from '../db/repositories/otps.repository.ts';
import type { OtpResult } from '../db/repositories/otps.repository.ts';
import { deliverOtp } from '../integrations/msg91.ts';
import { ApiError } from '../utils/errors.ts';
import { log } from '../utils/logger.ts';
import { maskMiddle } from '../utils/mask.ts';
import type { TxnConsent, User } from '../types/domain.ts';

/** Action key -> what the code authorises (for the SMS/email text once a provider is wired up). */
export const TXN_ACTIONS = {
  lumpsum: 'a one-time investment', cart: 'your cart checkout', redeem: 'a redemption', switch: 'a switch',
  sip: 'a new SIP', sip_modify: 'a change to your SIP', sip_cancel: 'stopping your SIP', sip_pause: 'pausing your SIP',
  sip_resume: 'resuming your SIP', stp: 'a new STP', stp_cancel: 'stopping your STP', swp: 'a new SWP',
  swp_cancel: 'stopping your SWP', nominee: 'your nomination', delete_account: 'deleting your Risips account',
};
export type TxnAction = keyof typeof TXN_ACTIONS;
export const TXN_ACTION_KEYS = Object.keys(TXN_ACTIONS) as [TxnAction, ...TxnAction[]];

const TXN_TTL = 300;
const TXN_DIGITS = 6;
const LOGIN_TTL = 120;
const LOGIN_DIGITS = 6; // sent to the app as code_length (apps before 2026-10-26 assume 4)

const devOtp = (code: string) => (config.demoMode ? { dev_otp: code } : {});

// ---------- limits across codes ----------
// A new code resets that code's 5-try lock (otps.repository.ts), so these count across every code for one purpose +
// target: new codes at most 1 per 30 s and 20 an hour; wrong codes at most 10 an hour and 20 a day. In memory: correct
// for one server process, and a restart clears them.

const SEC = 1e3;
const HOUR = 3600 * SEC;
const DAY = 24 * HOUR;
const OTP_ISSUE: [number, number][] = [[1, 30 * SEC], [20, HOUR]];
const OTP_WRONG: [number, number][] = [[10, HOUR], [20, DAY]];

const hits = new Map<string, number[]>(); // key -> timestamps (ms), oldest first

/** Seconds until `key` may be hit again under `rules` ([max, windowMs] pairs); 0 = allowed now. Doesn't record. */
function waitFor(key: string, rules: [number, number][], now = Date.now()) {
  const ts = hits.get(key) || [];
  let wait = 0;
  for (const [max, ms] of rules) {
    const inWindow = ts.filter((t) => now - t < ms);
    if (inWindow.length >= max) wait = Math.max(wait, inWindow[inWindow.length - max] + ms - now);
  }
  return Math.ceil(wait / 1000);
}

function record(key: string, now = Date.now()) {
  const ts = (hits.get(key) || []).filter((t) => now - t < DAY);
  ts.push(now);
  hits.set(key, ts);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of hits) if (now - ts[ts.length - 1] >= DAY) hits.delete(k);
}, 10 * 60 * SEC).unref();

const inWords = (s: number) => (s < 90 ? `${s} seconds` : s < 90 * 60 ? `${Math.ceil(s / 60)} minutes` : `${Math.ceil(s / 3600)} hours`);
const tooMany = (msg: string, s: number) => new ApiError(429, `${msg} Please try again in ${inWords(s)}.`, { reason: 'rate_limited', retry_after: s });

/**
 * Call before issuing a code: spaces out new codes for one purpose + target, and sends none while too many wrong codes
 * block checking (checkOtp would refuse it, so the investor would get a code they can't use).
 */
function limitOtpIssue(purpose: string, target: string) {
  const blocked = waitFor(`otp-wrong:${purpose}:${target}`, OTP_WRONG);
  if (blocked) throw tooMany('Too many wrong codes.', blocked);
  const key = `otp-issue:${purpose}:${target}`;
  const s = waitFor(key, OTP_ISSUE);
  if (s) throw tooMany('A code was sent just now.', s);
  record(key);
}

/** otpsRepo.check, plus the cap on wrong codes across every code issued for this purpose + target. */
async function checkOtp(purpose: string, target: string, code: unknown): Promise<OtpResult> {
  const key = `otp-wrong:${purpose}:${target}`;
  const s = waitFor(key, OTP_WRONG);
  if (s) throw tooMany('Too many wrong codes.', s);
  const result = await otpsRepo.check(purpose, target, code);
  if (result === 'wrong') record(key);
  return result;
}

// ---------- sign-in codes ----------

/** Issues a 6-digit sign-in code for an email or a mobile (target), valid for 2 minutes, and sends it to `to`. */
export async function sendLoginOtp(purpose: 'email' | 'mobile', target: string, to: { email?: string; mobile?: string }) {
  limitOtpIssue(purpose, target);
  const code = await otpsRepo.issue(purpose, target, LOGIN_TTL, LOGIN_DIGITS);
  await deliverOtp(to, code, {
    purpose: purpose === 'email' ? 'signing in to Risips' : 'verifying your mobile number',
    ttl: LOGIN_TTL, label: `${purpose} ${purpose === 'email' ? target : '(user)'}`,
  });
  return { code_length: LOGIN_DIGITS, ...devOtp(code) };
}

/** The simulated Aadhaar OTP (6 digits, like UIDAI's, valid 5 minutes): only logged, never sent by MSG91. */
export async function sendAadhaarOtp(userId: number) {
  limitOtpIssue('aadhaar', String(userId));
  const code = await otpsRepo.issue('aadhaar', String(userId), 300, 6);
  if (config.logOtps) log.info(`OTP aadhaar user ${userId} -> ${code}`);
  return devOtp(code);
}

export const LOGIN_OTP_ERRORS: Record<Exclude<OtpResult, 'ok'>, string> = {
  wrong: 'Incorrect code. Please try again.', expired: 'Code expired. Tap Resend Code.',
  missing: 'Please request a new code.', locked: 'Too many attempts. Request a new code.',
};

/** Checks a sign-in code; throws a 400 with `reason` when it isn't right. */
export async function checkLoginOtp(purpose: string, target: string, code: unknown) {
  const result = await checkOtp(purpose, target, code);
  if (result !== 'ok') throw new ApiError(400, LOGIN_OTP_ERRORS[result], { reason: result });
}

// ---------- transaction (2FA) codes ----------

export async function sendTxnOtp(user: User, action: TxnAction) {
  if (!user.mobile) throw new ApiError(400, 'Please verify your mobile number first.');
  limitOtpIssue(`txn:${action}`, String(user.id));
  const code = await otpsRepo.issue(`txn:${action}`, String(user.id), TXN_TTL, TXN_DIGITS);
  const via = await deliverOtp({ mobile: user.mobile, email: user.email }, code, { purpose: TXN_ACTIONS[action], ttl: TXN_TTL, label: `${action} user ${user.id}` });
  const [name, domain] = String(user.email || '').split('@');
  return {
    ok: true, action, expires_in: TXN_TTL, resend_in: 30,
    // only the channels that didn't fail, so the app doesn't promise an email that never left
    sent_to: {
      mobile: via.sms !== 'failed' ? `+91 ${maskMiddle(user.mobile, 2, 3)}` : null,
      email: name && via.email !== 'failed' ? `${maskMiddle(name, 1, 0)}@${domain}` : null,
    },
    ...devOtp(code),
  };
}

/**
 * Checks and uses up a transaction OTP. Call it after the request is validated and right before the first FP write, so
 * a validation error doesn't spend the code. Errors carry `reason` so the app knows the problem is the code
 * (otp_required / wrong / expired / missing / locked), not the order. Returns the audit record kept with the order.
 */
export async function requireTxnOtp(user: User, action: TxnAction, code: string | undefined | null): Promise<TxnConsent> {
  if (code === undefined || code === null || code === '') {
    throw new ApiError(400, 'Confirm this with the OTP sent to your registered mobile and email.', { reason: 'otp_required' });
  }
  const v = await checkOtp(`txn:${action}`, String(user.id), String(code));
  if (v !== 'ok') {
    throw new ApiError(400, {
      wrong: 'That OTP is not correct.', locked: 'Too many wrong attempts. Request a new OTP.',
      expired: 'This OTP has expired. Request a new one.', missing: 'This OTP has already been used or expired. Request a new one.',
    }[v], { reason: v });
  }
  const at = new Date().toISOString();
  log.info(`2FA ${action} verified`, { uid: user.id });
  return { at, action, via: 'otp', mobile: user.mobile, email: user.email };
}
