// JSON bodies are capped at 100 KB, except the few routes that carry an image (selfie, signature, MF Central QR),
// which get their own larger parser on the route itself.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

const LARGE_BODY_PATHS = new Set(['/onb/selfie', '/onb/signature', '/external/qr']);
const small = express.json({ limit: '100kb' });

/** For the large-body routes (added on those routes). */
export const imageJson = express.json({ limit: '12mb' });

export function jsonBody(req: Request, res: Response, next: NextFunction) {
  if (LARGE_BODY_PATHS.has(req.path)) return next();
  small(req, res, next);
}
