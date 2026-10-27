import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { noStore } from '../middleware/security.ts';
import { validate } from '../middleware/validate.ts';
import { reportsSchemas as s } from '../validation/reports.validation.ts';
import * as c from '../controllers/reports.controller.ts';

const r = Router();
r.get('/reports/:key', requireAuth, noStore, validate(s.report), c.report);
r.get('/reports/:key/html', requireAuth, noStore, validate(s.report), c.reportAsHtml);

export default r;
