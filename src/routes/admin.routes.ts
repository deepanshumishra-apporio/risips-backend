// Admin API (read-only): see middleware/adminAuth.ts for the key, IP allowlist and audit log.
import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { adminSchemas as s } from '../validation/admin.validation.ts';
import * as c from '../controllers/admin.controller.ts';

const r = Router();
r.use('/admin/v1', limits.admin, adminAuth);
r.get('/admin/v1/summary', c.summary);
r.get('/admin/v1/investors', validate(s.investors), c.investors);
r.get('/admin/v1/investors/:id', validate(s.investorId), c.investor);
r.get('/admin/v1/investors/:id/portfolio', validate(s.investorId), c.portfolio);
r.get('/admin/v1/orders', validate(s.orders), c.orders);
r.get('/admin/v1/orders/:id', validate(s.orderId), c.order);

export default r;
