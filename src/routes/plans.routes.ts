import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { stpSchemas, swpSchemas } from '../validation/plans.validation.ts';
import * as c from '../controllers/plans.controller.ts';

const r = Router();
r.post('/stp', requireAuth, limits.money, validate(stpSchemas.start), c.startStp);
r.get('/stps', requireAuth, c.listStps);
r.get('/stps/:id', requireAuth, validate(stpSchemas.byId), c.getStp);
r.post('/stps/:id/cancel', requireAuth, limits.money, validate(stpSchemas.cancel), c.cancelStp);

r.post('/swp/otp', requireAuth, limits.otpSendUser, c.swpOtp);
r.post('/swp', requireAuth, limits.money, validate(swpSchemas.start), c.startSwp);
r.get('/swps', requireAuth, c.listSwps);
r.get('/swps/:id', requireAuth, validate(swpSchemas.byId), c.getSwp);
r.post('/swps/:id/cancel', requireAuth, limits.money, validate(swpSchemas.cancel), c.cancelSwp);

export default r;
