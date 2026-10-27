import type { NextFunction, Request, Response } from 'express';
import { sessionsRepo } from '../db/repositories/sessions.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { deviceOf } from '../utils/request.ts';

/** Bearer-token sessions. Puts the user and token on the request; 401 when missing, unknown or expired. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  // tokens are 32 base64url characters; anything else is not worth a database lookup
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return next(new ApiError(401, 'Please sign in again.'));
  try {
    const user = await sessionsRepo.user(token);
    if (!user) return next(new ApiError(401, 'Please sign in again.'));
    req.user = user;
    req.token = token;
    await sessionsRepo.touch(token, deviceOf(req));
    next();
  } catch (e) {
    next(e);
  }
}
