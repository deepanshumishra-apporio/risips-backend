import { Router } from 'express';
import { config } from '../config/env.ts';
import { requireAuth } from '../middleware/auth.ts';
import { imageJson } from '../middleware/bodyParser.ts';
import { limits } from '../middleware/rateLimit.ts';
import { htmlPage, noStore } from '../middleware/security.ts';
import { validate } from '../middleware/validate.ts';
import { externalSchemas as s, mfcSandboxSchemas as m } from '../validation/external.validation.ts';
import * as c from '../controllers/external.controller.ts';

const r = Router();
r.get('/external', requireAuth, noStore, c.status);
r.post('/external/start', requireAuth, limits.otpSendUser, validate(s.start), c.start);
r.post('/external/qr', requireAuth, imageJson, validate(s.qr), c.qr);
r.post('/external/cancel', requireAuth, c.cancel);
r.post('/external/visibility', requireAuth, validate(s.visibility), c.visibility);
r.delete('/external', requireAuth, c.remove);
r.get('/external/return', htmlPage, c.returnPage);

// The local MF Central stand-in (external.service.ts only sends investors here in demo mode).
if (config.demoMode) {
  r.get('/mfc-sandbox/journey/:token', htmlPage, validate(m.journey), c.sandboxJourney);
  r.post('/mfc-sandbox/api/verify', limits.otpVerify, validate(m.verify), c.sandboxVerify);
  r.post('/mfc-sandbox/api/generate-qr', validate(m.generateQr), c.sandboxGenerateQr);
}

export default r;
