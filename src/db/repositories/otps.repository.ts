// One-time codes. Only an HMAC of each code is stored. Every check counts as an attempt, under the row lock, and a
// right code is deleted as it is used, so parallel requests can neither reuse a code nor get past the attempt limit.
import crypto from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { orm } from '../connection.ts';
import { otps } from '../schema.ts';
import { config } from '../../config/env.ts';
import { hmacHex, safeEqual } from '../../utils/crypto.ts';

export type OtpResult = 'ok' | 'wrong' | 'expired' | 'missing' | 'locked';
const MAX_TRIES = 5;

const hash = (purpose: string, target: string, code: string) => hmacHex(config.appSecret, `otp:${purpose}:${target}:${code}`);
const key = (purpose: string, target: string) => and(eq(otps.purpose, purpose), eq(otps.target, target));

export const otpsRepo = {
  /** Issues a new code (replacing any open one for the same purpose and target) and returns it. */
  issue: async (purpose: string, target: string, ttlSec = 120, digits = 4): Promise<string> => {
    const code = String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
    const row = { purpose, target, code_hash: hash(purpose, target, code), expires_at: Date.now() + ttlSec * 1000, attempts: 0 };
    await orm.insert(otps).values(row).onConflictDoUpdate({
      target: [otps.purpose, otps.target],
      set: { code_hash: row.code_hash, code: null, expires_at: row.expires_at, attempts: 0 },
    });
    return code;
  },

  check: async (purpose: string, target: string, code: unknown): Promise<OtpResult> => {
    const [o] = await orm.update(otps).set({ attempts: sql`${otps.attempts} + 1` }).where(key(purpose, target))
      .returning({ code_hash: otps.code_hash, expires_at: otps.expires_at, prior: sql<number>`${otps.attempts} - 1`.mapWith(Number) });
    if (!o || !o.code_hash) return 'missing';
    if (o.prior >= MAX_TRIES) return 'locked';
    if (Date.now() > o.expires_at) return 'expired';
    if (!safeEqual(o.code_hash, hash(purpose, target, String(code)))) return 'wrong';
    const used = await orm.delete(otps).where(and(key(purpose, target), eq(otps.code_hash, o.code_hash))).returning({ purpose: otps.purpose });
    return used.length ? 'ok' : 'missing'; // a parallel request used it first
  },

  /** Deletes codes that expired over an hour ago; returns how many. */
  purgeExpired: async () => (await orm.delete(otps).where(lt(otps.expires_at, Date.now() - 3600e3)).returning({ purpose: otps.purpose })).length,
};
