import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { notificationsSchemas as n, settingsSchemas as s } from '../validation/settings.validation.ts';
import * as settings from '../services/settings.service.ts';
import * as notifications from '../services/notifications.service.ts';

export const getNotifyPrefs = async (req: Request, res: Response) => { res.json({ prefs: settings.notifyPrefs(req.user) }); };
export const putNotifyPrefs = async (req: Request, res: Response) => { res.json(await settings.updateNotifyPrefs(req.user, valid(req, s.notifyPrefs).body)); };
export const pinCheck = async (req: Request, res: Response) => { res.json(await settings.checkCurrentPin(req.user, req.token, valid(req, s.pinCheck).body.current)); };

export async function pinChange(req: Request, res: Response) {
  const { current, pin } = valid(req, s.pinChange).body;
  res.json(await settings.changePin(req.user, req.token, current, pin));
}

export const devices = async (req: Request, res: Response) => { res.json(await settings.devices(req.user, req.token)); };
export const logoutDevice = async (req: Request, res: Response) => { res.json(await settings.logoutDevice(req.user, req.token, valid(req, s.device).params.id)); };
export const logoutOthers = async (req: Request, res: Response) => { res.json(await settings.logoutOtherDevices(req.user, req.token)); };
export const deletionStatus = async (req: Request, res: Response) => { res.json(await settings.deletionStatus(req.user)); };

export async function requestDeletion(req: Request, res: Response) {
  const { reason, otp } = valid(req, s.deletion).body;
  res.json(await settings.requestDeletion(req.user, reason, otp));
}

export const listNotifications = async (req: Request, res: Response) => { res.json(await notifications.listNotifications(req.user, req.token)); };
export const markRead = async (req: Request, res: Response) => { res.json(await notifications.markRead(req.user, req.token, valid(req, n.read).body.ids)); };
export const markSeen = async (req: Request, res: Response) => { res.json(await notifications.markModalSeen(req.user, valid(req, n.seen).body.id)); };
