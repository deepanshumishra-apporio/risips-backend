// Health, payment return pages, signed file downloads, the demo API log, and FP webhooks.
import type { Request, Response } from 'express';
import { config } from '../config/env.ts';
import { trace } from '../integrations/fp.client.ts';
import { valid } from '../middleware/validate.ts';
import { systemSchemas as s } from '../validation/system.validation.ts';
import { catalog } from '../services/catalog.service.ts';
import { resolveSignedFile } from '../services/files.service.ts';
import { handleEvent, webhookTokenOk } from '../services/webhook.service.ts';
import { errMsg, log } from '../utils/logger.ts';

export async function health(_req: Request, res: Response) {
  res.json({ ok: true, fp_env: config.fpEnv, demo: config.demoMode, schemes: catalog().length });
}

/** FP redirects the checkout (inside the app's WebView) here after payment / mandate auth. The app intercepts this
 *  URL and closes the WebView; a browser just sees this page. */
export async function returnPage(_req: Request, res: Response) {
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
  <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#020b1b;color:#fff;font-family:sans-serif;text-align:center">
  <div><div style="font-size:48px">✓</div><h2>Returning to Risips…</h2><p style="opacity:.6">You can close this window.</p></div>`);
}

/** Selfie / signature images, through signed expiring links only (services/files.service.ts). */
export async function file(req: Request, res: Response) {
  const { params, query } = valid(req, s.file);
  const f = resolveSignedFile(params.name, query.exp, query.sig);
  if (!f) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(f);
}

/** Every FP request/response (the demo app's "API log"). Demo only: the buffer is shared by every user. */
export async function debugTrace(req: Request, res: Response) {
  if (!config.demoMode) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const since = valid(req, s.trace).query.since;
  res.json({ entries: trace.filter((e) => e.seq! > since).slice(-150), log_file: 'logs/fp_calls.log' });
}

/** FP order/plan events. Answers at once; the refresh calls FP and must not hold the webhook open. */
export async function fpWebhook(req: Request, res: Response) {
  if (!webhookTokenOk(String(req.params.token || ''))) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ ok: true });
  const evt = req.body;
  handleEvent(evt)
    .then((done) => log.info(`FP webhook ${evt?.type}: ${done}`, { evt: evt?.id }))
    .catch((e) => log.error(`FP webhook ${evt?.type} failed`, { evt: evt?.id, err: errMsg(e) }));
}
