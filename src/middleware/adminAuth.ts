// Gate for the Admin API (/admin/v1): read-only investor and order data for the admin dashboard's backend (a separate
// server, run by another team). Off (404) unless ADMIN_API_KEY is set.
// - Every call needs `x-admin-key`; ADMIN_API_ALLOWED_IPS (comma-separated) limits who may call it. req.ip is only the
//   caller's address when TRUST_PROXY matches the proxies in front of this server.
// - The caller passes `x-admin-actor` (the staff user's email/id); every call is logged with it to logs/admin_api.log.
// - Only GET: nothing in the Admin API writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { config, paths } from '../config/env.ts';
import { ApiError } from '../utils/errors.ts';
import { errMsg, log } from '../utils/logger.ts';

const LOG = path.join(paths.logs, 'admin_api.log');

/** Constant-time compare of the presented key with ours (hashed first, so lengths always match). */
const sameKey = (a: unknown) => {
  const h = (s: string) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(typeof a === 'string' ? a : ''), h(config.admin.key));
};

export function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.admin.key) return next(new ApiError(404, 'Not found'));
  const ip = (req.ip || '').replace('::ffff:', '');
  const started = Date.now();
  res.on('finish', () => {
    const line = {
      at: new Date().toISOString(), ip, actor: String(req.headers['x-admin-actor'] || '').slice(0, 120) || null,
      method: req.method, path: req.originalUrl.slice(0, 500), status: res.statusCode, ms: Date.now() - started,
    };
    fs.promises.mkdir(paths.logs, { recursive: true })
      .then(() => fs.promises.appendFile(LOG, `${JSON.stringify(line)}\n`))
      .catch((e) => log.warn('Admin API audit log write failed', { err: errMsg(e) }));
  });
  if (config.admin.allowedIps.length && !config.admin.allowedIps.includes(ip)) return next(new ApiError(403, 'Not allowed from this address.'));
  if (!sameKey(req.headers['x-admin-key'])) return next(new ApiError(401, 'Bad or missing x-admin-key.'));
  if (req.method !== 'GET') return next(new ApiError(405, 'The Admin API is read-only.'));
  next();
}
