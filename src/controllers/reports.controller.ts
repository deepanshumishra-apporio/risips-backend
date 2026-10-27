import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { reportsSchemas as s } from '../validation/reports.validation.ts';
import { buildReport, reportHtml } from '../services/reports.service.ts';

export async function report(req: Request, res: Response) {
  const { params, query } = valid(req, s.report);
  res.json(await buildReport(req.user, params.key, query));
}

/** The same report as a printable HTML statement (the app turns it into a PDF with expo-print). */
export async function reportAsHtml(req: Request, res: Response) {
  const { params, query } = valid(req, s.report);
  res.json({ html: reportHtml(await buildReport(req.user, params.key, query)) });
}
