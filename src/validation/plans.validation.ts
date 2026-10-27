import { z } from 'zod';
import { amount, day, folio, fpIdParam, isin, txnOtp } from './common.ts';

const count = (msg: string) => z.union([z.number(), z.string().regex(/^\d+$/)], { error: msg }).transform(Number)
  .refine((n) => Number.isInteger(n) && n >= 1 && n <= 1200, msg);

export const stpSchemas = {
  start: {
    body: z.object({
      from_isin: isin, to_isin: isin, folio, amount, day,
      installments: count('Choose how many monthly transfers.'),
      otp: txnOtp,
    }),
  },
  byId: { params: fpIdParam(['mfsp'], 'STP not found') },
  cancel: { params: fpIdParam(['mfsp'], 'STP not found'), body: z.object({ otp: txnOtp }) },
};

export const swpSchemas = {
  start: {
    body: z.object({
      isin, folio, amount, day,
      until: z.literal('stopped').optional(),
      installments: count('Choose how many monthly withdrawals.').optional(),
      start_offset: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).optional().default(0)
        .refine((n) => Number.isInteger(n) && n >= 0 && n <= 2, 'The first withdrawal can start at most 2 months later.'),
      otp: txnOtp,
    }).superRefine((b, ctx) => {
      if (b.until !== 'stopped' && b.installments === undefined) ctx.addIssue({ code: 'custom', path: ['installments'], message: 'Choose how many monthly withdrawals.' });
    }),
  },
  byId: { params: fpIdParam(['mfrp'], 'SWP not found') },
  cancel: { params: fpIdParam(['mfrp'], 'SWP not found'), body: z.object({ otp: txnOtp }) },
};
