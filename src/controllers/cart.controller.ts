import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { cartSchemas as s } from '../validation/cart.validation.ts';
import * as cart from '../services/cart.service.ts';
import { clientIp } from '../utils/request.ts';

export const get = async (req: Request, res: Response) => { res.json(await cart.getCart(req.user)); };
export const add = async (req: Request, res: Response) => { res.json(await cart.addToCart(req.user, valid(req, s.add).body)); };

export async function update(req: Request, res: Response) {
  const { params, body } = valid(req, s.update);
  res.json(await cart.updateCartLine(req.user, params.id, body));
}

export const remove = async (req: Request, res: Response) => { res.json(await cart.removeCartLine(req.user, valid(req, s.remove).params.id)); };
export const startCheckout = async (req: Request, res: Response) => { res.json(await cart.startCheckout(req.user, valid(req, s.checkout).body)); };
export const getCheckout = async (req: Request, res: Response) => { res.json(await cart.getCheckout(req.user, valid(req, s.checkoutId).params.id)); };

export async function next(req: Request, res: Response) {
  res.json(await cart.nextCheckoutGroup({ user: req.user, ip: clientIp(req) }, valid(req, s.checkoutId).params.id));
}

export const stop = async (req: Request, res: Response) => { res.json(await cart.stopCheckout(req.user, valid(req, s.checkoutId).params.id)); };
