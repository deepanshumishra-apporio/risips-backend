import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { authSchemas as s } from '../validation/auth.validation.ts';
import * as c from '../controllers/auth.controller.ts';

const r = Router();

r.post('/auth/email/start', limits.otpSendIp, limits.otpSendEmail, validate(s.emailStart), c.emailStart);
r.post('/auth/email/verify', limits.otpVerify, validate(s.emailVerify), c.emailVerify);
r.post('/auth/mobile/start', requireAuth, limits.otpSendUser, validate(s.mobileStart), c.mobileStart);
r.post('/auth/mobile/verify', requireAuth, limits.otpVerify, validate(s.mobileVerify), c.mobileVerify);
r.post('/auth/pin/set', requireAuth, limits.pin, validate(s.pinSet), c.pinSet);
r.post('/auth/pin/verify', requireAuth, limits.pin, validate(s.pinVerify), c.pinVerify);
r.post('/auth/biometric', requireAuth, validate(s.biometric), c.biometric);
r.post('/auth/logout', requireAuth, c.logout);
r.get('/me', requireAuth, c.me);

export default r;
