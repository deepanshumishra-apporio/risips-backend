import { z } from 'zod';
import { amount, day, fpIdParam, isin, txnOtp } from './common.ts';
import { MAX_PAUSE_MONTHS } from '../services/sip.service.ts';

const sipId = fpIdParam(['mfpp'], 'SIP not found');

export const sipSchemas = {
  mandate: {
    body: z.object({
      // anything but UPI is an eNACH mandate (older app builds send nothing)
      type: z.string().optional().transform((t): 'UPI' | 'E_MANDATE' => (t === 'UPI' ? 'UPI' : 'E_MANDATE')),
      limit: amount.optional(),
      need: amount.optional(),
    }),
  },
  start: {
    body: z.object({
      isin, amount, day,
      frequency: z.enum(['monthly'], { error: 'Only monthly SIPs are available.' }).optional().default('monthly'),
      first_now: z.boolean().optional().default(false),
      first_pay: z.enum(['upi']).optional(),
      installments: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).refine((n) => n >= 1 && n <= 1200, 'Choose between 1 and 1,200 instalments.').optional(),
      otp: txnOtp,
    }),
  },
  byId: { params: sipId },
  cancel: { params: sipId, body: z.object({ code: z.string().max(60).optional(), otp: txnOtp }) },
  pause: {
    params: sipId,
    body: z.object({
      months: z.union([z.number(), z.string().regex(/^\d+$/)], { error: `A SIP can be paused for up to ${MAX_PAUSE_MONTHS} months.` })
        .transform(Number).refine((n) => n >= 1 && n <= MAX_PAUSE_MONTHS, `A SIP can be paused for up to ${MAX_PAUSE_MONTHS} months.`),
      otp: txnOtp,
    }),
  },
  resume: { params: sipId, body: z.object({ otp: txnOtp }) },
  modify: { params: sipId, body: z.object({ amount, day, otp: txnOtp }) },
};
