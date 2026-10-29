import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { imageJson } from '../middleware/bodyParser.ts';
import { limits } from '../middleware/rateLimit.ts';
import { noStore } from '../middleware/security.ts';
import { validate } from '../middleware/validate.ts';
import { onboardingSchemas as s } from '../validation/onboarding.validation.ts';
import { assertStillOnboarding } from '../services/onboarding.service.ts';
import * as c from '../controllers/onboarding.controller.ts';

const r = Router();
r.use('/onb', requireAuth, noStore);
// Once the FP investor exists, onboarding answers can't change (eSign stays callable: it is idempotent).
r.use('/onb', (req: Request, _res: Response, next: NextFunction) => {
  if (req.method === 'POST' && req.path !== '/esign') assertStillOnboarding(req.user);
  next();
});
r.post('/onb/pan', limits.kycCheck, validate(s.pan), c.verifyPan);
r.post('/onb/pan/confirm', c.confirmPan);
r.post('/onb/pan/reset', c.resetPan);
r.post('/onb/profile', validate(s.profile), c.updateProfile);
r.get('/onb/pincode/:pin', validate(s.pincode), c.pincode);
r.post('/onb/address', validate(s.address), c.address);
r.post('/onb/aadhaar/start', limits.otpSendUser, validate(s.aadhaarStart), c.aadhaarStart);
r.post('/onb/aadhaar/verify', limits.otpVerifyUser, validate(s.aadhaarVerify), c.aadhaarVerify);
r.get('/onb/ifsc/:ifsc', validate(s.ifsc), c.ifsc);
r.post('/onb/bank', limits.kycCheck, validate(s.bank), c.bank);
r.post('/onb/selfie', imageJson, validate(s.image), c.selfie);
r.post('/onb/signature', imageJson, validate(s.image), c.signature);
r.post('/onb/declarations', validate(s.declarations), c.declarations);
r.post('/onb/nominee', validate(s.nominee), c.nominee);
r.get('/onb/kyc-form', c.kycForm);
r.post('/onb/esign', validate(s.esign), c.esign);

export default r;
