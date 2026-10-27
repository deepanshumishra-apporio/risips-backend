import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { sipSchemas as s } from '../validation/sip.validation.ts';
import * as mandates from '../services/mandate.service.ts';
import * as sips from '../services/sip.service.ts';
import { clientIp } from '../utils/request.ts';

const ctx = (req: Request) => ({ user: req.user, ip: clientIp(req) });

export const getMandate = async (req: Request, res: Response) => { res.json(await mandates.getMandate(req.user)); };
export const createMandate = async (req: Request, res: Response) => { res.json(await mandates.createMandate(req.user, valid(req, s.mandate).body)); };

export const start = async (req: Request, res: Response) => { res.json(await sips.startSip(ctx(req), valid(req, s.start).body)); };
export const list = async (req: Request, res: Response) => { res.json(await sips.listSips(req.user)); };
export const get = async (req: Request, res: Response) => { res.json(await sips.getSip(req.user, valid(req, s.byId).params.id)); };

export async function cancel(req: Request, res: Response) {
  const { params, body } = valid(req, s.cancel);
  res.json(await sips.cancelSip(req.user, params.id, body.code, body.otp));
}
export async function pause(req: Request, res: Response) {
  const { params, body } = valid(req, s.pause);
  res.json(await sips.pauseSip(req.user, params.id, body.months, body.otp));
}
export async function resume(req: Request, res: Response) {
  const { params, body } = valid(req, s.resume);
  res.json(await sips.resumeSip(req.user, params.id, body.otp));
}
export async function modify(req: Request, res: Response) {
  const { params, body } = valid(req, s.modify);
  res.json(await sips.modifySip(ctx(req), params.id, body));
}
