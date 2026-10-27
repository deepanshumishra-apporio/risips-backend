import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { otpSchemas as s } from '../validation/otp.validation.ts';
import * as c from '../controllers/otp.controller.ts';

const r = Router();
r.post('/txn/otp', requireAuth, limits.otpSendUser, validate(s.txnOtp), c.txnOtp);

export default r;
