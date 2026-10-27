import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { authSchemas as s } from '../validation/auth.validation.ts';
import * as auth from '../services/auth.service.ts';
import { publicUser } from '../services/user.service.ts';
import { deviceOf } from '../utils/request.ts';

export async function emailStart(req: Request, res: Response) {
  res.json(await auth.startEmail(valid(req, s.emailStart).body.email));
}

export async function emailVerify(req: Request, res: Response) {
  const { email, code } = valid(req, s.emailVerify).body;
  res.json(await auth.verifyEmail(email, code, deviceOf(req)));
}

export async function mobileStart(req: Request, res: Response) {
  res.json(await auth.startMobile(req.user, valid(req, s.mobileStart).body.mobile));
}

export async function mobileVerify(req: Request, res: Response) {
  const { mobile, code, bank_consent } = valid(req, s.mobileVerify).body;
  res.json(await auth.verifyMobile(req.user, mobile, code, bank_consent));
}

export async function pinSet(req: Request, res: Response) {
  res.json(await auth.setPin(req.user, valid(req, s.pinSet).body.pin));
}

export async function pinVerify(req: Request, res: Response) {
  await auth.checkPin(req.user, req.token, valid(req, s.pinVerify).body.pin);
  res.json({ ok: true });
}

export async function biometric(req: Request, res: Response) {
  res.json(await auth.setBiometric(req.user, valid(req, s.biometric).body.enabled));
}

export async function logout(req: Request, res: Response) {
  res.json(await auth.logout(req.token));
}

export async function me(req: Request, res: Response) {
  res.json({ user: publicUser(req.user) });
}
