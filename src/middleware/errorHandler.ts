// One error shape for the app: { error: <message to show>, ...extra }. Internal details (stack traces, FP's raw
// replies) go to the log only, tagged with the request id the client also gets in X-Request-Id.
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors.ts';
import { FpError } from '../integrations/fp.client.ts';
import { log } from '../utils/logger.ts';

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, ...err.extra });
    return;
  }
  if (err instanceof FpError) {
    log.error('FP call failed', { rid: req.id, msg: err.message, fp_status: err.status, fp: JSON.stringify(err.body ?? null).slice(0, 500) });
    res.status(err.unreachable ? 503 : 502).json({ error: err.userMessage });
    return;
  }
  // body-parser: malformed JSON (400) or a body over the limit (413)
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The request body is not valid JSON.' });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'The request is too large.' });
    return;
  }
  log.error('Unhandled error', { rid: req.id, method: req.method, path: req.path, err: err instanceof Error ? err.stack : String(err) });
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
