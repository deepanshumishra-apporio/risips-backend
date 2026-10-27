// HTTP security headers (helmet). The API answers JSON, so its CSP allows nothing; the few HTML pages (payment return,
// MF Central sandbox) get a page policy that allows their own inline styles and scripts.
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

export const securityHeaders = helmet({
  contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
});

/** For routes that render an HTML page with inline styles / scripts. */
export function htmlPage(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '));
  next();
}

/** Responses that carry personal data must not be cached by a proxy or the device's HTTP cache. */
export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
