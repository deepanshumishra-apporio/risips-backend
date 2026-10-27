import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { otpSchemas as s } from '../validation/otp.validation.ts';
import { sendTxnOtp } from '../services/otp.service.ts';

/** Sends the 2FA code for a transaction the investor is about to confirm. */
export async function txnOtp(req: Request, res: Response) {
  res.json(await sendTxnOtp(req.user, valid(req, s.txnOtp).body.action));
}
