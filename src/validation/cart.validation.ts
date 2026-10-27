import { z } from 'zod';
import { amount, day, isin, txnOtp } from './common.ts';

const mode = z.enum(['sip', 'lumpsum'], { error: 'Choose SIP or one-time.' });
const roundedAmount = amount.transform((n) => Math.round(n)).refine((n) => n > 0, 'Enter an amount.');
const lineId = z.object({ id: z.string().regex(/^ci_[a-f0-9]{10}$/, 'This item is no longer in your cart.') });
const checkoutId = z.object({ id: z.string().regex(/^chk_[a-f0-9]{16}$/, 'Checkout not found') });

export const cartSchemas = {
  add: { body: z.object({ isin, mode, amount: roundedAmount }) },
  update: { params: lineId, body: z.object({ mode: mode.optional(), amount: roundedAmount.optional() }) },
  remove: { params: lineId },
  checkout: {
    body: z.object({
      item_ids: z.array(z.string().max(20)).max(10).optional(),
      sip_day: day.optional(),
      otp: txnOtp,
    }),
  },
  checkoutId: { params: checkoutId },
};
