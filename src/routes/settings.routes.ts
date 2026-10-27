import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { limits } from '../middleware/rateLimit.ts';
import { validate } from '../middleware/validate.ts';
import { notificationsSchemas as n, settingsSchemas as s } from '../validation/settings.validation.ts';
import * as c from '../controllers/settings.controller.ts';

const r = Router();
r.get('/settings/notifications', requireAuth, c.getNotifyPrefs);
r.put('/settings/notifications', requireAuth, validate(s.notifyPrefs), c.putNotifyPrefs);
r.post('/settings/pin/check', requireAuth, limits.pin, validate(s.pinCheck), c.pinCheck);
r.post('/settings/pin/change', requireAuth, limits.pin, validate(s.pinChange), c.pinChange);
r.get('/settings/devices', requireAuth, c.devices);
r.post('/settings/devices/logout-others', requireAuth, c.logoutOthers);
r.post('/settings/devices/:id/logout', requireAuth, validate(s.device), c.logoutDevice);
r.get('/settings/deletion', requireAuth, c.deletionStatus);
r.post('/settings/deletion', requireAuth, limits.money, validate(s.deletion), c.requestDeletion);

r.get('/notifications', requireAuth, c.listNotifications);
r.post('/notifications/read', requireAuth, validate(n.read), c.markRead);
r.post('/notifications/seen', requireAuth, validate(n.seen), c.markSeen);

export default r;
