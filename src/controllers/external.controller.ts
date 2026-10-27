import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { externalSchemas as s, mfcSandboxSchemas as m } from '../validation/external.validation.ts';
import * as external from '../services/external.service.ts';
import * as sandbox from '../integrations/mfcentral.sandbox.ts';
import { clientIp } from '../utils/request.ts';

export const status = async (req: Request, res: Response) => { res.json(await external.status(req.user)); };
export const start = async (req: Request, res: Response) => { res.json(await external.startImport(req.user, clientIp(req), valid(req, s.start).body)); };
export const qr = async (req: Request, res: Response) => { res.json(await external.submitQr(req.user, valid(req, s.qr).body)); };
export const cancel = async (req: Request, res: Response) => { res.json(await external.cancelImport(req.user)); };
export const visibility = async (req: Request, res: Response) => { res.json(await external.setHidden(req.user, valid(req, s.visibility).body.hidden)); };
export const remove = async (req: Request, res: Response) => { res.json(await external.removeImport(req.user)); };
export const returnPage = async (_req: Request, res: Response) => { res.type('html').send(external.RETURN_PAGE); };

// ---------- MF Central sandbox pages (demo mode only) ----------

export async function sandboxJourney(req: Request, res: Response) {
  const page = await sandbox.journeyPage(valid(req, m.journey).params.token);
  res.status(page.status).type('html').send(page.html);
}
export async function sandboxVerify(req: Request, res: Response) {
  const { token, otp } = valid(req, m.verify).body;
  res.json(await sandbox.verifyJourneyOtp(token, otp));
}
export async function sandboxGenerateQr(req: Request, res: Response) {
  const { token, planType, extentOfData } = valid(req, m.generateQr).body;
  res.json(await sandbox.generateQr(token, planType, extentOfData));
}
