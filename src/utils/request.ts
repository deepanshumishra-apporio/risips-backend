import type { Request } from 'express';
import type { DeviceInfo } from '../db/repositories/sessions.repository.ts';

/**
 * The investor's IPv4 address for FP's user_ip / consent records (req.ip is correct only with the right TRUST_PROXY).
 * FP rejects IPv6 and loopback addresses, so those fall back to a private placeholder.
 */
export const clientIp = (req: Request) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1' ? ip : '10.0.0.1';
};

/** The app sends x-device-name / x-device-os on every request (mobile/src/lib/api.ts). */
export const deviceOf = (req: Request): DeviceInfo => ({
  device: String(req.headers['x-device-name'] || '').slice(0, 60) || null,
  os: String(req.headers['x-device-os'] || '').slice(0, 40) || null,
  ip: req.ip || null,
});
