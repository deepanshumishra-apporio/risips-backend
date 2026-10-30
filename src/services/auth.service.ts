// Sign-in: email OTP (sign-up and sign-in are the same step), mobile OTP, the 4-digit app PIN, sessions.
import crypto from 'node:crypto';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { sessionsRepo } from '../db/repositories/sessions.repository.ts';
import type { DeviceInfo } from '../db/repositories/sessions.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { safeEqual } from '../utils/crypto.ts';
import { checkLoginOtp, sendLoginOtp } from './otp.service.ts';
import { publicUser } from './user.service.ts';
import type { User } from '../types/domain.ts';

export const PIN_TRIES = 5;

/** scrypt of the PIN, salted per user (unchanged from the JS backend, so existing PINs keep working). */
export const hashPin = (userId: number, pin: string) => crypto.scryptSync(String(pin), `risips-pin-${userId}`, 32).toString('hex');
export const pinMatches = (user: User, pin: string) => !!user.pin_hash && safeEqual(hashPin(user.id, pin), user.pin_hash);

export async function startEmail(email: string) {
  return { ok: true, expires_in: 120, existing: !!(await usersRepo.byEmail(email)), ...(await sendLoginOtp('email', email, { email })) };
}

export async function verifyEmail(email: string, code: string, device: DeviceInfo) {
  await checkLoginOtp('email', email, code);
  let user = await usersRepo.byEmail(email);
  const isNew = !user;
  if (!user) user = await usersRepo.create(email);
  // Signing in during the 30-day window cancels a deletion request (Settings > Delete account says so). Done under the
  // row lock, so it can't interleave with the purge (settings.service.ts).
  let cancelled = false;
  user = (await usersRepo.update(user.id, (d) => {
    cancelled = d.deletion?.status === 'requested';
    return { email_verified: true, ...(cancelled ? { deletion: { ...d.deletion!, status: 'cancelled' as const, cancelled_at: new Date().toISOString() } } : {}) };
  }))!;
  // erased in the moment between the lookup and the lock: the email is free now, so signing in again opens a new account
  if (user.data.deletion?.status === 'deleted') throw new ApiError(409, 'Please request a new code and sign in again.');
  const token = await sessionsRepo.create(user.id, device);
  return { token, is_new: isNew, user: publicUser(user), ...(cancelled ? { deletion_cancelled: true } : {}) };
}

/** One mobile per account: a number another live account has verified is refused (before a code is sent, and again on verify). */
async function assertMobileFree(user: User, mobile: string) {
  if (await usersRepo.mobileTakenBy(mobile, user.id)) {
    throw new ApiError(409, 'This mobile number is already registered with another Risips account. Please use a different number.', { reason: 'mobile_taken' });
  }
}

export async function startMobile(user: User, mobile: string) {
  // The FP investor profile holds the verified number; changing it here would not reach FP.
  if (user.data.onboarded_at && mobile !== user.mobile) throw new ApiError(409, 'Your mobile number is already registered. Contact support to change it.');
  await assertMobileFree(user, mobile);
  return { ok: true, expires_in: 120, ...(await sendLoginOtp('mobile', `${user.id}:${mobile}`, { mobile })) };
}

export async function verifyMobile(user: User, mobile: string, code: string, bankConsent: boolean) {
  await checkLoginOtp('mobile', `${user.id}:${mobile}`, code);
  await assertMobileFree(user, mobile); // another account may have verified it since the code was sent
  await usersRepo.setMobile(user.id, mobile);
  const u = await usersRepo.merge(user.id, { mobile_verified: true, bank_consent: bankConsent });
  return { user: publicUser(u) };
}

export async function setPin(user: User, pin: string) {
  await usersRepo.setPinHash(user.id, hashPin(user.id, pin));
  return { user: publicUser(await usersRepo.merge(user.id, { pin_set: true, pin_fails: 0 })) };
}

/**
 * Checks the PIN. A 4-digit PIN is guessable, so PIN_TRIES wrong tries in a row end this session: the investor signs
 * in again with an email OTP. Used by the unlock screen and by Settings > Change PIN.
 */
export async function checkPin(user: User, token: string, pin: string, { wrongReason }: { wrongReason?: string } = {}) {
  if (!user.pin_hash) throw new ApiError(400, 'No PIN set.');
  if (pinMatches(user, pin)) {
    if (user.data.pin_fails) await usersRepo.merge(user.id, { pin_fails: 0 });
    return;
  }
  const fails = (user.data.pin_fails || 0) + 1;
  if (fails >= PIN_TRIES) {
    await usersRepo.merge(user.id, { pin_fails: 0 });
    await sessionsRepo.drop(token);
    throw new ApiError(401, 'Too many wrong PIN attempts. Please sign in again with your email.', { reason: 'pin_locked' });
  }
  await usersRepo.merge(user.id, { pin_fails: fails });
  const left = PIN_TRIES - fails;
  throw new ApiError(400, `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left.`, { attempts_left: left, ...(wrongReason ? { reason: wrongReason } : {}) });
}

export async function setBiometric(user: User, enabled: boolean) {
  return { user: publicUser(await usersRepo.merge(user.id, { biometric: enabled })) };
}

export async function logout(token: string) {
  await sessionsRepo.drop(token);
  return { ok: true };
}
