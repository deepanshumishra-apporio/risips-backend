import crypto from 'node:crypto';

export const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacHex = (key: string, s: string) => crypto.createHmac('sha256', key).update(s).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const randomHex = (bytes: number) => crypto.randomBytes(bytes).toString('hex');

/** Constant-time string comparison (no early exit that leaks how many characters matched). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
