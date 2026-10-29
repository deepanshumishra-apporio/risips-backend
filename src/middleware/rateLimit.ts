// Rate limits. In-memory counters: correct for one server process. Before running more than one instance, give
// express-rate-limit a shared store (e.g. rate-limit-redis) or the limits apply per instance.
//
// What each limit protects:
//   otpSend      SMS/email cost and OTP spraying: per IP, and per destination (an email, a mobile, a user's 2FA)
//   otpVerify    guessing codes (each code also locks after 5 wrong tries)
//   pin          guessing the 4-digit PIN (5 wrong tries also end the session)
//   kycCheck     paid FP pre-verification calls (PAN, bank)
//   money        order / plan creation bursts
import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../config/env.ts';

const MIN = 60e3;

function limiter(name: string, { windowMs, limit, key }: { windowMs: number; limit: number; key: (req: Request) => string }) {
  return rateLimit({
    windowMs,
    limit: Math.max(1, Math.round(limit * config.rateLimitScale)),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${key(req)}`,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: 'Too many attempts. Please wait a few minutes and try again.',
        reason: 'rate_limited',
      });
    },
  });
}

// App Service adds the client's port to the forwarded address, which would make every request look like a new client.
const byIp = (req: Request) => ipKeyGenerator(String(req.ip || '0.0.0.0').replace('::ffff:', '').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'));
// per-user limits run after requireAuth; fall back to the IP if one is ever mounted before it
const byUser = (req: Request) => (req.user ? `u${req.user.id}` : byIp(req));
const field = (req: Request, k: string) => String((req.body as Record<string, unknown> | undefined)?.[k] ?? '').trim().toLowerCase().slice(0, 100);

export const limits = {
  /** Every API call, per IP. Generous: a busy app screen makes a handful of calls. */
  global: limiter('global', { windowMs: MIN, limit: 300, key: byIp }),
  /** The Admin API: one caller (the admin dashboard's backend), so its own budget instead of the global per-IP one. */
  admin: limiter('admin', { windowMs: MIN, limit: 600, key: byIp }),
  /** Webhooks come from FP's few servers, in bursts. */
  webhook: limiter('webhook', { windowMs: MIN, limit: 600, key: byIp }),

  // The JS backend's numbers: testers (and an office or carrier NAT) share one IP. Per destination, otp.service.ts also
  // allows one code per 30 s and 20 an hour, and at most 10 wrong codes an hour across codes.
  otpSendIp: limiter('otp-ip', { windowMs: 60 * MIN, limit: 20, key: byIp }),
  otpSendEmail: limiter('otp-email', { windowMs: 60 * MIN, limit: 20, key: (req) => field(req, 'email') || byIp(req) }),
  otpSendUser: limiter('otp-user', { windowMs: 60 * MIN, limit: 60, key: byUser }),
  otpVerify: limiter('otp-verify', { windowMs: 60 * MIN, limit: 60, key: byIp }),
  /** Signed-in code checks (mobile, Aadhaar): per user, so one office IP doesn't share a budget. */
  otpVerifyUser: limiter('otp-verify-user', { windowMs: 60 * MIN, limit: 60, key: byUser }),

  pin: limiter('pin', { windowMs: 15 * MIN, limit: 10, key: byUser }),
  kycCheck: limiter('kyc', { windowMs: 60 * MIN, limit: 30, key: byUser }),
  money: limiter('money', { windowMs: 10 * MIN, limit: 30, key: byUser }),
};
