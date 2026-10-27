import { z } from 'zod';
import { amount, folio, fpIdParam, isin, txnOtp } from './common.ts';

/** Redemption / switch: an amount, or all=true for the whole holding. */
const needAmount = (b: { all: boolean; amount?: number }, ctx: z.RefinementCtx) => {
  if (!b.all && b.amount === undefined) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter an amount.' });
};
const sell = { all: z.boolean().optional().default(false), amount: amount.optional(), otp: txnOtp };

export const ordersSchemas = {
  lumpsum: { body: z.object({ isin, amount, otp: txnOtp }) },
  redeem: { body: z.object({ isin, folio, ...sell }).superRefine(needAmount) },
  switch: { body: z.object({ from_isin: isin, to_isin: isin, folio, ...sell }).superRefine(needAmount) },
  orderId: {
    params: fpIdParam(['mfp', 'mfr', 'mfs'], 'Order not found'),
    query: z.object({ force: z.string().optional().transform((v) => !!v) }),
  },
};
