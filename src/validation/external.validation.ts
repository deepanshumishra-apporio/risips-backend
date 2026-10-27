import { z } from 'zod';

const QR_MSG = 'We didn’t receive the QR code. Tap Download QR on the MF Central page, then Continue.';

export const externalSchemas = {
  start: {
    body: z.object({
      via: z.enum(['mobile', 'email']).optional().default('mobile'),
      consent: z.literal(true, { error: 'Please give your consent to fetch your holdings from MF Central.' }),
      pan: z.string().max(20).optional().transform((v) => (v ? v.trim().toUpperCase() : undefined)),
      mobile: z.union([z.string(), z.number()]).transform(String).optional(),
      email: z.string().max(254).optional(),
    }),
  },
  qr: {
    body: z.object({
      qr: z.string({ error: QR_MSG }).transform((v) => v.replace(/^data:image\/\w+;base64,/, '').trim())
        .refine((v) => v.length > 0 && v.length <= 2_000_000 && /^[A-Za-z0-9+/=_-]+$/.test(v), QR_MSG),
      req_id: z.union([z.string(), z.number()]).transform(String).optional(),
      extent: z.string().max(30).nullable().optional(),
    }),
  },
  visibility: { body: z.object({ hidden: z.boolean({ error: 'Must be true or false.' }) }) },
};

export const mfcSandboxSchemas = {
  journey: { params: z.object({ token: z.string().regex(/^[a-f0-9]{32}$/, 'Link expired') }) },
  verify: { body: z.object({ token: z.string().regex(/^[a-f0-9]{32}$/), otp: z.string().regex(/^\d{6}$/, 'Incorrect OTP. Please try again.') }) },
  generateQr: {
    body: z.object({
      token: z.string().regex(/^[a-f0-9]{32}$/),
      planType: z.enum(['BOTH', 'REGULAR', 'DIRECT']).optional(),
      extentOfData: z.enum(['SUMMARY', 'TRANSACTIONS']).optional(),
    }),
  },
};
