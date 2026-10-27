import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { ordersSchemas as s } from '../validation/orders.validation.ts';
import * as c from '../controllers/orders.controller.ts';

const r = Router();
r.post('/invest/lumpsum', requireAuth, limits.money, validate(s.lumpsum), c.lumpsum);
r.post('/invest/redeem', requireAuth, limits.money, validate(s.redeem), c.redeem);
r.post('/invest/switch', requireAuth, limits.money, validate(s.switch), c.switchFunds);
r.get('/orders', requireAuth, c.list);
r.get('/orders/:id', requireAuth, validate(s.orderId), c.get);

export default r;
