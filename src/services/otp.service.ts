// One-time codes: sign-in (email, mobile) and SEBI 2FA on every transaction.
//
// SEBI 2FA: every transaction (and the nomination / opt-out) is authorised with a one-time code sent to the investor's
// registered mobile and email. FP's order docs: "investor consent must be obtained by sending a One-Time Password to
// the investor at his email/phone number" (for an existing folio, the contacts on that folio; for a new folio, the
// account's folio_defaults). Every folio here is opened with the user's own mobile and email, so both are the same.
//
// There is no SMS/email provider yet: codes are returned to the app in demo mode, and printed to the server log only
// when LOG_OTPS allows it (on in the sandbox, off in production).
import { config } from '../config/env.ts';
import { otpsRepo } from '../db/repositories/otps.repository.ts';
import type { OtpResult } from '../db/repositories/otps.repository.ts';
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

/** Delivers a code. Today: the server log (when allowed) and, in demo mode, the API response. */
function deliver(what: string, code: string) {
  if (config.logOtps) log.info(`OTP ${what} -> ${code}`);
  return config.demoMode ? { dev_otp: code } : {};
}

// ---------- sign-in codes ----------

/** Issues a 4-digit sign-in code for an email or a mobile (target), valid for 2 minutes. */
export async function sendLoginOtp(purpose: 'email' | 'mobile' | 'aadhaar', target: string, ttlSec = 120, digits = 4) {
  const code = await otpsRepo.issue(purpose, target, ttlSec, digits);
  return deliver(`${purpose} ${purpose === 'email' ? target : '(user)'}`, code);
}

export const LOGIN_OTP_ERRORS: Record<Exclude<OtpResult, 'ok'>, string> = {
  wrong: 'Incorrect code. Please try again.', expired: 'Code expired. Tap Resend Code.',
  missing: 'Please request a new code.', locked: 'Too many attempts. Request a new code.',
};

/** Checks a sign-in code; throws a 400 with `reason` when it isn't right. */
export async function checkLoginOtp(purpose: string, target: string, code: unknown) {
  const result = await otpsRepo.check(purpose, target, code);
  if (result !== 'ok') throw new ApiError(400, LOGIN_OTP_ERRORS[result], { reason: result });
}

// ---------- transaction (2FA) codes ----------

export async function sendTxnOtp(user: User, action: TxnAction) {
  if (!user.mobile) throw new ApiError(400, 'Please verify your mobile number first.');
  const code = await otpsRepo.issue(`txn:${action}`, String(user.id), TXN_TTL, TXN_DIGITS);
  const [name, domain] = String(user.email || '').split('@');
  return {
    ok: true, action, expires_in: TXN_TTL, resend_in: 30,
    sent_to: { mobile: `+91 ${maskMiddle(user.mobile, 2, 3)}`, email: name ? `${maskMiddle(name, 1, 0)}@${domain}` : null },
    ...deliver(`${action} user ${user.id}`, code),
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
  const v = await otpsRepo.check(`txn:${action}`, String(user.id), String(code));
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
