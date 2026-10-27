import type { NextFunction, Request, Response } from 'express';
import { randomHex } from '../utils/crypto.ts';
import { log } from '../utils/logger.ts';

/** A request id for every call (X-Request-Id), and one log line when it finishes. Paths with secrets are masked. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : randomHex(8);
  res.setHeader('X-Request-Id', req.id);
  if (req.path === '/health') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const path = req.path.replace(/^\/fp\/webhook\/.*/, '/fp/webhook/<token>').replace(/^\/mfc-sandbox\/journey\/.*/, '/mfc-sandbox/journey/<token>');
    log.info(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`, { rid: req.id, ...(req.user ? { uid: req.user.id } : {}) });
  });
  next();
}
