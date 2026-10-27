import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { fundsSchemas as s } from '../validation/funds.validation.ts';
import * as funds from '../services/funds.service.ts';
import { portfolioWithExternal } from '../services/portfolio.service.ts';

export const list = async (req: Request, res: Response) => { res.json(await funds.listFunds(req.user, valid(req, s.list).query)); };
export const collections = async (_req: Request, res: Response) => { res.json(funds.collections()); };
export const popular = async (_req: Request, res: Response) => { res.json(funds.popularComparisons()); };
export const compare = async (req: Request, res: Response) => { res.json(funds.compare(valid(req, s.compare).query.isins)); };

export async function detail(req: Request, res: Response) {
  const { params, query } = valid(req, s.detail);
  res.json(await funds.fundDetail(req.user, params.isin, query.period));
}

export const toggleWatch = async (req: Request, res: Response) => { res.json(await funds.toggleWatchlist(req.user, valid(req, s.watch).params.isin)); };
export const watchlist = async (req: Request, res: Response) => { res.json(await funds.watchlist(req.user)); };
export const portfolio = async (req: Request, res: Response) => { res.json(await portfolioWithExternal(req.user)); };
