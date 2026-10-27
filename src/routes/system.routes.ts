import { Router } from 'express';
import express from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { htmlPage } from '../middleware/security.ts';
import { validate } from '../middleware/validate.ts';
import { systemSchemas as s } from '../validation/system.validation.ts';
import * as c from '../controllers/system.controller.ts';

const r = Router();
r.get('/health', c.health);
r.all(['/pay/return', '/mandate/return'], htmlPage, express.urlencoded({ extended: false, limit: '20kb' }), c.returnPage);
// A missing or bad signature answers like a missing file (404), so links can't be probed.
r.get('/files/:name', (req, res, next) => (req.query.sig ? next() : res.status(404).end()), validate(s.file), c.file);
r.get('/debug/trace', requireAuth, validate(s.trace), c.debugTrace);
// FP order/plan events (no session: the URL carries the secret token)
r.post('/fp/webhook/:token', limits.webhook, c.fpWebhook);

export default r;
