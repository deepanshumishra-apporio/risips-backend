import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { sipSchemas as s } from '../validation/sip.validation.ts';
import * as c from '../controllers/sip.controller.ts';

const r = Router();
r.get('/mandate', requireAuth, c.getMandate);
r.post('/mandate', requireAuth, limits.money, validate(s.mandate), c.createMandate);
r.post('/sip', requireAuth, limits.money, validate(s.start), c.start);
r.get('/sips', requireAuth, c.list);
r.get('/sips/:id', requireAuth, validate(s.byId), c.get);
r.post('/sips/:id/cancel', requireAuth, limits.money, validate(s.cancel), c.cancel);
r.post('/sips/:id/pause', requireAuth, limits.money, validate(s.pause), c.pause);
r.post('/sips/:id/resume', requireAuth, limits.money, validate(s.resume), c.resume);
r.post('/sips/:id/modify', requireAuth, limits.money, validate(s.modify), c.modify);

export default r;
