import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { cartSchemas as s } from '../validation/cart.validation.ts';
import * as c from '../controllers/cart.controller.ts';

const r = Router();
r.get('/cart', requireAuth, c.get);
r.post('/cart', requireAuth, validate(s.add), c.add);
r.patch('/cart/:id', requireAuth, validate(s.update), c.update);
r.delete('/cart/:id', requireAuth, validate(s.remove), c.remove);
r.post('/checkouts', requireAuth, limits.money, validate(s.checkout), c.startCheckout);
r.get('/checkouts/:id', requireAuth, validate(s.checkoutId), c.getCheckout);
r.post('/checkouts/:id/next', requireAuth, limits.money, validate(s.checkoutId), c.next);
r.post('/checkouts/:id/stop', requireAuth, validate(s.checkoutId), c.stop);

export default r;
