import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { adminSchemas as s } from '../validation/admin.validation.ts';
import * as admin from '../services/admin.service.ts';

export const summary = async (_req: Request, res: Response) => { res.json(await admin.summary()); };
export const investors = async (req: Request, res: Response) => { res.json(await admin.investors(valid(req, s.investors).query)); };
export const investor = async (req: Request, res: Response) => { res.json(await admin.investor(valid(req, s.investorId).params.id)); };
export const portfolio = async (req: Request, res: Response) => { res.json(await admin.investorPortfolio(valid(req, s.investorId).params.id)); };
export const orders = async (req: Request, res: Response) => { res.json(await admin.orders(valid(req, s.orders).query)); };
export const order = async (req: Request, res: Response) => { res.json(await admin.order(valid(req, s.orderId).params.id)); };
