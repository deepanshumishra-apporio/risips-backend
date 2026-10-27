import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { validate } from '../middleware/validate.ts';
import { assistantSchemas as s } from '../validation/assistant.validation.ts';
import * as c from '../controllers/assistant.controller.ts';

const r = Router();
r.get('/assistant', requireAuth, c.welcome);
r.post('/assistant', requireAuth, validate(s.ask), c.ask);

export default r;
