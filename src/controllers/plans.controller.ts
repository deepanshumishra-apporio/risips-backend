// STP and SWP: the two plan types that move existing units (SIP has its own controller).
import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { stpSchemas, swpSchemas } from '../validation/plans.validation.ts';
import * as stp from '../services/stp.service.ts';
import * as swp from '../services/swp.service.ts';
import { clientIp } from '../utils/request.ts';

const ctx = (req: Request) => ({ user: req.user, ip: clientIp(req) });

export const startStp = async (req: Request, res: Response) => { res.json(await stp.startStp(ctx(req), valid(req, stpSchemas.start).body)); };
export const listStps = async (req: Request, res: Response) => { res.json(await stp.listStps(req.user)); };
export const getStp = async (req: Request, res: Response) => { res.json(await stp.getStp(req.user, valid(req, stpSchemas.byId).params.id)); };
export async function cancelStp(req: Request, res: Response) {
  const { params, body } = valid(req, stpSchemas.cancel);
  res.json(await stp.cancelStp(req.user, params.id, body.otp));
}

export const swpOtp = async (req: Request, res: Response) => { res.json(await swp.sendSwpOtp(req.user)); };
export const startSwp = async (req: Request, res: Response) => { res.json(await swp.startSwp(ctx(req), valid(req, swpSchemas.start).body)); };
export const listSwps = async (req: Request, res: Response) => { res.json(await swp.listSwps(req.user)); };
export const getSwp = async (req: Request, res: Response) => { res.json(await swp.getSwp(req.user, valid(req, swpSchemas.byId).params.id)); };
export async function cancelSwp(req: Request, res: Response) {
  const { params, body } = valid(req, swpSchemas.cancel);
  res.json(await swp.cancelSwp(req.user, params.id, body.otp));
}
