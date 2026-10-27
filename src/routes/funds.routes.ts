import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { noStore } from '../middleware/security.ts';
import { validate } from '../middleware/validate.ts';
import { fundsSchemas as s } from '../validation/funds.validation.ts';
import * as c from '../controllers/funds.controller.ts';

const r = Router();
r.get('/funds', requireAuth, validate(s.list), c.list);
r.get('/funds/collections', requireAuth, c.collections);
r.get('/funds/compare/popular', requireAuth, c.popular);
r.get('/funds/compare', requireAuth, validate(s.compare), c.compare);
r.get('/funds/:isin', requireAuth, validate(s.detail), c.detail);
r.post('/watchlist/:isin', requireAuth, validate(s.watch), c.toggleWatch);
r.get('/watchlist', requireAuth, c.watchlist);
r.get('/portfolio', requireAuth, noStore, c.portfolio);

export default r;
