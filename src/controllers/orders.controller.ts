import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { ordersSchemas as s } from '../validation/orders.validation.ts';
import * as orders from '../services/orders.service.ts';
import { clientIp } from '../utils/request.ts';

const ctx = (req: Request) => ({ user: req.user, ip: clientIp(req) });

export const lumpsum = async (req: Request, res: Response) => { res.json(await orders.lumpsum(ctx(req), valid(req, s.lumpsum).body)); };
export const redeem = async (req: Request, res: Response) => { res.json(await orders.redeem(ctx(req), valid(req, s.redeem).body)); };
export const switchFunds = async (req: Request, res: Response) => { res.json(await orders.switchFunds(ctx(req), valid(req, s.switch).body)); };
export const list = async (req: Request, res: Response) => { res.json(await orders.listOrders(req.user)); };

export async function get(req: Request, res: Response) {
  const { params, query } = valid(req, s.orderId);
  res.json(await orders.getOrder(req.user, params.id, query.force));
}
